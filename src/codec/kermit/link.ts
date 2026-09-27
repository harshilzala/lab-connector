import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
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
// The rules below that are not plain Kermit come from Ortho's "Specifications
// for Laboratory Computer Interface" (Part No. 355283), chapter 5, and from
// what this analyzer was seen doing on the wire:
//
//   * NAK ZERO (§5.5.6). With download solicitation enabled the analyzer
//     sends an N packet with SEQ 0 every 60 s whenever it is idle and can
//     accept sample programs, resuming one minute after a session ends. The
//     legacy capture holds 372 of them. It is a poll, not a NAK of anything
//     we sent, and it must never be answered: an unsolicited Y in reply is a
//     "valid packet but wrong place", after which the analyzer rejects the
//     next send-init with 0005 INVALID PACKET USAGE (fig. 5-15). Before this
//     was understood the second idle N(0) drew exactly that Y, and every first
//     download after ~2 minutes of quiet failed — 29 of 57 on 2026-09-11.
//   * Session contention (§5.6.7). If both stations send S at once the
//     analyzer abandons its upload and takes our download — but only while it
//     is still waiting for the Y to its own S. An S arriving any later in an
//     established session is fatal to that session. So we never start a
//     transfer once we have acknowledged the analyzer's S, and when the two S
//     packets genuinely cross we do what the spec assigns to the host: ignore
//     its S and wait for our Y. (Before this, an upload whose S had already
//     been acknowledged did not count as "in progress" until its first data
//     packet arrived, and our S went into the established session.)
//   * Busy / disabled (§5.6.4, §5.7.6). E 0000 RECEIVER BUSY means "try again
//     after a minute or longer"; E 0002 RECEIVER DISABLED means the operator
//     has RECEIVE TESTS off. Neither is a dead link — see KermitRejectedError.
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
  /**
   * An upload that goes silent for this long is abandoned so it cannot hold
   * our downloads forever. The analyzer retransmits every 13–25 s while it is
   * still trying, so a full minute of nothing means it has given up.
   * Default 60000.
   */
  receiveStallMs?: number;
  logger: Logger;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Our own capabilities, sent in our send-init and when we acknowledge the
 * analyzer's: MAXL 94, TIME 10, no padding, EOL CR, control quote '#', no 8-bit
 * prefixing, single-character checksum. These mirror what the VITROS itself
 * announces. Carrying them in our S matters: an S with no data makes the
 * analyzer fall back to TIME = "wait forever" for the rest of the session, so
 * a host that dies mid-download would leave it stuck in that session.
 */
const OUR_PARAMS_DATA = '~* @-#N1';

/** Per-attempt spacing on a retransmit. */
const RETRY_GAP_MS = 200;

/**
 * The analyzer answered a packet with an E packet. `code` is the four-digit
 * field from §5.7.6; `busy` marks the two codes that describe a receptive
 * analyzer that simply cannot take the file right now, so the caller can wait
 * rather than treat the link as broken.
 */
export class KermitRejectedError extends Error {
  readonly code: string;
  readonly busy: boolean;
  constructor(readonly detail: string) {
    super(`VITROS rejected the transfer: ${detail}`);
    this.name = 'KermitRejectedError';
    this.code = detail.slice(0, 4);
    this.busy = this.code === '0000' || this.code === '0002';
  }
}

export class KermitLink extends EventEmitter implements ProtocolLink {
  readonly name = 'kermit' as const;

  private readonly decoder = new KermitDecoder();
  /** Parameters in force. Replaced by whatever the peer negotiates. */
  private params: KermitParams = { ...DEFAULT_PARAMS };

  private sending = false;
  private ackWaiter: ((p: KermitPacket) => void) | null = null;

  // Receive-session accumulators. `rxActive` spans the analyzer's S through
  // its B (or E, or a stall) — the whole window in which our S would be fatal.
  private rxActive = false;
  private rxLastPacketAt = 0;
  private rxFileName = '';
  private rxData = '';
  private lastAckedSeq = -1;

  /** When the analyzer last solicited a download (NAK ZERO), epoch ms. */
  lastSolicitAt = 0;

