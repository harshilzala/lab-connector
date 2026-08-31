import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { ACK, ENQ, EOT, ETB, ETX, LF, NAK, STX, ctrlName } from './control.js';
import { frame, verifyChecksum } from './checksum.js';
import { DEFAULT_DELIMS, buildOrderMessage, parseMessage, type AstmDialect } from './records.js';

export interface AstmLinkOptions {
  senderId: string;
  receiverId: string;
  ackTimeoutMs: number;
  frameMaxData: number;
  /** Order-download shape for this vendor — see ORDER_FORMATS in records.ts. */
  dialect: AstmDialect;
  logger: Logger;
}

class ContentionError extends Error {}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// =============================================================================
// AstmLink — full-duplex-safe implementation of the ASTM E1381 line protocol
// over a byte transport. Receives analyzer transmissions (ENQ → frames → EOT),
// ACK/NAKs each frame, reassembles records, and emits a parsed 'message'. Can
// also act as the sender to push an order download back to the analyzer.
//
// Half-duplex: at most one side transmits at a time. `sending` gates whether
// inbound bytes are routed to the sender's control-byte waiter or the receiver
// frame parser. Establishment contention (both ENQ) is resolved by the host
// yielding to the analyzer.
// =============================================================================
export class AstmLink extends EventEmitter implements ProtocolLink {
  readonly name = 'astm' as const;

  private rx = Buffer.alloc(0);
  private mode: 'idle' | 'receiving' = 'idle';
  private sending = false;
  private controlResolver: (() => void) | null = null;

  // Receive-session accumulators.
  private rxRecords: string[] = [];
  private partialRecord = '';
  private expectedFrameNo = 1;

  private txQueue: Promise<unknown> = Promise.resolve();
  private readonly onDataBound = (c: Buffer) => this.onData(c);

  constructor(private readonly transport: Transport, private readonly opts: AstmLinkOptions) {
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

  sendOrders(orders: OrderDownload[]): Promise<void> {
    const records = buildOrderMessage(
      orders,
      {
        senderId: this.opts.senderId,
        receiverId: this.opts.receiverId,
        sendDemographics: orders.some((o) => !!o.patient),
        dialect: this.opts.dialect,
      },
      DEFAULT_DELIMS,
    );
    // Serialise transmits so two order-downloads never interleave on the wire.
    const run = () => this.transmit(records);
    const p = this.txQueue.then(run, run);
    this.txQueue = p.catch(() => {});
    return p;
  }

  // ---- inbound byte routing -------------------------------------------------
  private onData(chunk: Buffer): void {
    this.rx = Buffer.concat([this.rx, chunk]);
    if (this.controlResolver) {
      this.controlResolver();
      return;
    }
    if (!this.sending) this.consumeReceive();
  }

  private writeByte(b: number): void {
    this.transport.write(Buffer.from([b])).catch((e) => this.emit('error', e));
  }

  // ---- receiver -------------------------------------------------------------
  private consumeReceive(): void {
    let progressed = true;
    while (progressed && this.rx.length > 0) {
      progressed = false;
      const b = this.rx[0]!;

      if (b === ENQ) {
        if (this.mode !== 'receiving') {
          this.mode = 'receiving';
          this.rxRecords = [];
          this.partialRecord = '';
          this.expectedFrameNo = 1;
        }
        this.rx = this.rx.subarray(1);
        this.writeByte(ACK);
        progressed = true;
        continue;
      }

      if (b === EOT) {
        this.rx = this.rx.subarray(1);
        if (this.mode === 'receiving') this.finalizeReceive();
        progressed = true;
        continue;
      }

      if (b === STX) {
        const lf = this.rx.indexOf(LF);
        if (lf === -1) break; // frame not fully arrived yet
        const frameBytes = this.rx.subarray(0, lf + 1);
        this.rx = this.rx.subarray(lf + 1);
        this.handleFrame(frameBytes);
        progressed = true;
        continue;
      }

      // Stray byte between frames (e.g. a lone CR/LF) — discard.
      this.rx = this.rx.subarray(1);
      progressed = true;
    }
  }

  private handleFrame(frameBytes: Buffer): void {
    // Layout: STX FN <text> CR (ETB|ETX) C1 C2 CR LF
    const len = frameBytes.length;
    if (len < 7) {
      this.writeByte(NAK);
      return;
    }
    const terminator = frameBytes[len - 5]!;
    const cs = frameBytes.subarray(len - 4, len - 2).toString('latin1');
    const body = frameBytes.subarray(1, len - 4); // FN .. terminator (inclusive)
    if (!verifyChecksum(body, cs)) {
      this.opts.logger.warn({ frame: frameBytes.toString('latin1') }, 'ASTM frame checksum mismatch → NAK');
      this.writeByte(NAK);
      return;
    }
    const fn = frameBytes[1]! - 0x30; // '0'..'7' → 0..7
    const text = frameBytes.subarray(2, len - 5).toString('latin1');
    const expected = this.expectedFrameNo % 8;
    const previous = (this.expectedFrameNo - 1 + 8) % 8;

    if (fn === expected) {
      this.partialRecord += text;
      if (terminator === ETX) {
        this.rxRecords.push(this.partialRecord.replace(/\r$/, ''));
        this.partialRecord = '';
      }
      this.expectedFrameNo = (this.expectedFrameNo + 1) % 8;
      this.writeByte(ACK);
    } else if (fn === previous) {
      // Duplicate retransmit of the last accepted frame → ACK, ignore.
      this.writeByte(ACK);
    } else {
      this.opts.logger.warn({ fn, expected }, 'ASTM frame number out of sequence → NAK');
      this.writeByte(NAK);
    }
  }

  private finalizeReceive(): void {
    const records = this.rxRecords.slice();
    this.mode = 'idle';
    this.rxRecords = [];
    this.partialRecord = '';
    this.expectedFrameNo = 1;
    if (records.length === 0) return;
    const raw = records.join('\r\n');
    this.emit('wire', { direction: 'IN', text: raw });
    try {
      const msg = parseMessage(records, raw, this.opts.dialect);
      this.emit('message', msg);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---- sender ---------------------------------------------------------------
  private waitControl(timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const take = (): boolean => {
        if (this.rx.length > 0) {
          const b = this.rx[0]!;
          this.rx = this.rx.subarray(1);
          clearTimeout(timer);
          this.controlResolver = null;
          resolve(b);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        this.controlResolver = null;
        reject(new Error('ASTM control-byte timeout'));
      }, timeoutMs);
      this.controlResolver = () => { take(); };
      take(); // in case a byte is already buffered
    });
  }

  private async acquireLine(): Promise<void> {
    // Wait out any in-progress inbound transmission before we grab the line.
    let waited = 0;
    while (this.mode === 'receiving' && waited < 30_000) {
      await delay(50);
      waited += 50;
    }
  }

  private chunkRecord(record: string): string[] {
    const data = record + '\r'; // the record's CR terminator rides inside the frame
    const max = this.opts.frameMaxData;
    if (data.length <= max) return [data];
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += max) chunks.push(data.slice(i, i + max));
    return chunks;
  }

