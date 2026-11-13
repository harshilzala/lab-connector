import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload, ParsedMessage } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { MllpDecoder, wrapMllp } from './mllp.js';
import {
  component,
  fieldOf,
  elideLongFields,
  hl7ToParsedMessage,
  hl7ToQueryMessage,
  isQueryMessage,
  parseHl7,
  type Hl7Encoding,
  type Hl7Message,
} from './parser.js';
import { Hl7OrderRejected, buildOrderPush, hl7Stamp, readAck, type Hl7Ack, type Hl7OrderMessageType } from './orders.js';

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
//
// ORDER PUSH (orderPush.enabled). The opposite arrangement, for a receiver
// that never asks: IM, the instrument middleware, listens on a port and is
// SENT every order. The connector dials it (transport mode "client") and
// each order goes as its own ORM^O01, one at a time, each waiting for the
// receiver's MSA before the next is written. See ./orders.ts for the layout.
// A query still takes the reply path above, so one link can do both.
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
  /** How the analyzer asks for work. "standard" (default): QRY/QBP queries,
   *  answered with ORM^O01. "mindray-orm": Mindray LabXpert (BC-6200) sends
   *  ORM^O01 with ORC-1 "RF" and the barcode in ORC-3, and takes an ORR^O02
   *  carrying the Test Mode back. Nothing changes for an analyzer left on
   *  "standard". */
  queryStyle?: 'standard' | 'mindray-orm';
  /** mindray-orm only: Test Mode sent when HMIS has no order for the tube
   *  ("CBC+DIFF", as the legacy interface did), or null to refuse (MSA AR). */
  mindrayNoOrderTestMode?: string | null;
  /** Send orders unsolicited, each confirmed by the receiver's MSA. */
  orderPush?: {
    enabled: boolean;
    messageType: Hl7OrderMessageType;
    version: string;
    receivingApp: string;
    receivingFacility: string;
    processingId: string;
    /** How long to wait for the MSA before the send counts as failed. */
    ackTimeoutMs: number;
  };
}

/** An order on the wire, waiting for the receiver's MSA. */
interface PendingAck {
  controlId: string;
  resolve(ack: Hl7Ack): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
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
  /** The barcode the query asked about. */
  barcode?: string;
}

export class Hl7Link extends EventEmitter implements ProtocolLink {
  readonly name = 'hl7' as const;

  private readonly decoder: MllpDecoder;
  private readonly encoding: BufferEncoding;
  private readonly idleFlushMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => {
    this.decoder.reset();
    // The answer to whatever was on the wire is never coming on this socket.
    this.failPendingAck(new Error('the connection closed before the receiver acknowledged the order'));
  };

  /** Set when a host query arrives; consumed by the next sendOrders reply. */
  private queryCtx: QueryContext | null = null;

  /** Order push: the one message currently waiting for its MSA. */
  private pendingAck: PendingAck | null = null;
  /** Order push: serialises sends, so two orders never share the line. */
  private pushQueue: Promise<unknown> = Promise.resolve();
  private pushSeq = 0;

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
    this.failPendingAck(new Error('the link was stopped before the receiver acknowledged the order'));
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
    if (!ctx && this.opts.orderPush?.enabled) {
      // One order per message, in turn. The first failure stops the batch and
      // is thrown, so the caller knows exactly which orders did not go.
      for (const order of orders) {
        const run = () => this.pushOrder(order);
        const p = this.pushQueue.then(run, run);
        this.pushQueue = p.catch(() => {});
        await p;
      }
      return;
    }
    if (!ctx) {
      if (orders.length > 0) {
        this.opts.logger.warn(
          { count: orders.length },
          'HL7 sendOrders with no pending query context — a worklist can only be sent in reply to a query; ignoring',
        );
      }
      return;
    }

