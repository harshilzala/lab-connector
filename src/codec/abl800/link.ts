import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { VT, FS, CR } from '../hl7/mllp.js';
import { EOT, SOH, abl800Ack, parseAbl800 } from './parser.js';

export interface Abl800LinkOptions {
  logger: Logger;
  /** How the ACK is framed. "mllp" (VT … FS CR) is what the legacy interface
   *  sent; "soh-eot" mirrors the analyzer's own envelope; "none" sends no ACK. */
  ackFraming: 'mllp' | 'soh-eot' | 'none';
  maxBufferBytes?: number;
}

// =============================================================================
// Abl800Link — Radiometer ABL800 FLEX, results-only, the analyzer dials in.
//
// Frames on SOH … EOT (the analyzer's envelope) and also on VT … FS should it
// be switched to standard MLLP. Each frame is one ORU^R31; see parser.ts.
//
// The legacy interface answered with an MLLP ACK carrying an EMPTY MSA-2 and
// "ACK^R01", and the analyzer resent most messages 3–4 times (12 171 messages
// for 3 537 message ids). This link echoes the control id and trigger, which
// is what an HL7 sender matches an acknowledgement on. A resend that still
// arrives is harmless: the result files once against its pending rows.
// =============================================================================
export class Abl800Link extends EventEmitter implements ProtocolLink {
  readonly name = 'abl800' as const;

  private rx = Buffer.alloc(0);
  private readonly maxBuffer: number;
  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => {
    this.rx = Buffer.alloc(0);
  };

  constructor(private readonly transport: Transport, private readonly opts: Abl800LinkOptions) {
    super();
    this.maxBuffer = opts.maxBufferBytes ?? 1024 * 1024;
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
      this.opts.logger.warn({ count: orders.length }, 'ABL800 order-download not supported (results-only interface) — ignoring');
    }
  }

  private onData(chunk: Buffer): void {
    this.emit('wire', { direction: 'IN', text: printable(chunk) });
    this.rx = Buffer.concat([this.rx, chunk]);

    for (;;) {
      const soh = this.rx.indexOf(SOH);
      const vt = this.rx.indexOf(VT);
      const start = soh === -1 ? vt : vt === -1 ? soh : Math.min(soh, vt);
      if (start === -1) {
        this.rx = Buffer.alloc(0);
        return;
      }
      if (start > 0) this.rx = this.rx.subarray(start);
      const endByte = this.rx[0] === SOH ? EOT : FS;
      const end = this.rx.indexOf(endByte, 1);
      if (end === -1) break;
      const text = this.rx.subarray(1, end).toString('latin1');
      this.rx = this.rx.subarray(end + 1);
      void this.handle(text, endByte === EOT ? 'soh-eot' : 'mllp');
    }

    if (this.rx.length > this.maxBuffer) {
      this.rx = Buffer.alloc(0);
      this.emit('error', new Error(`ABL800: no end of message within ${this.maxBuffer} bytes — buffer reset`));
    }
  }

  private async handle(text: string, arrived: 'soh-eot' | 'mllp'): Promise<void> {
    const body = text.replace(/^[\r\n]+/, '');
    if (!body.startsWith('MSH')) {
      this.opts.logger.warn({ head: body.slice(0, 40) }, 'ABL800 frame without MSH — dropped');
      return;
    }
    let parsed;
    try {
      parsed = parseAbl800(body);
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, 'unparseable ABL800 message');
      return;
    }
    await this.ack(parsed.hl7, arrived);

    this.opts.logger.info(
      {
        sample: parsed.barcode || null,
        controlId: parsed.hl7.controlId,
        values: parsed.message?.results.length ?? 0,
        noValue: parsed.skipped.length ? parsed.skipped : undefined,
      },
      'ABL800 result message parsed',
    );
    if (!parsed.barcode) {
      this.opts.logger.warn({ controlId: parsed.hl7.controlId }, 'ABL800 message carried no sample id (PID-3) — cannot be filed');
      return;
    }
    if (parsed.message) this.emit('message', parsed.message);
  }

  private async ack(hl7: Parameters<typeof abl800Ack>[0], arrived: 'soh-eot' | 'mllp'): Promise<void> {
    if (this.opts.ackFraming === 'none') return;
    const text = abl800Ack(hl7);
    const framing = this.opts.ackFraming;
    const frame =
      framing === 'soh-eot'
        ? Buffer.concat([Buffer.from([SOH]), Buffer.from(text, 'latin1'), Buffer.from([EOT])])
        : Buffer.concat([Buffer.from([VT]), Buffer.from(text, 'latin1'), Buffer.from([FS, CR])]);
    try {
      await this.transport.write(frame);
      this.emit('wire', { direction: 'OUT', text: printable(frame) });
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message, arrived }, 'ABL800 ACK not sent');
    }
  }
}

const NAMED: Record<string, string> = { '\x01': '<SOH>', '\x04': '<EOT>\n', '\x0b': '<VT>', '\x1c': '<FS>', '\r': '\n' };

function printable(b: Buffer): string {
  return b.toString('latin1').replace(/[\x00-\x1f\x7f]/g, (c) => NAMED[c] ?? `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}