  private txQueue: Promise<unknown> = Promise.resolve();
  private orderSequence = 0;
  /** When the last transfer, in either direction, finished — for the inter-transfer pause. */
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

  /** True while the analyzer is in the middle of sending us a file. */
  get receiving(): boolean {
    return this.rxActive;
  }

  // ---- inbound routing ------------------------------------------------------
  private onData(chunk: Buffer): void {
    for (const { packet, valid } of this.decoder.push(chunk)) {
      this.trace('IN', packet, valid);
      if (this.sending) {
        // Mid-transmit: every packet is an answer to what we just sent.
        this.ackWaiter?.(packet);
        continue;
      }
      if (!valid) {
        this.opts.logger.warn({ seq: packet.seq, type: packet.type }, 'Kermit checksum mismatch, sending NAK');
        this.write({ seq: packet.seq, type: 'N', data: '' });
        continue;
      }
      this.handleInbound(packet);
    }
  }

  private write(p: KermitPacket): void {
    this.trace('OUT', p, true);
    this.transport.write(encodePacket(p, this.params)).catch((e) => this.emit('error', e));
  }

  /** One line per packet, both directions, at debug — the only way to see WHY an E packet came. */
  private trace(direction: 'IN' | 'OUT', p: KermitPacket, valid: boolean): void {
    this.opts.logger.debug(
      { dir: direction, type: p.type, seq: p.seq, data: p.data, ...(valid ? {} : { badChecksum: true }) },
      'kermit packet',
    );
  }

