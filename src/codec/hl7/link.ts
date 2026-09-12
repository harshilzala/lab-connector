import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { MllpDecoder, wrapMllp } from './mllp.js';
import {
  elideLongFields,
  hl7ToParsedMessage,
  hl7ToQueryMessage,
  isQueryMessage,
  parseHl7,
  type Hl7Encoding,
  type Hl7Message,
} from './parser.js';

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
// BIDIRECTIONAL (host query). When the analyzer is switched to host-query mode
// it asks the LIS for a worklist as each tube is loaded, instead of only
// broadcasting results. With hostQuery enabled this link recognises that query,
// lets the orchestrator look up the order, and replies with an ORM^O01
// worklist. It stays fully inert while the analyzer runs unidirectional: a
// results-only H360 never sends a query, so the result/ACK path below is
// unchanged and no worklist is ever emitted.
//
// The H360 here has only ever run unidirectional, so we have NO captured sample
// of its query or the reply shape it expects. The reply is therefore built to
// the HL7 v2 standard (QRY^Q02 → ORM^O01) and the raw inbound query is logged
// verbatim, so the first real query confirms — or corrects — the exact layout.
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
  /** Answer inbound host queries with a worklist. When false, a query is only
   *  acknowledged and the link stays results-only. */
  hostQuery?: boolean;
}

/** Correlation context captured from an inbound query, used to address and
 *  correlate the worklist reply the orchestrator asks us to send back. */
interface QueryContext {
  controlId: string;
  /** MSH-11 of the query, echoed on whatever we send back. */
  processingId: string;
  encoding: Hl7Encoding;
  version: string;
  charset: string;
  /** The query's sender — becomes the receiver (MSH-5/6) on our reply. */
  replyToApp: string;
  replyToFacility: string;
}

export class Hl7Link extends EventEmitter implements ProtocolLink {
  readonly name = 'hl7' as const;

  private readonly decoder: MllpDecoder;
  private readonly encoding: BufferEncoding;
  private readonly idleFlushMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => this.decoder.reset();

  /** Set when a host query arrives; consumed by the next sendOrders reply. */
  private queryCtx: QueryContext | null = null;

  /** Bare control-byte chunks seen outside any frame (the BC-5150's 0x02 every
   *  3 s). Counted, not logged: they carry nothing and were 75% of the wire log. */
  private keepAlives = 0;

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

