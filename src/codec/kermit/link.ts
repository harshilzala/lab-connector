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
// =============================================================================

export interface KermitLinkOptions {
  /** How long to wait for a Y before retransmitting a packet. */
  ackTimeoutMs: number;
  /** Retransmissions per packet before the transfer is abandoned. */
  maxRetries: number;
  logger: Logger;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Our own capabilities, announced when we acknowledge the analyzer's send-init:
 * MAXL 94, TIME 10, no padding, EOL CR, control quote '#', no 8-bit prefixing,
 * single-character checksum. These mirror what the VITROS itself announces.
 */
const OUR_PARAMS_DATA = '~* @-#N1';

export class KermitLink extends EventEmitter implements ProtocolLink {
  readonly name = 'kermit' as const;

  private readonly decoder = new KermitDecoder();
  /** Parameters in force. Replaced by whatever the peer negotiates. */
  private params: KermitParams = { ...DEFAULT_PARAMS };

  private sending = false;
  private ackWaiter: ((p: KermitPacket) => void) | null = null;

  // Receive-session accumulators.
  private rxFileName = '';
  private rxData = '';
  private lastAckedSeq = -1;

  private txQueue: Promise<unknown> = Promise.resolve();
  private orderSequence = 0;

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
    for (const { packet, valid } of this.decoder.push(chunk)) {
      if (this.sending) {
        // Mid-transmit: every packet is an answer to what we just sent.
        this.ackWaiter?.(packet);
        continue;
      }
      if (!valid) {
        this.opts.logger.warn({ seq: packet.seq, type: packet.type }, 'Kermit checksum mismatch → NAK');
        this.write({ seq: packet.seq, type: 'N', data: '' });
        continue;
      }
      this.handleInbound(packet);
    }
  }

  private write(p: KermitPacket): void {
    this.transport.write(encodePacket(p, this.params)).catch((e) => this.emit('error', e));
  }

  private handleInbound(p: KermitPacket): void {
    // A repeat of the packet we last acknowledged means our Y was lost. Answer
    // again, but do not fold the payload in a second time.
    if (p.seq === this.lastAckedSeq && p.type !== 'S') {
      this.write({ seq: p.seq, type: 'Y', data: '' });
      return;
    }

    switch (p.type) {
      case 'S':
        // The analyzer opens a transfer and states its parameters; we answer
        // with ours, which is what a Kermit ACK-to-send-init must carry.
        this.params = parseSendInit(p.data);
        this.rxFileName = '';
        this.rxData = '';
        this.write({ seq: p.seq, type: 'Y', data: OUR_PARAMS_DATA });
        break;
      case 'F':
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
        break;
      case 'E':
        this.emit('error', new Error(`VITROS sent a Kermit error packet: ${unquote(p.data, this.params.qctl)}`));
        break;
      default:
        // Y/N arriving while we are not transmitting is a stray retransmit.
        break;
    }
    this.lastAckedSeq = p.seq;
  }

  private finalizeReceive(): void {
    const payload = this.rxData;
    const fileName = this.rxFileName;
    this.rxData = '';
    this.rxFileName = '';
    this.lastAckedSeq = -1;
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
    this.sending = true;
    this.emit('wire', { direction: 'OUT', text: `${fileName}: ${payload}` });
    try {
      let seq = 0;
      // Send-init carries no data, matching the host the analyzer has accepted
      // for years; the analyzer's acknowledgement states the parameters to use
      // for the rest of the transfer, so negotiate before chunking anything.
      const ack = await this.sendPacket({ seq: seq++, type: 'S', data: '' });
      if (ack.data) this.params = parseSendInit(ack.data);

      await this.sendPacket({ seq: seq++, type: 'F', data: quote(fileName, this.params.qctl) });
      for (const chunk of chunkPayload(payload, this.params)) {
        await this.sendPacket({ seq: seq++, type: 'D', data: chunk });
      }
      await this.sendPacket({ seq: seq++, type: 'Z', data: '' });
      await this.sendPacket({ seq: seq++, type: 'B', data: '' });
    } finally {
      this.sending = false;
      this.decoder.reset();
    }
  }

  /** Transmit one packet and wait for its Y, retransmitting on NAK or silence. */
  private async sendPacket(p: KermitPacket): Promise<KermitPacket> {
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      this.transport.write(encodePacket(p, this.params)).catch((e) => this.emit('error', e));
      const reply = await this.waitAck(this.opts.ackTimeoutMs);

      if (!reply) {
        this.opts.logger.warn({ seq: p.seq, type: p.type, attempt }, 'Kermit ACK timeout — retransmitting');
        continue;
      }
      if (reply.type === 'Y' && reply.seq === p.seq % 64) return reply;
      if (reply.type === 'E') {
        throw new Error(`VITROS rejected the transfer: ${unquote(reply.data, this.params.qctl)}`);
      }
      this.opts.logger.warn(
        { sent: p.type, seq: p.seq, gotType: reply.type, gotSeq: reply.seq, attempt },
        'Kermit unexpected reply — retransmitting',
      );
      await delay(200);
    }
    throw new Error(`VITROS 250 did not acknowledge a ${p.type} packet after ${this.opts.maxRetries} attempts`);
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