  private handleInbound(p: KermitPacket): void {
    switch (p.type) {
      case 'N':
        // SEQ 0 while idle is NAK ZERO: "I can accept sample programs". Note
        // it, tell the orchestrator, and say nothing back — see the header.
        // Any other N outside a transmit is a stray retransmit.
        if (p.seq === 0 && !this.rxActive) {
          this.lastSolicitAt = Date.now();
          this.emit('solicit');
        }
        return;
      case 'Y':
        // A Y arriving while we are not transmitting is a stray retransmit.
        return;
      case 'E':
        this.emit('error', new Error(`VITROS sent a Kermit error packet: ${unquote(p.data, this.params.qctl)}`));
        // "The transmission or reception of an E packet always terminates an
        // existing session" (§5.7.6) — whatever it was sending is void.
        this.endReceive();
        return;
      default:
        break;
    }

    // A repeat of the packet we last acknowledged means our Y was lost. Answer
    // again, but do not fold the payload in a second time. (A repeated S is
    // handled in full below, so the fresh Y carries our parameters again.)
    if (p.seq === this.lastAckedSeq && p.type !== 'S') {
      this.write({ seq: p.seq, type: 'Y', data: '' });
      return;
    }

    this.rxLastPacketAt = Date.now();
    switch (p.type) {
      case 'S':
        // The analyzer opens a transfer and states its parameters; we answer
        // with ours, which is what a Kermit ACK-to-send-init must carry.
        this.params = parseSendInit(p.data);
        this.rxActive = true;
        this.rxFileName = '';
        this.rxData = '';
        this.write({ seq: p.seq, type: 'Y', data: OUR_PARAMS_DATA });
        break;
      case 'F':
        this.rxActive = true;
        this.rxFileName = unquote(p.data, this.params.qctl);
        this.rxData = '';
        this.write({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'D':
        this.rxData += unquote(p.data, this.params.qctl);
        this.write({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'Z':
        this.write({ seq: p.seq, type: 'Y', data: '' });
        break;
      case 'B':
        this.write({ seq: p.seq, type: 'Y', data: '' });
        this.finalizeReceive();
        // The session is over: nothing after this is a "repeat of the last
        // acknowledged packet", so leave lastAckedSeq cleared.
        return;
      default:
        return;
    }
    this.lastAckedSeq = p.seq;
  }

  private finalizeReceive(): void {
    const payload = this.rxData;
    const fileName = this.rxFileName;
    this.endReceive();
    if (!payload) return;

    this.emit('wire', { direction: 'IN', text: `${fileName}: ${payload}` });
    try {
      const msg = parseResultFile(payload);
      this.opts.logger.info({ file: fileName, results: msg.results.length }, 'VITROS 250 result file received');
      this.emit('message', msg);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Drop all receive-session state; the line is free again. */
  private endReceive(): void {
    if (this.rxActive) this.lastTransferEndedAt = Date.now();
    this.rxActive = false;
    this.rxData = '';
    this.rxFileName = '';
    this.lastAckedSeq = -1;
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
    // An upload can begin during the inter-transfer pause, so re-check the
    // line after waiting it out; the two waits only overlap for an instant.
    do {
      await this.awaitIdle();
      await this.awaitTransferGap();
    } while (this.rxActive);
    this.sending = true;
    this.emit('wire', { direction: 'OUT', text: `${fileName}: ${payload}` });
    try {
      await this.transmitFile(fileName, payload);
    } finally {
      this.sending = false;
      this.decoder.reset();
      this.lastTransferEndedAt = Date.now();
    }
  }

  private async transmitFile(fileName: string, payload: string): Promise<void> {
    let seq = 0;
    // Our parameters go in the send-init; the analyzer's acknowledgement
    // states the ones to use for the rest of the transfer, so negotiate before
    // chunking anything.
    const ack = await this.sendPacket({ seq: seq++, type: 'S', data: OUR_PARAMS_DATA });
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
    const want = p.seq % 64;
    const previous = (want + 63) % 64;
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      this.write(p);
      const deadline = Date.now() + this.opts.ackTimeoutMs;
      let reply = await this.waitAck(this.opts.ackTimeoutMs);

      // Two things can arrive that are not the answer yet still call for
      // no action but patience:
      //   - a late duplicate Y for the packet BEFORE this one — the analyzer
      //     re-acknowledging what it already has; resending on it would put a
      //     duplicate of THIS packet on the wire;
      //   - the analyzer's own S crossing ours — §5.6.7: it cancels its
      //     upload and acknowledges our download, so our Y is on its way.
      while (reply && Date.now() < deadline) {
        const staleY = reply.type === 'Y' && reply.seq === previous;
        const crossedS = reply.type === 'S' && p.type === 'S';
        if (!staleY && !crossedS) break;
        if (crossedS) this.opts.logger.info('VITROS 250 send-init crossed ours — it yields to the host; waiting for its Y');
        reply = await this.waitAck(deadline - Date.now());
      }

      if (!reply) {
        this.opts.logger.warn({ seq: p.seq, type: p.type, attempt }, 'Kermit ACK timeout — retransmitting');
        continue;
      }
      if (reply.type === 'Y' && reply.seq === want) return reply;
      if (reply.type === 'E') throw new KermitRejectedError(unquote(reply.data, this.params.qctl));
      this.opts.logger.warn(
        { sent: p.type, seq: p.seq, gotType: reply.type, gotSeq: reply.seq, attempt },
        'Kermit unexpected reply — retransmitting',
      );
      await delay(RETRY_GAP_MS);
    }
    throw new Error(`VITROS 250 did not acknowledge a ${p.type} packet after ${this.opts.maxRetries} attempts`);
  }

  private waitAck(timeoutMs: number): Promise<KermitPacket | null> {
    return new Promise<KermitPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiter = null;
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.ackWaiter = (packet) => {
        clearTimeout(timer);
        this.ackWaiter = null;
        resolve(packet);
      };
    });
  }

  /**
   * Let any inbound transfer finish before grabbing the line — from the
   * analyzer's S, not just from its first data packet. An upload that has
   * gone silent is abandoned after receiveStallMs so it cannot block us.
   */
  private async awaitIdle(): Promise<void> {
    const stallMs = this.opts.receiveStallMs ?? 60_000;
    while (this.rxActive) {
      if (Date.now() - this.rxLastPacketAt > stallMs) {
        this.opts.logger.warn(
          { file: this.rxFileName || null, silentMs: Date.now() - this.rxLastPacketAt },
          'VITROS 250 upload went silent — abandoning it so downloads can continue',
        );
        this.endReceive();
        break;
      }
      await delay(50);
    }
  }
}