  // Worklist reply to a host query. Called by the orchestrator's answerQuery
  // after it has looked up the pending order for the queried barcode. Uses the
  // context captured from the query so the reply is addressed and correlated
  // back to it. Only reachable after a query arrived while hostQuery is on, so
  // a results-only analyzer never triggers this.
  async sendOrders(orders: OrderDownload[]): Promise<void> {
    const ctx = this.queryCtx;
    this.queryCtx = null;
    if (!ctx) {
      if (orders.length > 0) {
        this.opts.logger.warn(
          { count: orders.length },
          'HL7 sendOrders with no pending query context — a worklist can only be sent in reply to a query; ignoring',
        );
      }
      return;
    }

    if (orders.length === 0) {
      // No pending order for the queried barcode. Acknowledge the query so the
      // analyzer is released rather than left waiting, but send no worklist.
      this.sendQueryAck(ctx);
      this.opts.logger.info(
        { controlId: ctx.controlId },
        'HL7 host query had no pending order — acknowledged, no worklist sent',
      );
      return;
    }

    for (const order of orders) {
      const text = this.buildOrderMessage(order, ctx);
      this.emit('wire', { direction: 'OUT', text: printable(text) });
      try {
        await this.transport.write(wrapMllp(text, this.encoding));
        this.opts.logger.info(
          { barcode: order.sampleId, tests: order.testCodes, controlId: ctx.controlId },
          'HL7 worklist sent to analyzer',
        );
      } catch (e) {
        this.emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  // ---- inbound --------------------------------------------------------------
  //
  // The wire log gets ONE line per complete message, with over-long fields
  // (Base64 bitmaps) shortened, rather than one line per TCP chunk: a BC-5150
  // result arrives as ~25 chunks of 8 KB, 98% of it histogram/scattergram
  // bitmaps. A chunk that is only control bytes outside a frame is the
  // instrument's keep-alive and is counted instead of logged.
  private onData(chunk: Buffer): void {
    let messages: string[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.emit('wire', { direction: 'IN', text: printable(elideLongFields(chunk.toString(this.encoding))) });
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (messages.length === 0 && isKeepAlive(chunk)) {
      this.keepAlives += 1;
      if (this.keepAlives % 1000 === 1) {
        this.opts.logger.debug({ count: this.keepAlives }, 'HL7 link keep-alive bytes from analyzer (not logged to wire)');
      }
    }
    for (const text of messages) {
      this.emit('wire', { direction: 'IN', text: printable(elideLongFields(text)) });
      this.handleMessage(text);
    }
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
        this.emit('wire', { direction: 'IN', text: printable(elideLongFields(text)) });
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

    // A host query is answered by the worklist reply, not by a generic ACK, so
    // it is handled on its own path before the results branch.
    if (isQueryMessage(msg)) {
      this.handleQuery(msg);
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

  // ---- host query -----------------------------------------------------------
  private handleQuery(msg: Hl7Message): void {
    const parsed = hl7ToQueryMessage(msg);
    // Log the raw query verbatim: this is the first time we see this analyzer's
    // query shape, and it is what confirms the reply layout.
    this.opts.logger.info(
      {
        controlId: msg.controlId,
        messageType: msg.messageType,
        barcode: parsed?.queries[0]?.sampleId ?? null,
        raw: printable(msg.raw).slice(0, 400),
      },
      'HL7 host query received',
    );

    // Capture context for the reply the orchestrator will ask us to send.
    this.queryCtx = {
      controlId: msg.controlId,
      processingId: msg.processingId || 'P',
      encoding: msg.encoding,
      version: msg.version || '2.3.1',
      charset: msg.charset,
      replyToApp: msg.sendingApp,
      replyToFacility: msg.sendingFacility,
    };

    if (!this.opts.hostQuery) {
      // Bidirectional is not enabled for this analyzer: acknowledge so it is not
      // left hanging, and stay results-only.
      this.queryCtx = null;
      if (this.opts.ack !== false) this.sendAck(msg);
      this.opts.logger.warn(
        { controlId: msg.controlId },
        'HL7 host query received but hostQuery is disabled — acknowledged, staying unidirectional',
      );
      return;
    }

    if (!parsed) {
      // hostQuery is on but we could not read a barcode to look up.
      this.queryCtx = null;
      if (this.opts.ack !== false) this.sendAck(msg);
      this.opts.logger.warn(
        { controlId: msg.controlId },
        'HL7 host query carried no readable barcode — acknowledged, no worklist',
      );
      return;
    }

    // Hand the query to the orchestrator; it looks up the order and calls
    // sendOrders, which sends the worklist (the reply IS the acknowledgement).
    this.emit('message', parsed);
  }

  /** Build the ORM^O01 worklist reply to a query. Layout follows HL7 v2.3.1;
   *  confirm against the analyzer's first real query. */
  private buildOrderMessage(order: OrderDownload, ctx: QueryContext): string {
    const enc = ctx.encoding;
    const f = enc.field;
    const cc = enc.component;
    const app = this.opts.sendingApp ?? 'LIS';
    const facility = this.opts.sendingFacility ?? '';
    const charset = this.opts.charset ?? ctx.charset ?? '';
    const now = hl7Now();
    const sid = order.sampleId;
    const encField = cc + enc.repeat + enc.escape + enc.subcomponent;

    const msh = [
      'MSH',
      encField,
      app,
      facility,
      ctx.replyToApp || '',
      ctx.replyToFacility || '',
      now,
      '',
      `ORM${cc}O01`,
      ctx.controlId || now,
      ctx.processingId,
      ctx.version,
      '',
      '',
      '',
      '',
      '',
      charset,
    ].join(f);

    const segs = [msh];

    // PID only when demographics were supplied (sendDemographics on).
    const p = order.patient;
    if (p) {
      const name = [p.lastName ?? '', p.firstName ?? '', p.middleName ?? ''].join(cc);
      segs.push(['PID', '1', '', p.patientId ?? '', '', name, '', p.birthDate ?? '', p.sex ?? ''].join(f));
    }

    // One ORC/OBR per ordered test; "ALL" when HMIS listed no specific codes.
    const codes = order.testCodes.length ? order.testCodes : ['ALL'];
    const priority = order.priority === 'S' ? 'S' : 'R';
    let setId = 0;
    for (const code of codes) {
      setId += 1;
      segs.push(['ORC', 'NW', sid, sid, '', '', '', '', '', now].join(f));
      segs.push(['OBR', String(setId), sid, sid, code, priority, now].join(f));
    }
    return segs.join('\r') + '\r';
  }

  /** Acknowledge a query we are not answering with a worklist (no order found,
   *  or unreadable), so the analyzer is released instead of timing out. */
  private sendQueryAck(ctx: QueryContext): void {
    const enc = ctx.encoding;
    const f = enc.field;
    const cc = enc.component;
    const app = this.opts.sendingApp ?? 'LIS';
    const facility = this.opts.sendingFacility ?? '';
    const charset = this.opts.charset ?? ctx.charset ?? '';
    const msh = [
      'MSH',
      cc + enc.repeat + enc.escape + enc.subcomponent,
      app,
      facility,
      ctx.replyToApp || '',
      ctx.replyToFacility || '',
      hl7Now(),
      '',
      `ACK${cc}R01`,
      ctx.controlId,
      ctx.processingId,
      ctx.version,
      '',
      '',
      '',
      '',
      '',
      charset,
    ].join(f);
    const msa = ['MSA', 'AA', ctx.controlId].join(f);
    const ack = `${msh}\r${msa}\r`;
    this.emit('wire', { direction: 'OUT', text: printable(ack) });
    this.transport
      .write(wrapMllp(ack, this.encoding))
      .catch((e) => this.emit('error', e instanceof Error ? e : new Error(String(e))));
  }

  // ---- outbound ACK ---------------------------------------------------------
  private sendAck(msg: Hl7Message): void {
    const f = msg.encoding.field;
    const app = this.opts.sendingApp ?? 'LIS';
    const facility = this.opts.sendingFacility ?? '';
    const charset = this.opts.charset ?? msg.charset ?? '';
    const version = msg.version || '2.3.1';
    const trigger = msg.triggerEvent || 'R01';
    // MSH-11 is echoed, not fixed: the Mindray BC-5000/BC-5150 sends "Q" on a
    // QC result and requires the ACK to carry the same value (protocol §4.3.1,
    // §5.4). A sample result carries "P", which is what the H360 reference ACK
    // always sent — so this changes nothing for that analyzer.
    const processingId = msg.processingId || 'P';

    // Field layout matches the reference byte-for-byte:
    // MSH-3 app, MSH-4 facility, MSH-5/6 empty, MSH-7 now, MSH-8 empty,
    // MSH-9 ACK^<trigger>, MSH-10 echoed control id, MSH-11 echoed processing
    // id, MSH-12 version, MSH-13..17 empty, MSH-18 charset.
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
      processingId,
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

/** True for a chunk made only of control bytes that is not part of a frame
 *  (no VT start, no FS end): a keep-alive or a stray CR/LF, never data. */
function isKeepAlive(chunk: Buffer): boolean {
  if (chunk.length === 0 || chunk.length > 8) return false;
  for (const b of chunk) if (b >= 0x20 || b === 0x0b || b === 0x1c) return false;
  return true;
}

/** Segment separators as visible newlines for the admin wire log. */
function printable(s: string): string {
  return s.replace(/\x0b/g, '<VT>').replace(/\x1c/g, '<FS>').replace(/\r/g, '\n');
}
