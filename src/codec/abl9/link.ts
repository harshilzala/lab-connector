import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import type { AstmDialect } from '../astm/records.js';
import { parseMessage } from '../astm/records.js';
import { ACK, EOT, SOH, ctrlName } from '../astm/control.js';

// =============================================================================
// Radiometer ABL9 blood gas — SOH…EOT record stream over TCP.
//
// This is NOT ASTM E1381, and that distinction is the whole reason this file
// exists. The ABL9's RECORDS are ordinary ASTM E1394 (H/P/O/R/C/L), so they are
// parsed by the shared record parser in ../astm/records.ts — but the LINK layer
// underneath them has no relation to E1381:
//
//     <SOH> H|\^&|||ABL9^403237|…<CR> P|…<CR> O|…<CR> R|…<CR> L|1|N<CR> <EOT>
//
// One message per SOH…EOT envelope, records separated by a bare CR, and the
// host answers with a single ACK. There is no ENQ handshake, no STX frames, no
// frame numbers and no checksums — so AstmLink cannot read it. AstmLink reacts
// only to ENQ, EOT and STX and drops every other byte as stray; fed this
// stream it discards the message one character at a time, then meets the EOT
// with its receive-mode flag still unset and finalises nothing. The connection
// looks healthy and not one result is ever parsed.
//
// MEASURED, not inferred — E:\Devices_Cancer\ABL9\Communi_Data.Log, 950 KB and
// one month of production traffic from the retired .NET middleware:
//
//     SOH   414        EOT   414        ACK   414 (in Cancer_ABL9.txt)
//     STX     0        ETX     0        ENQ     0        NAK   0
//     CR  23114, of which only 91 are CRLF — the separator is a bare CR
//     414 envelopes, each holding exactly ONE H| record
//
// Results-only. Communi_Data.Log holds 0 Q (query) records across that month,
// and the legacy host never transmitted anything but that one ACK byte, so
// sendOrders is deliberately a no-op rather than an unproven download path.
// =============================================================================

export interface Abl9LinkOptions {
  logger: Logger;
  /** Which record carries the barcode HMIS keys on. The ABL9 puts the ZC tube
   *  barcode on the P record and the patient MRN in the O record's specimen
   *  field — the opposite of every other analyzer here — so this is 'patient'.
   *  See `sampleIdFrom` in src/config.ts for the measurement behind that. */
  sampleIdFrom?: 'order' | 'patient';
  /** Only shapes order downloads, which this link never sends. Carried so the
   *  shared record parser is called exactly as AstmLink calls it. */
  dialect?: AstmDialect;
  /** Answer each completed envelope with a single ACK byte, as the legacy
   *  middleware did (414 ACKs for 414 messages). Off only for a bench replay
   *  where the far end is not expecting one. */
  ack?: boolean;
  /** Abandon a partial envelope that grows past this without an EOT, so a peer
   *  that opens a socket and streams noise cannot exhaust memory. The largest
   *  real envelope measured is 2.3 KB; the default leaves a wide margin. */
  maxBufferBytes?: number;
}

export class Abl9Link extends EventEmitter implements ProtocolLink {
  readonly name = 'abl9' as const;

  private rx = Buffer.alloc(0);
  private readonly onDataBound = (c: Buffer) => this.onData(c);

  constructor(private readonly transport: Transport, private readonly opts: Abl9LinkOptions) {
    super();
  }

  async start(): Promise<void> {
    this.transport.on('data', this.onDataBound);
    this.transport.on('error', (e: Error) => this.emit('error', e));
    // A dropped session must not leave half an envelope to be glued onto the
    // front of the next one — that would corrupt both.
    this.transport.on('close', () => this.discardPartial('the analyzer link closed'));
    await this.transport.start();
  }

  async stop(): Promise<void> {
    this.transport.off('data', this.onDataBound);
    await this.transport.stop();
  }

  /** Results-only instrument: it accepts no worklist and the legacy middleware
   *  never sent it one. Logged rather than thrown so a mis-set orderPoll cannot
   *  take the analyzer's results down with it. */
  async sendOrders(orders: OrderDownload[]): Promise<void> {
    this.opts.logger.warn(
      { orders: orders.length },
      'ABL9 accepts no order download — ignoring (set orderPoll.download=false and hostQuery=false)',
    );
  }

  // ---- inbound ---------------------------------------------------------------
  private onData(chunk: Buffer): void {
    this.rx = Buffer.concat([this.rx, chunk]);

    // Envelopes are consumed one at a time: a single TCP read can carry several,
    // and a single envelope can be split across several reads.
    for (;;) {
      const eot = this.rx.indexOf(EOT);
      if (eot === -1) break;
      const envelope = this.rx.subarray(0, eot);
      this.rx = this.rx.subarray(eot + 1);
      this.handleEnvelope(envelope);
    }

    const cap = this.opts.maxBufferBytes ?? 262144;
    if (this.rx.length > cap) {
      this.discardPartial(`no ${ctrlName(EOT)} within ${cap} bytes`);
    }
  }

  private handleEnvelope(envelope: Buffer): void {
    // Drop everything before the SOH. Anything ahead of it is not part of this
    // message — a stray keep-alive byte, or the tail of a session that was cut.
    const soh = envelope.indexOf(SOH);
    const body = (soh === -1 ? envelope : envelope.subarray(soh + 1)).toString('latin1');
    const records = body.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
    if (records.length === 0) return; // bare SOH EOT — nothing to file, nothing to ACK

    const raw = records.join('\r\n');
    // Emit the raw text BEFORE acknowledging: once the ACK goes out the analyzer
    // considers the message delivered and will not send it again, so the wire
    // log must already hold it even if parsing then fails.
    this.emit('wire', { direction: 'IN', text: raw });

    if (this.opts.ack !== false) {
      this.transport.write(Buffer.from([ACK])).catch((e) => this.emit('error', e));
      this.emit('wire', { direction: 'OUT', text: `<${ctrlName(ACK)}>` });
    }

    try {
      const msg = parseMessage(records, raw, this.opts.dialect, { sampleIdFrom: this.opts.sampleIdFrom });
      this.emit('message', msg);
    } catch (err) {
      // Not fatal: the raw text is already in the wire log, and the next
      // envelope must still be read.
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private discardPartial(why: string): void {
    if (this.rx.length === 0) return;
    this.opts.logger.warn({ bytes: this.rx.length, why }, 'discarding a partial ABL9 envelope');
    this.rx = Buffer.alloc(0);
  }
}
