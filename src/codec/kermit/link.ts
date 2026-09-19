import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink, WireEvent } from '../types.js';
import {
  DEFAULT_PARAMS,
  KermitDecoder,
  chunkPayload,
  encodePacket,
  parseSendInit,
  quote,
  unquote,
  type KermitPacket,
  type KermitParams,
} from './packets.js';
import { buildOrderRecord, orderFileName, parseResultFile, unencodableTestCodes } from './vitros250.js';
import { renderBytes } from '../../probe/identify.js';

// =============================================================================
// KermitLink — the VITROS 250/350 protocol state machine.
//
// Structurally this mirrors AstmLink: half-duplex, one side transmits at a
// time, every packet is individually acknowledged. The differences are that a
// transmission is a named FILE rather than a record stream, and that the
// acknowledgement is a Y packet carrying the peer's parameters rather than a
// bare ACK byte.
//
// `sending` gates whether inbound packets are routed to the sender's
// acknowledgement waiter or to the receive state machine.
//
// WHAT THE ANALYZER DOES WHEN NOTHING IS HAPPENING. Every ~60 s of quiet the
// VITROS 250 sends a bare NAK for packet 0 — a Kermit receiver saying "I am
// here, send me a file if you have one". The legacy capture holds 51,501 of
// them and the host it ran under never answered a single one; it sent its own
// send-init whenever it had work, at any point in that 60 s cycle, and was
// never refused. See handleInbound for what happened when this link did answer.
// =============================================================================