  private async transmit(records: string[]): Promise<void> {
    this.emit('wire', { direction: 'OUT', text: records.join('\r\n') });
    for (let bigAttempt = 0; bigAttempt < 3; bigAttempt++) {
      await this.acquireLine();
      this.sending = true;
      try {
        await this.doTransmit(records);
        this.sending = false;
        return;
      } catch (err) {
        this.sending = false;
        if (err instanceof ContentionError) {
          // Yield to the analyzer: re-inject the ENQ and let the receiver run.
          this.rx = Buffer.concat([Buffer.from([ENQ]), this.rx]);
          this.consumeReceive();
          await delay(500);
          continue;
        }
        throw err;
      }
    }
    throw new Error('ASTM transmit failed after contention retries');
  }

  private async doTransmit(records: string[]): Promise<void> {
    // Establishment.
    let established = false;
    for (let attempt = 0; attempt < 3 && !established; attempt++) {
      this.writeByte(ENQ);
      const c = await this.waitControl(this.opts.ackTimeoutMs);
      if (c === ACK) established = true;
      else if (c === ENQ) throw new ContentionError();
      else {
        this.opts.logger.warn({ got: ctrlName(c) }, 'ENQ not acknowledged, retrying');
        await delay(1000);
      }
    }
    if (!established) throw new Error('Analyzer did not ACK ENQ (not ready)');

    // Transfer.
    let frameNo = 1;
    for (const record of records) {
      const chunks = this.chunkRecord(record);
      for (let i = 0; i < chunks.length; i++) {
        const term = i === chunks.length - 1 ? ETX : ETB;
        let ok = false;
        for (let retry = 0; retry < 6 && !ok; retry++) {
          await this.transport.write(frame(frameNo, chunks[i]!, term));
          const c = await this.waitControl(this.opts.ackTimeoutMs);
          if (c === ACK) ok = true;
          else if (c === NAK) continue; // resend same frame
          else if (c === EOT) throw new Error('Analyzer interrupted transfer (EOT)');
          else throw new Error(`Unexpected control byte ${ctrlName(c)} during transfer`);
        }
        if (!ok) throw new Error('Frame rejected after 6 retransmits');
        frameNo = (frameNo + 1) % 8;
      }
    }

    // Termination.
    this.writeByte(EOT);
  }
}