    if (this.opts.queryStyle === 'mindray-orm') {
      await this.sendMindrayReply(ctx, orders[0] ?? null);
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

    // An acknowledgement is the answer to something WE sent. It is never
    // acknowledged in turn — two ends answering each other's ACKs never stop —
    // and it carries no result, so it goes no further than this.
    const ack = readAck(msg);
    if (ack && !msg.segments.some((s) => s.name === 'OBX')) {
      this.handleAck(ack, msg);
      return;
    }

    // Mindray LabXpert asks for work with an ORM^O01 "RF" (opt-in style).
    if (this.opts.queryStyle === 'mindray-orm' && isMindrayOrderQuery(msg)) {
      this.handleQuery(msg, mindrayQueryMessage(msg));
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

  // ---- order push -----------------------------------------------------------

  /** Send one order and wait for the receiver to accept it. Rejects on a
   *  refusal (Hl7OrderRejected), a timeout, or a socket that went away. */
  private async pushOrder(order: OrderDownload): Promise<void> {
    const push = this.opts.orderPush!;
    const controlId = this.nextControlId();
    const text = buildOrderPush(
      order,
      {
        messageType: push.messageType,
        version: push.version,
        sendingApp: this.opts.sendingApp ?? 'LIS',
        sendingFacility: this.opts.sendingFacility ?? '',
        receivingApp: push.receivingApp,
        receivingFacility: push.receivingFacility,
        processingId: push.processingId,
        charset: this.opts.charset ?? '',
      },
      controlId,
    );

    const answered = new Promise<Hl7Ack>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingAck?.controlId !== controlId) return;
        this.pendingAck = null;
        reject(new Error(`no acknowledgement from the receiver within ${push.ackTimeoutMs} ms`));
      }, push.ackTimeoutMs);
      this.pendingAck = { controlId, resolve, reject, timer };
    });
    // The write may fail first; the waiter is then rejected by failPendingAck
    // and must not surface as an unhandled rejection.
    answered.catch(() => {});

    this.emit('wire', { direction: 'OUT', text: printable(text) });
    try {
      await this.transport.write(wrapMllp(text, this.encoding));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.failPendingAck(err);
      throw err;
    }

    const ack = await answered;
    if (!ack.accepted) {
      this.opts.logger.warn(
        { barcode: order.sampleId, tests: order.testCodes, controlId, code: ack.code, detail: ack.text },
        'HL7 order refused by the receiver',
      );
      throw new Hl7OrderRejected(ack.code, ack.text);
    }
    this.opts.logger.info(
      { barcode: order.sampleId, tests: order.testCodes, controlId, code: ack.code },
      'HL7 order sent and acknowledged',
    );
  }

  /** MSH-10: the send time plus a counter — unique across a restart, and 18
   *  characters, inside the 20 that HL7 v2.3 allows. */
  private nextControlId(): string {
    this.pushSeq = (this.pushSeq + 1) % 10000;
    return `${hl7Stamp()}${String(this.pushSeq).padStart(4, '0')}`;
  }

  private handleAck(ack: Hl7Ack, msg: Hl7Message): void {
    const waiting = this.pendingAck;
    // Orders go one at a time, so an acknowledgement that names no message
    // (some receivers leave MSA-2 empty) can only be for the one in flight.
    if (waiting && (ack.controlId === waiting.controlId || ack.controlId === '')) {
      clearTimeout(waiting.timer);
      this.pendingAck = null;
      waiting.resolve(ack);
      return;
    }
    this.opts.logger.warn(
      { type: msg.messageType, code: ack.code, answers: ack.controlId, waitingFor: waiting?.controlId ?? null },
      'HL7 acknowledgement matched no order in flight — ignored',
    );
  }

  private failPendingAck(err: Error): void {
    const waiting = this.pendingAck;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pendingAck = null;
    waiting.reject(err);
  }

  // ---- host query -----------------------------------------------------------
  private handleQuery(msg: Hl7Message, preParsed?: ParsedMessage | null): void {
    const parsed = preParsed !== undefined ? preParsed : hl7ToQueryMessage(msg);
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
      barcode: parsed?.queries[0]?.sampleId ?? '',
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

  /**
   * Mindray LabXpert (BC-6200) reply to an ORM^O01 "RF" query: ORR^O02 with
   * the Test Mode the tube is to run in. The PV1 / OBR / OBX layout is the one
   * the legacy interface sent and LabXpert accepted for ~33 000 tubes
   * (Aug–Nov 2026), template fields included:
   *
   *   MSH|^~\&|LIS||LabXpert|Mindray|<now>||ORR^O02|<ctl>|P|2.3.1||||||UNICODE
   *   MSA|AA|<query ctl>
   *   PID|1||<mrn>^^^^||^<name>|||Male
   *   PV1|1|HM^001|||||||||||||||||
   *   ORC|AF|<barcode>|||
   *   OBR|1|<barcode>||||20060506||||TECH|||DiagnoseContent....|20060504||||||||20080821||HM||||Validator||||Operator
   *   OBX|1|IS|08001^Take Mode^99MRC||A||||||F
   *   OBX|2|IS|08002^Blood Mode^99MRC||W||||||F
   *   OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F
   *   OBX|4|IS|01002^Ref Group^99MRC||||||||F
   *   OBX|5|NM|30525-0^Age^LN||36|yr|||||F
   *   OBX|6|ST|01001^Remark^99MRC||||||||F
   *
   * Test Mode: CBC+DIFF when any differential parameter is pending for the
   * tube, CBC when only the count is — the legacy interface's choice.
   */
  private async sendMindrayReply(ctx: QueryContext, order: OrderDownload | null): Promise<void> {
    const f = ctx.encoding.field;
    const cc = ctx.encoding.component;
    const testMode = order ? mindrayTestMode(order.testCodes) : this.opts.mindrayNoOrderTestMode === undefined ? 'CBC+DIFF' : this.opts.mindrayNoOrderTestMode;
    const charset = this.opts.charset ?? ctx.charset ?? '';
    const msh = [
      'MSH',
      cc + ctx.encoding.repeat + ctx.encoding.escape + ctx.encoding.subcomponent,
      this.opts.sendingApp ?? 'LIS',
      this.opts.sendingFacility ?? '',
      ctx.replyToApp || '',
      ctx.replyToFacility || '',
      hl7Now(),
      '',
      `ORR${cc}O02`,
      ctx.controlId || hl7Now(),
      ctx.processingId,
      ctx.version,
      '',
      '',
      '',
      '',
      '',
      charset,
    ].join(f);
    const sid = order?.sampleId ?? ctx.barcode ?? '';

    if (!testMode) {
      const text = `${msh}\r${['MSA', 'AR', ctx.controlId].join(f)}\r`;
      this.emit('wire', { direction: 'OUT', text: printable(text) });
      await this.transport.write(wrapMllp(text, this.encoding)).catch((e) => this.emit('error', e instanceof Error ? e : new Error(String(e))));
      this.opts.logger.info({ controlId: ctx.controlId }, 'Mindray query had no pending order — refused (MSA AR)');
      return;
    }

    const p = order?.patient ?? null;
    const name = p ? [p.lastName, p.firstName, p.middleName].filter((x) => x && x.trim()).join(' ') : '';
    const sex = p?.sex === 'M' ? 'Male' : p?.sex === 'F' ? 'Female' : '';
    const age = ageInYears(p?.birthDate ?? null);
    const segs = [
      msh,
      ['MSA', 'AA', ctx.controlId].join(f),
      ['PID', '1', '', `${p?.patientId ?? ''}^^^^`, '', `^${name}`, '', '', sex].join(f),
      'PV1|1|HM^001|||||||||||||||||',
      ['ORC', 'AF', sid, '', '', ''].join(f),
      `OBR|1|${sid}||||20060506||||TECH|||DiagnoseContent....|20060504||||||||20080821||HM||||Validator||||Operator`,
      'OBX|1|IS|08001^Take Mode^99MRC||A||||||F',
      'OBX|2|IS|08002^Blood Mode^99MRC||W||||||F',
      `OBX|3|IS|08003^Test Mode^99MRC||${testMode}||||||F`,
      'OBX|4|IS|01002^Ref Group^99MRC||||||||F',
      `OBX|5|NM|30525-0^Age^LN||${age}|yr|||||F`,
      'OBX|6|ST|01001^Remark^99MRC||||||||F',
    ];
    const text = segs.join('\r') + '\r';
    this.emit('wire', { direction: 'OUT', text: printable(text) });
    try {
      await this.transport.write(wrapMllp(text, this.encoding));
      this.opts.logger.info({ barcode: sid || null, testMode, controlId: ctx.controlId, ordered: !!order }, 'Mindray order reply (ORR^O02) sent');
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
    }
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

// ---- Mindray LabXpert (queryStyle "mindray-orm") ---------------------------

/** ORM^O01 whose ORC-1 is "RF": LabXpert asking what to run on a tube. */
export function isMindrayOrderQuery(msg: Hl7Message): boolean {
  if (!/^ORM\^O01/i.test(msg.messageType.replace(msg.encoding.component, '^'))) return false;
  const orc = msg.segments.find((s) => s.name === 'ORC');
  return !!orc && fieldOf(orc, 1).toUpperCase() === 'RF';
}

/** The query as a ParsedMessage: the barcode is ORC-3. */
export function mindrayQueryMessage(msg: Hl7Message): ParsedMessage | null {
  const orc = msg.segments.find((s) => s.name === 'ORC');
  const sampleId = orc ? component(fieldOf(orc, 3), 1, msg.encoding) : '';
  if (!sampleId) return null;
  return { protocol: 'hl7', sender: msg.sendingApp || null, patient: null, queries: [{ sampleId, testCodes: [] }], results: [], raw: msg.raw };
}

/** Differential parameters: any of these pending means the tube needs DIFF. */
const MINDRAY_DIFF_CODES = new Set(['NEU#', 'NEU%', 'LYM#', 'LYM%', 'MON#', 'MON%', 'EOS#', 'EOS%', 'BAS#', 'BAS%']);

export function mindrayTestMode(codes: readonly string[]): string {
  return codes.some((c) => MINDRAY_DIFF_CODES.has(c.trim().toUpperCase())) ? 'CBC+DIFF' : 'CBC';
}

/** Whole years from a YYYYMMDD birth date, '' when unknown. */
function ageInYears(birth: string | null, now = new Date()): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec((birth ?? '').replace(/\D/g, ''));
  if (!m) return '';
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age--;
  return age >= 0 && age < 150 ? String(age) : '';
}

/** Segment separators as visible newlines for the admin wire log. */
function printable(s: string): string {
  return s.replace(/\x0b/g, '<VT>').replace(/\x1c/g, '<FS>').replace(/\r/g, '\n');
}
