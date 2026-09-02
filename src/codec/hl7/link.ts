import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { MllpDecoder, wrapMllp } from './mllp.js';
import { hl7ToParsedMessage, parseHl7, type Hl7Message } from './parser.js';

// =============================================================================
// Hl7Link — HL7 v2 over MLLP, the interface the Erba H360 hematology analyzer
// speaks.
//
// Transcribed from the production middleware at E:\API_Integration\Devices\H360
// (Lab Integration.exe + its H360.txt wire log). The exchange is one-way plus
// an application acknowledgement:
//
//   H360 → LIS   VT MSH|…|ORU^R01|<ctrlId>|P|2.3.1|…  PID  PV1  OBR  OBX…  FS CR
//   LIS  → H360  VT MSH|^~\&|LIS||||<now>||ACK^R01|<ctrlId>|P|2.3.1||||||UNICODE
//                   MSA|AA|<ctrlId> FS CR
//
// The ACK mirrors the inbound trigger event and echoes MSH-10 in both MSH-10 and
// MSA-2 — byte-for-byte what the legacy middleware sent and the analyzer has
// accepted in production.
//
// The analyzer never host-queries over this link, so sendOrders is a no-op
// (keep hostQuery:false in config). Results arrive unsolicited and are joined to
// their pending order rows at upload time by the orchestrator.
// =============================================================================

export interface Hl7LinkOptions {
  logger: Logger;
  /** MSH-3 on our ACK. */
  sendingApp?: string;
  /** MSH-4 on our ACK. Blank in the reference implementation. */
  sendingFacility?: string;
  /** MSH-18 on our ACK. */
  charset?: string;
  /** Send an application ACK for every inbound message. */
  ack?: boolean;
  /** OBX-2 value types that become results; [] accepts every type. */
  valueTypes?: string[];
  /** Wire encoding. The H360 declares UNICODE (UTF-8) in MSH-18. */
  encoding?: BufferEncoding;
  /** Flush an unterminated buffer after this long. 0 disables. */
  idleFlushMs?: number;
}

export class Hl7Link extends EventEmitter implements ProtocolLink {
  readonly name = 'hl7' as const;

  private readonly decoder: MllpDecoder;
  private readonly encoding: BufferEncoding;
  private readonly idleFlushMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => this.decoder.reset();

  constructor(private readonly transport: Transport, private readonly opts: Hl7LinkOptions) {
    super();
    this.encoding = opts.encoding ?? 'utf8';
    this.decoder = new MllpDecoder(this.encoding);
    this.idleFlushMs = opts.idleFlushMs ?? 0;
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.transport.stop();
  }

  // Results-only interface: the H360 pulls its worklist from its own screen or
  // from a separate query channel, never over this ORU link.
  async sendOrders(orders: OrderDownload[]): Promise<void> {
    if (orders.length > 0) {
      this.opts.logger.warn(
        { count: orders.length },
        'HL7 order-download not supported on this results-only ORU link — ignoring',
      );
    }
  }

  // ---- inbound --------------------------------------------------------------
  private onData(chunk: Buffer): void {
    this.emit('wire', { direction: 'IN', text: printable(chunk.toString(this.encoding)) });

    let messages: string[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const text of messages) this.handleMessage(text);
    this.armIdleFlush();
  }

  /** Safety net for a peer that streams HL7 without the MLLP end block. */
  private armIdleFlush(): void {
    if (this.idleFlushMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.decoder.pending === 0) {
      this.idleTimer = null;
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      for (const text of this.decoder.flushUnframed()) {
        this.opts.logger.warn('HL7 message had no MLLP end block — flushed on idle');
        this.handleMessage(text);
      }
    }, this.idleFlushMs);
  }

  private handleMessage(text: string): void {
    let msg: Hl7Message;
    try {
      msg = parseHl7(text);
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message, head: text.slice(0, 80) }, 'unparseable HL7 message');
      return;
    }

    // ACK first: the analyzer holds the line waiting for it, and a parse that
    // yields nothing filable is still a message it delivered successfully.
    if (this.opts.ack !== false) this.sendAck(msg);

    const parsed = hl7ToParsedMessage(msg, { valueTypes: this.opts.valueTypes });
    if (!parsed) {
      this.opts.logger.info(
        { type: msg.messageType, controlId: msg.controlId },
        'HL7 message carried no filable results — acknowledged and dropped',
      );
      return;
    }
    this.opts.logger.info(
      { sample: parsed.results[0]!.sampleId, fields: parsed.results.length, controlId: msg.controlId },
      'HL7 results parsed',
    );
    this.emit('message', parsed);
  }

  // ---- outbound ACK ---------------------------------------------------------
  private sendAck(msg: Hl7Message): void {
    const f = msg.encoding.field;
    const app = this.opts.sendingApp ?? 'LIS';
    const facility = this.opts.sendingFacility ?? '';
    const charset = this.opts.charset ?? msg.charset ?? '';
    const version = msg.version || '2.3.1';
    const trigger = msg.triggerEvent || 'R01';

    // Field layout matches the reference byte-for-byte:
    // MSH-3 app, MSH-4 facility, MSH-5/6 empty, MSH-7 now, MSH-8 empty,
    // MSH-9 ACK^<trigger>, MSH-10 echoed control id, MSH-11 P, MSH-12 version,
    // MSH-13..17 empty, MSH-18 charset.
    const msh = [
      'MSH',
      msg.encoding.component + msg.encoding.repeat + msg.encoding.escape + msg.encoding.subcomponent,
      app,
      facility,
      '',
      '',
      hl7Now(),
      '',
      `ACK${msg.encoding.component}${trigger}`,
      msg.controlId,
      'P',
      version,
      '',
      '',
      '',
      '',
      '',
      charset,
    ].join(f);
    const msa = ['MSA', 'AA', msg.controlId].join(f);
    const ack = `${msh}\r${msa}\r`;

    this.emit('wire', { direction: 'OUT', text: printable(ack) });
    this.transport
      .write(wrapMllp(ack, this.encoding))
      .catch((e) => this.emit('error', e instanceof Error ? e : new Error(String(e))));
  }
}

/** HL7 timestamp: yyyyMMddHHmmss in local time, as the reference emits. */
export function hl7Now(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Segment separators as visible newlines for the admin wire log. */
function printable(s: string): string {
  return s.replace(/\x0b/g, '<VT>').replace(/\x1c/g, '<FS>').replace(/\r/g, '\n');
}
