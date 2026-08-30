import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload, ParsedMessage } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { ACK, ENQ, EOT, ETB, ETX, LF, STX } from '../astm/control.js';
import { verifyChecksum } from '../astm/checksum.js';
import { parseClinitekMessage } from './parser.js';

export interface ClinitekLinkOptions {
  logger: Logger;
}

// =============================================================================
// ClinitekAdvantusLink — protocol link for the Siemens CLINITEK Advantus urine
// analyzer.
//
// The Advantus speaks standard ASTM E1381 over serial. This is a receive-only
// implementation transcribed from the production caretech middleware
// (CLINITEK_ADVANTUS.cs, method InitiateComm): the analyzer establishes with
// ENQ, streams STX-framed blocks (each: STX, 1-char frame number, record text,
// CR, ETB|ETX, 2-char checksum, CR, LF), and releases the line with EOT. We ACK
// the ENQ and every block, reassemble the CR-delimited H/P/O/R/L records, and
// emit one parsed 'message' per transmission at EOT.
//
// Faithful to the reference, we ACK every block rather than NAKing on a bad
// checksum — the instrument is a one-way results talker and the legacy driver
// never validated the checksum. We DO verify it and log a warning on mismatch
// so a genuine wiring/format problem is visible, but never reject the frame.
//
// sendOrders is a no-op: the Advantus interface is results-only (keep
// hostQuery:false in config).
// =============================================================================
export class ClinitekAdvantusLink extends EventEmitter implements ProtocolLink {
  readonly name = 'clinitek-advantus' as const;

  private rx = Buffer.alloc(0);
  private mode: 'idle' | 'receiving' = 'idle';

  // Receive-session accumulators.
  private records: string[] = [];
  private partialRecord = ''; // record text carried across ETB (continued) frames

  private readonly onDataBound = (c: Buffer) => this.onData(c);

  constructor(private readonly transport: Transport, private readonly opts: ClinitekLinkOptions) {
    super();
  }

  async start(): Promise<void> {
    this.transport.on('data', this.onDataBound);
    this.transport.on('error', (e: Error) => this.emit('error', e));
    await this.transport.start();
  }

  async stop(): Promise<void> {
    this.transport.off('data', this.onDataBound);
    await this.transport.stop();
  }

  // Unidirectional results interface: the Advantus does not take downloads here.
  async sendOrders(orders: OrderDownload[]): Promise<void> {
    if (orders.length > 0) {
      this.opts.logger.warn(
        { count: orders.length },
        'CLINITEK Advantus order-download not supported (results-only interface) — ignoring',
      );
    }
  }

  // ---- inbound byte routing -------------------------------------------------
  private onData(chunk: Buffer): void {
    this.emit('wire', { direction: 'IN', text: chunk.toString('latin1') });
    this.rx = Buffer.concat([this.rx, chunk]);
    this.consume();
  }

  private writeByte(b: number): void {
    this.transport.write(Buffer.from([b])).catch((e) => this.emit('error', e));
  }

  private consume(): void {
    let progressed = true;
    while (progressed && this.rx.length > 0) {
      progressed = false;
      const b = this.rx[0]!;

      if (b === ENQ) {
        // Establishment: reset the session and acknowledge. (InitiateComm ENQ case)
        this.mode = 'receiving';
        this.records = [];
        this.partialRecord = '';
        this.rx = this.rx.subarray(1);
        this.writeByte(ACK);
        progressed = true;
        continue;
      }

      if (b === EOT) {
        // End of transmission — release the line and emit the message.
        this.rx = this.rx.subarray(1);
        if (this.mode === 'receiving') this.finalizeReceive();
        progressed = true;
        continue;
      }

      if (b === STX) {
        // A block runs STX .. LF. Wait until the whole line has arrived.
        const lf = this.rx.indexOf(LF);
        if (lf === -1) break;
        const frameBytes = this.rx.subarray(0, lf + 1);
        this.rx = this.rx.subarray(lf + 1);
        this.handleFrame(frameBytes);
        progressed = true;
        continue;
      }

      // Stray byte between frames (a lone CR/LF, or noise before ENQ) — discard.
      this.rx = this.rx.subarray(1);
      progressed = true;
    }
  }

  // Layout: STX  FN  <record text>\r  (ETB|ETX)  C1 C2  CR LF
  private handleFrame(frameBytes: Buffer): void {
    // Locate the ETB/ETX terminator (record data never contains a control byte).
    let ti = -1;
    let term = 0;
    for (let i = 1; i < frameBytes.length; i++) {
      const c = frameBytes[i]!;
      if (c === ETB || c === ETX) {
        ti = i;
        term = c;
        break;
      }
    }
    if (ti === -1) {
      this.opts.logger.warn({ frame: preview(frameBytes) }, 'CLINITEK frame without ETB/ETX terminator — ignoring');
      return;
    }

    // Verify (but never reject on) the checksum — see class header.
    const cs = frameBytes.subarray(ti + 1, ti + 3).toString('latin1');
    if (/^[0-9A-Fa-f]{2}$/.test(cs)) {
      const body = frameBytes.subarray(1, ti + 1); // FN .. terminator (inclusive)
      if (!verifyChecksum(body, cs)) {
        this.opts.logger.warn({ frame: preview(frameBytes) }, 'CLINITEK frame checksum mismatch (accepting anyway)');
      }
    }

    // Strip the leading frame-number char; keep the record text (incl. its CR).
    const text = frameBytes.subarray(2, ti).toString('latin1');
    this.partialRecord += text;

    if (term === ETX) {
      // A completed record (occasionally more than one, CR-delimited) landed.
      for (const rec of this.partialRecord.split('\r')) {
        const line = rec.trim();
        if (line) this.records.push(line);
      }
      this.partialRecord = '';
    }

    // ACK every block, matching the reference driver.
    this.writeByte(ACK);
  }

  private finalizeReceive(): void {
    const records = this.records.slice();
    this.mode = 'idle';
    this.records = [];
    this.partialRecord = '';
    if (records.length === 0) return;

    const raw = records.join('\r\n');
    try {
      const parsed = parseClinitekMessage(records);
      if (parsed.results.length === 0) {
        this.opts.logger.warn(
          { preview: raw.replace(/[\x00-\x1f]/g, '.').slice(0, 160) },
          'CLINITEK transmission had no R (result) records — check wire log against parser',
        );
        return;
      }
      if (!parsed.sampleId) {
        this.opts.logger.warn('CLINITEK results parsed but no sample id (no O/P record) — upload may be skipped downstream');
      }
      const msg: ParsedMessage = {
        protocol: 'clinitek-advantus',
        sender: 'CLINITEK-ADVANTUS',
        patient: null,
        queries: [],
        results: parsed.results,
        raw,
      };
      this.emit('message', msg);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function preview(buf: Buffer): string {
  return buf.toString('latin1').replace(/[\x00-\x1f]/g, '.');
}