export interface KermitLinkOptions {
  /** How long to wait for a Y before retransmitting a packet. */
  ackTimeoutMs: number;
  /** Retransmissions per packet before the transfer is abandoned. */
  maxRetries: number;
  /**
   * Pause after each acknowledged packet before the next goes out.
   *
   * The analyzer acknowledges fast but needs time to act on what it just
   * acknowledged. The legacy host paced every packet by 1 s (VitrosDelayTime)
   * and never drew an error packet; this link, sending a whole transfer in
   * ~0.8 s, drew "0005 INVALID PACKET USAGE" / "0008 INVALID SEQUENCE USE"
   * 160 times in a day, almost always on the transfer that followed another
   * within two seconds. Default 1000; tests pass 0.
   */
  interPacketDelayMs?: number;
  /** Minimum quiet time between the end of one transfer and the next S. */
  interTransferDelayMs?: number;
  logger: Logger;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How much non-packet input to keep, per transfer, for the failure report. */
const UNPARSED_KEEP = 200;
/** Packet data shown in a trace token — enough to read an E or S, never a whole D. */
const TRACE_DATA_CHARS = 48;

/**
 * One packet as a trace token: "→S0", "←Y0(~* @-#N1\)", "←E0(0005 INVALID PACKET
 * USAGE)". D packets show only their length — the payload is already on the
 * wire line the trace belongs to.
 */
function traceToken(direction: 'IN' | 'OUT', p: KermitPacket): string {
  const arrow = direction === 'OUT' ? '→' : '←';
  if (p.type === 'D') return `${arrow}D${p.seq}[${p.data.length}]`;
  if (!p.data) return `${arrow}${p.type}${p.seq}`;
  const shown = p.data.length > TRACE_DATA_CHARS ? `${p.data.slice(0, TRACE_DATA_CHARS)}…` : p.data;
  return `${arrow}${p.type}${p.seq}(${shown.replace(/[\x00-\x1f]/g, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0')}>`).trimEnd()})`;
}

export class KermitLink extends EventEmitter implements ProtocolLink {
  readonly name = 'kermit' as const;
  /**
   * A sample program sent to the VITROS 250 REPLACES the one it holds for that
   * sample id — it does not add to it. Legacy capture, 2026-06-19:
   * SF2606190004 was downloaded with 15 tests at 08:11 and again with 12 at
   * 11:24; the analyzer ran exactly the 12. So every download must carry the
   * whole panel, never just the tests added since the last one.
   */
  readonly downloadReplacesProgram = true;

  private readonly decoder = new KermitDecoder();
  /** Parameters in force. Replaced by whatever the peer negotiates. */
  private params: KermitParams = { ...DEFAULT_PARAMS };

  private sending = false;
  private ackWaiter: ((p: KermitPacket) => void) | null = null;
  /** Non-packet bytes heard while waiting for an ACK — see onData. */
  private unparsedWhileSending: Buffer = Buffer.alloc(0);
  /** Packet-by-packet record of the transfer in progress, for the wire log. */
  private txTrace: string[] = [];

  // Receive-session accumulators.
  private rxFileName = '';
  private rxData = '';
  private rxTrace: string[] = [];
  private lastAckedSeq = -1;
  /** Idle NAK/Y packets heard from the analyzer and left unanswered. */
  private heartbeats = 0;

  private txQueue: Promise<unknown> = Promise.resolve();
  private orderSequence = 0;
  /** When the last transfer (ours) finished, for the inter-transfer pause. */
  private lastTransferEndedAt = 0;

  private readonly onDataBound = (c: Buffer) => this.onData(c);

  constructor(private readonly transport: Transport, private readonly opts: KermitLinkOptions) {
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

  // ---- inbound routing ------------------------------------------------------
  private onData(chunk: Buffer): void {
    const decoded = this.decoder.push(chunk);
    if (decoded.length === 0 && this.decoder.buffered === 0) {
      // Bytes that cannot begin a Kermit packet. Idle, the VITROS 250 line
      // dribbles 0x80/0x00 constantly (test/kermit-check.ts [9]), so this is
      // only worth keeping while we are waiting for an acknowledgement: then
      // it is the difference between an analyzer that never answered (cable,
      // host comms off) and one that answered in a serial format the NPort is
      // not set to (baud/parity). Reported once, when the transfer fails.
      if (this.sending && this.unparsedWhileSending.length < UNPARSED_KEEP) {
        this.unparsedWhileSending = Buffer.concat([this.unparsedWhileSending, chunk]).subarray(0, UNPARSED_KEEP);
      }
      return;
    }
    for (const { packet, valid } of decoded) {
      if (this.sending) {
        // Mid-transmit: every packet is an answer to what we just sent.
        this.txTrace.push(traceToken('IN', packet));
        this.ackWaiter?.(packet);
        continue;
      }
      if (!valid) {
        this.opts.logger.warn({ seq: packet.seq, type: packet.type }, 'Kermit checksum mismatch → NAK');
        this.rxTrace.push(`${traceToken('IN', packet)}✗`);
        this.reply({ seq: packet.seq, type: 'N', data: '' });
        continue;
      }
      this.handleInbound(packet);
    }
  }

  /** Answer a packet of the analyzer's own transfer, and note it in the trace. */
  private reply(p: KermitPacket): void {
    this.rxTrace.push(traceToken('OUT', p));
    this.transport.write(encodePacket(p, this.params)).catch((e) => this.emit('error', e));
  }

  private handleInbound(p: KermitPacket): void {
    if (p.type === 'N' || p.type === 'Y') {
      // The idle heartbeat (see the header), or a stray acknowledgement. Not
      // the start of anything, and NOT to be answered: this link used to treat
      // the second heartbeat as "a repeat of the packet we last acknowledged"
      // and send a Y for it, after which the analyzer refused our next
      // send-init with "0005 INVALID PACKET USAGE" — 28 of 28 downloads that
      // followed two or more minutes of quiet on 16–17 Sep 2026, against 4 of
      // 4 first-time successes inside that window. The legacy host answered
      // none of the 51,501 heartbeats it was sent.
      this.heartbeats += 1;
      this.opts.logger.debug({ type: p.type, seq: p.seq, heartbeats: this.heartbeats }, 'Kermit idle packet from the analyzer — ignored');
      return;
    }

    this.rxTrace.push(traceToken('IN', p));

    // A repeat of the packet we last acknowledged means our Y was lost. Answer
    // again, but do not fold the payload in a second time.
    if (p.seq === this.lastAckedSeq && p.type !== 'S') {
      this.reply({ seq: p.seq, type: 'Y', data: '' });
      return;
    }

    switch (p.type) {
      case 'S':
        // The analyzer opens a transfer and states its parameters. Our answer
        // is an EMPTY Y — "# Y>" on the wire — which is what the legacy host
        // sent on every one of its 1,598 captured receives; it never named
        // parameters of its own, so the analyzer fell back to Kermit's
        // defaults (80-character packets, the 'p' LEN seen throughout the
        // capture). This link used to put our parameters in the Y, and 11 of
        // the 32 result transfers on 16–17 Sep 2026 opened with "0009 INVALID
        // CONSTRUCTION" / "0008 INVALID SEQUENCE USE" and only landed on the
        // analyzer's retry ~13 s later. Match the exchange that is proven.
        this.params = parseSendInit(p.data);
        this.rxFileName = '';
        this.rxData = '';
        this.rxTrace = [this.rxTrace[this.rxTrace.length - 1]!];
        this.reply({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'F':
        this.rxFileName = unquote(p.data, this.params.qctl);
        this.rxData = '';
        this.reply({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'D':
        this.rxData += unquote(p.data, this.params.qctl);
        this.reply({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'Z':
        this.reply({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'B':
        this.reply({ seq: p.seq, type: 'Y', data: '' });
        this.finalizeReceive();
        break;
      case 'E': {
        // The analyzer has abandoned whatever was in progress. Keep the
        // exchange that led here — it is the only evidence of why.
        const text = unquote(p.data, this.params.qctl).trimEnd();
        this.emit('wire', { direction: 'IN', text: `(error packet) ${text}`, trace: this.rxTrace.join(' ') } satisfies WireEvent);
        this.rxFileName = '';
        this.rxData = '';
        this.rxTrace = [];
        this.lastAckedSeq = -1;
        this.emit('error', new Error(`VITROS sent a Kermit error packet: ${text}`));
        return;
      }
      default:
        break;
    }
    this.lastAckedSeq = p.seq;
  }

  private finalizeReceive(): void {
    const payload = this.rxData;
    const fileName = this.rxFileName;
    const trace = this.rxTrace.join(' ');
    this.rxData = '';
    this.rxFileName = '';
    this.rxTrace = [];
    this.lastAckedSeq = -1;
    if (!payload) return;

    this.emit('wire', { direction: 'IN', text: `${fileName}: ${payload}`, trace } satisfies WireEvent);
    try {
      const msg = parseResultFile(payload);
      this.opts.logger.info({ file: fileName, results: msg.results.length }, 'VITROS 250 result file received');
      this.emit('message', msg);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---- sender ---------------------------------------------------------------
  sendOrders(orders: OrderDownload[]): Promise<void> {
    // Serialise transmits so two downloads never interleave on the wire.
    const run = () => this.transmitOrders(orders);
    const p = this.txQueue.then(run, run);
    this.txQueue = p.catch(() => {});
    return p;
  }

  private async transmitOrders(orders: OrderDownload[]): Promise<void> {
    for (const order of orders) {
      const dropped = unencodableTestCodes(order);
      if (dropped.length) {
        // A VITROS assay code is one byte. Anything outside that cannot be
        // expressed, and silently shipping a short order would run the wrong
        // panel — say so instead.
        this.opts.logger.error(
          { sample: order.sampleId, dropped },
          'VITROS 250 assay codes are single bytes; these codes cannot be encoded and were NOT ordered',
        );
      }
      const record = buildOrderRecord(order);
      this.orderSequence += 1;
      await this.sendFile(orderFileName(this.orderSequence), record);
    }
  }

  /** Send one payload as a named Kermit file: S, F, D…, Z, B. */
  private async sendFile(fileName: string, payload: string): Promise<void> {
    await this.awaitIdle();
    await this.awaitTransferGap();
    this.sending = true;
    this.unparsedWhileSending = Buffer.alloc(0);
    this.txTrace = [];
    let failure: string | null = null;
    try {
      let seq = 0;
      // Send-init carries no data, matching the host the analyzer has accepted
      // for years; the analyzer's acknowledgement states the parameters to use
      // for the rest of the transfer, so negotiate before chunking anything.
      const ack = await this.sendPacket({ seq: seq++, type: 'S', data: '' });
      if (ack.data) this.params = parseSendInit(ack.data);

      await this.pace();
      await this.sendPacket({ seq: seq++, type: 'F', data: quote(fileName, this.params.qctl) });
      for (const chunk of chunkPayload(payload, this.params)) {
        await this.pace();
        await this.sendPacket({ seq: seq++, type: 'D', data: chunk });
      }
      await this.pace();
      await this.sendPacket({ seq: seq++, type: 'Z', data: '' });
      await this.pace();
      await this.sendPacket({ seq: seq++, type: 'B', data: '' });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.sending = false;
      this.decoder.reset();
      this.lastTransferEndedAt = Date.now();
      // One wire line per transfer, written once its outcome is known, with
      // the packet exchange beside the payload — so "did the analyzer take
      // it?" is answered by the log rather than by the next result.
      const trace = failure ? `${this.txTrace.join(' ')} ✗ ${failure}` : this.txTrace.join(' ');
      this.emit('wire', { direction: 'OUT', text: `${fileName}: ${payload}`, trace } satisfies WireEvent);
    }
  }

  /** The per-packet pause — see KermitLinkOptions.interPacketDelayMs. */
  private pace(): Promise<void> {
    const ms = this.opts.interPacketDelayMs ?? 0;
    return ms > 0 ? delay(ms) : Promise.resolve();
  }

  /** Hold the next send-init until the previous transfer has been quiet long enough. */
  private async awaitTransferGap(): Promise<void> {
    const ms = this.opts.interTransferDelayMs ?? 0;
    if (ms <= 0 || !this.lastTransferEndedAt) return;
    const remaining = this.lastTransferEndedAt + ms - Date.now();
    if (remaining > 0) await delay(remaining);
  }

  /** Transmit one packet and wait for its Y, retransmitting on NAK or silence. */
  private async sendPacket(p: KermitPacket): Promise<KermitPacket> {
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      this.txTrace.push(traceToken('OUT', p));
      this.transport.write(encodePacket(p, this.params)).catch((e) => this.emit('error', e));
      const reply = await this.waitAck(this.opts.ackTimeoutMs);

      if (!reply) {
        this.txTrace.push('(no reply)');
        this.opts.logger.warn({ seq: p.seq, type: p.type, attempt }, 'Kermit ACK timeout — retransmitting');
        continue;
      }
      if (reply.type === 'Y' && reply.seq === p.seq % 64) return reply;
      if (reply.type === 'E') {
        throw new Error(`VITROS rejected the transfer: ${unquote(reply.data, this.params.qctl).trimEnd()}`);
      }
      this.opts.logger.warn(
        { sent: p.type, seq: p.seq, gotType: reply.type, gotSeq: reply.seq, attempt },
        'Kermit unexpected reply — retransmitting',
      );
      await delay(200);
    }
    const heard = this.unparsedWhileSending;
    if (heard.length > 0) {
      // It answered, just not in Kermit: almost always a baud/parity mismatch
      // between the analyzer and the NPort's serial port.
      this.emit('wire', { direction: 'IN', text: `(not Kermit, ${heard.length}+ bytes while waiting for ACK) ${renderBytes(heard)}` });
      throw new Error(
        `VITROS 250 did not acknowledge a ${p.type} packet after ${this.opts.maxRetries} attempts — ` +
          `it sent ${heard.length}+ bytes that are not Kermit packets: check baud/parity on the NPort serial port and the analyzer`,
      );
    }
    throw new Error(
      `VITROS 250 did not acknowledge a ${p.type} packet after ${this.opts.maxRetries} attempts — ` +
        'nothing at all was received from it: check the serial cable and that host communication is enabled on the analyzer',
    );
  }

  private waitAck(timeoutMs: number): Promise<KermitPacket | null> {
    return new Promise<KermitPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiter = null;
        resolve(null);
      }, timeoutMs);
      this.ackWaiter = (packet) => {
        clearTimeout(timer);
        this.ackWaiter = null;
        resolve(packet);
      };
    });
  }

  /** Let any inbound transfer finish before grabbing the line. */
  private async awaitIdle(): Promise<void> {
    let waited = 0;
    while (this.rxData && waited < 30_000) {
      await delay(50);
      waited += 50;
    }
  }
}
