import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload, ParsedMessage } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { ACK, ETX, STX, parseRollerFrame, rollerQueryReply, toInstrumentResult } from './parser.js';

export interface RollerLinkOptions {
  logger: Logger;
  /** Drop a frame whose XOR checksum does not match. */
  verifyChecksum: boolean;
  /** Send ACK (0x06) after each R message. Ignored by the analyzer when its
   *  ACK option is 0, so it is safe to leave on. */
  ack: boolean;
  /** Answer a 'Q' query with T "0001" (run the tube). Off: no reply — the
   *  analyzer waits its timeout, then runs the tube anyway. */
  answerQueries: boolean;
  /** File an ESR flagged "*" (very low haematocrit). Off: logged, not filed. */
  fileLowHematocrit: boolean;
  /** When the Roller sends a short numeric sample id (1–6 digits) instead of
   *  the tube barcode, file it as <prefix><YYMMDD of the run><id> — the rule
   *  the legacy Middleware.exe used at Ahmedabad ("0354" on 2026-10-29 →
   *  "HE2610290354", 4 417 of 4 417 results Jun–Oct 2026). Null: file the id
   *  exactly as sent. A full barcode and latex QC ids are never rewritten. */
  shortIdPrefix?: string | null;
  maxBufferBytes?: number;
  /** Clock for the run date; tests only. */
  now?: () => Date;
}

// =============================================================================
// RollerLink — Alifax ROLLER 20LC ESR analyzer, results-only.
//
// RS-232 on the analyzer (port 2, 9600 8-N-1), reached here through a Moxa
// NPort the connector dials. One STX…ETX frame per tube; see parser.ts for
// the layouts. sendOrders is a no-op: the ROLLER takes no worklist — with
// query (BCI) on it only asks "run this tube?", which is answered "yes".
// =============================================================================
export class RollerLink extends EventEmitter implements ProtocolLink {
  readonly name = 'alifax-roller' as const;

  private rx = Buffer.alloc(0);
  private readonly maxBuffer: number;
  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => {
    this.rx = Buffer.alloc(0);
  };

  constructor(private readonly transport: Transport, private readonly opts: RollerLinkOptions) {
    super();
    this.maxBuffer = opts.maxBufferBytes ?? 64 * 1024;
  }

  async start(): Promise<void> {
    this.transport.on('data', this.onDataBound);
    this.transport.on('close', this.onCloseBound);
    this.transport.on('error', (e: Error) => this.emit('error', e));
    await this.transport.start();
  }

  async stop(): Promise<void> {
    this.transport.off('data', this.onDataBound);
    this.transport.off('close', this.onCloseBound);
    await this.transport.stop();
  }

  async sendOrders(orders: OrderDownload[]): Promise<void> {
    if (orders.length > 0) {
      this.opts.logger.warn({ count: orders.length }, 'ROLLER order-download not supported (results-only interface) — ignoring');
    }
  }

  private onData(chunk: Buffer): void {
    this.emit('wire', { direction: 'IN', text: printable(chunk) });
    this.rx = Buffer.concat([this.rx, chunk]);

    for (;;) {
      const start = this.rx.indexOf(STX);
      if (start === -1) {
        this.rx = Buffer.alloc(0);
        return;
      }
      if (start > 0) this.rx = this.rx.subarray(start);
      const end = this.rx.indexOf(ETX, 1);
      if (end === -1) break;
      const inner = this.rx.subarray(1, end).toString('latin1');
      this.rx = this.rx.subarray(end + 1);
      void this.handleFrame(inner);
    }

    if (this.rx.length > this.maxBuffer) {
      this.rx = Buffer.alloc(0);
      this.emit('error', new Error(`ROLLER: no ETX within ${this.maxBuffer} bytes — buffer reset`));
    }
  }

  private async handleFrame(inner: string): Promise<void> {
    const { message, checksumOk, reason } = parseRollerFrame(inner);
    const log = this.opts.logger;

    if (!message) {
      log.warn({ reason, frame: printable(Buffer.from(inner, 'latin1')) }, 'unreadable ROLLER frame — dropped');
      return;
    }
    if (!checksumOk && this.opts.verifyChecksum) {
      log.warn({ sample: message.sampleId, kind: message.kind }, 'ROLLER frame checksum mismatch — dropped');
      return;
    }

    if (message.kind === 'query') {
      log.info({ sample: message.sampleId }, 'ROLLER query');
      if (this.opts.answerQueries) await this.send(rollerQueryReply(message.workstation, message.sampleId, true));
      return;
    }

    if (this.opts.ack) await this.send(Buffer.from([ACK]));

    log.info(
      {
        sample: message.sampleId,
        esr: message.rawResult,
        outcome: message.outcome,
        rack: message.rack,
        position: message.position,
        qc: message.isQc,
        format: message.format,
      },
      'ROLLER result parsed',
    );

    if (message.outcome === 'error') {
      log.warn({ sample: message.sampleId, code: message.rawResult }, 'ROLLER reported an error for this tube — no result filed');
      return;
    }
    if (message.outcome === 'low-hematocrit' && !this.opts.fileLowHematocrit) {
      log.warn({ sample: message.sampleId, esr: message.rawResult }, 'ROLLER ESR flagged low haematocrit (*) — not filed; enter manually');
      return;
    }
    if (!message.sampleId) {
      log.warn('ROLLER result carried an empty sample id — cannot be filed');
      return;
    }

    const prefix = this.opts.shortIdPrefix;
    if (prefix && !message.isQc && /^\d{1,6}$/.test(message.sampleId)) {
      const d = this.opts.now?.() ?? new Date();
      const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      const barcode = `${prefix}${ymd}${message.sampleId}`;
      log.info({ rollerId: message.sampleId, barcode }, 'ROLLER short id mapped to barcode (prefix + run date + id)');
      message.sampleId = barcode;
    }

    const msg: ParsedMessage = {
      protocol: 'alifax-roller',
      sender: 'ROLLER20LC',
      patient: null,
      queries: [],
      results: [toInstrumentResult(message)],
      isQc: message.isQc,
      raw: inner,
    };
    this.emit('message', msg);
  }

  private async send(b: Buffer): Promise<void> {
    try {
      await this.transport.write(b);
      this.emit('wire', { direction: 'OUT', text: printable(b) });
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, 'ROLLER reply not sent');
    }
  }
}

const NAMED: Record<string, string> = { '\x02': '<STX>', '\x03': '<ETX>\n', '\x06': '<ACK>\n', '\x15': '<NAK>\n' };

function printable(b: Buffer): string {
  return b
    .toString('latin1')
    .replace(/[\x00-\x1f\x7f]/g, (c) => NAMED[c] ?? `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}
