import type { OrderDownload } from '../../types.js';
import { component, fieldOf, type Hl7Message } from './parser.js';

// =============================================================================
// HL7 ORDER PUSH — an unsolicited order message, host → middleware.
//
// Written for IM, the instrument middleware that fronts the chemistry /
// immunoassay line. IM does not dial the connector and does not host-query:
// it LISTENS (10.11.4.231:10011 at Ahmedabad) and takes every order the LIS
// sends it, the feed Mirth used to carry. The connector now reads the orders
// from HMIS itself and sends them here.
//
//   LIS → IM   VT MSH|^~\&|HMIS-LIS||IM||<now>||ORM^O01|<ctrlId>|P|2.3.1
//                 PID|1||<mrn>||<last>^<first>^<middle>||<dob>|<sex>
//                 ORC|NW|<barcode>|<barcode>||||^^^^^R||<now>
//                 OBR|1|<barcode>|<barcode>|TSH3|R||||||||||Serum|||||||||||^^^^^R
//                 ORC|NW|…  OBR|2|…                                   FS CR
//   IM → LIS   VT MSH|…|ACK|<its id>|P|2.3.1
//                 MSA|AA|<ctrlId>                                     FS CR
//
// The order is not counted as delivered until that MSA arrives and says AA
// (or CA). AE / AR / CE / CR, or no answer inside the timeout, fails the
// send, so the order stays un-downloaded in the order store and the next
// poll offers it again.
//
// WHAT IS CONFIRMED AND WHAT IS NOT. On 2026-09-27 the port accepted a TCP
// connection from this PC and did not answer an ASTM ENQ, which rules out
// ASTM E1381 framing. No capture of the Mirth feed was available, so the
// layout below is the HL7 v2 standard one, with the barcode in BOTH the
// placer and the filler order number (ORC-2/3, OBR-2/3) because receivers
// differ on which of the two they read as the specimen id. Anything IM
// turns out to want differently is a setting in `hl7.orderPush`, not an
// edit here: message type, version and the application names.
// =============================================================================

export type Hl7OrderMessageType = 'ORM^O01' | 'OML^O21';

export interface Hl7OrderPushOptions {
  /** ORM^O01 (general order, any v2.x) or OML^O21 (laboratory order, v2.4+,
   *  which also carries an SPM specimen segment). */
  messageType: Hl7OrderMessageType;
  /** MSH-12. */
  version: string;
  /** MSH-3 / MSH-4 — who is sending. */
  sendingApp: string;
  sendingFacility: string;
  /** MSH-5 / MSH-6 — who it is for. */
  receivingApp: string;
  receivingFacility: string;
  /** MSH-11: P production, T training, D debugging. */
  processingId: string;
  /** MSH-18; left out when empty. */
  charset: string;
}

const FIELD = '|';
const COMPONENT = '^';
const ENCODING_CHARS = '^~\\&';

/**
 * Escape the HL7 delimiters in free text. A name or a specimen description
 * carrying a "|" or a "^" must not be able to move every field after it one
 * place to the right.
 */
export function escapeHl7(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/&/g, '\\T\\')
    .replace(/~/g, '\\R\\')
    .replace(/[\r\n\x0b\x1c]+/g, ' ')
    .trim();
}

/** yyyyMMddHHmmss, local time — the same clock the rest of the link stamps. */
export function hl7Stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Build one order message for one tube.
 *
 * Every test is its own ORC/OBR pair, numbered from 1, all under one MSH: the
 * receiver acknowledges the tube once, and a tube is either on the worklist
 * whole or not at all.
 */
export function buildOrderPush(order: OrderDownload, opts: Hl7OrderPushOptions, controlId: string, now = new Date()): string {
  const stamp = hl7Stamp(now);
  const sid = escapeHl7(order.sampleId);
  const priority = order.priority === 'S' ? 'S' : 'R';
  const timing = ['', '', '', '', '', priority].join(COMPONENT); // TQ.6 priority
  const specimen = escapeHl7(order.specimenType);
  const collected = (order.collectedAt ?? '').replace(/\D/g, '').slice(0, 14);
  const oml = opts.messageType === 'OML^O21';

  const msh = [
    'MSH',
    ENCODING_CHARS,
    escapeHl7(opts.sendingApp),
    escapeHl7(opts.sendingFacility),
    escapeHl7(opts.receivingApp),
    escapeHl7(opts.receivingFacility),
    stamp,
    '',
    oml ? 'OML^O21^OML_O21' : 'ORM^O01',
    controlId,
    opts.processingId || 'P',
    opts.version,
  ];
  if (opts.charset) msh.push('', '', '', '', '', opts.charset); // MSH-13..17 empty, MSH-18
  const segs = [msh.join(FIELD)];

  // PID is always sent: a receiver that files the order under a patient needs
  // the segment to exist even when the demographics are withheld.
  const p = order.patient;
  if (p) {
    const name = [escapeHl7(p.lastName), escapeHl7(p.firstName), escapeHl7(p.middleName)].join(COMPONENT).replace(/\^+$/, '');
    const sex = p.sex === 'M' || p.sex === 'F' ? p.sex : p.sex ? 'O' : '';
    const birth = (p.birthDate ?? '').replace(/\D/g, '').slice(0, 8);
    segs.push(['PID', '1', '', escapeHl7(p.patientId), '', name, '', birth, sex].join(FIELD));
  } else {
    segs.push(['PID', '1'].join(FIELD));
  }

  let setId = 0;
  for (const raw of order.testCodes) {
    const code = escapeHl7(raw);
    if (!code) continue;
    setId += 1;
    // ORC-1 NW new order · ORC-2 placer · ORC-3 filler · ORC-7 timing · ORC-9 when
    segs.push(['ORC', 'NW', sid, sid, '', '', '', timing, '', stamp].join(FIELD));
    // OBR-4 test · OBR-5 priority · OBR-7 collected · OBR-15 specimen · OBR-27 timing
    const obr = ['OBR', String(setId), sid, sid, code, priority, '', collected, '', '', '', '', '', '', '', specimen];
    while (obr.length < 27) obr.push('');
    obr.push(timing);
    segs.push(obr.join(FIELD));
    // SPM-2 specimen id · SPM-4 specimen type — OML only.
    if (oml) segs.push(['SPM', String(setId), sid, '', specimen].join(FIELD));
  }
  if (setId === 0) throw new Error(`order for ${order.sampleId} has no tests to send`);
  return segs.join('\r') + '\r';
}

export interface Hl7Ack {
  /** MSA-2 — the control id of the message being answered. */
  controlId: string;
  /** MSA-1: AA, AE, AR, CA, CE, CR. */
  code: string;
  accepted: boolean;
  /** MSA-3 and any ERR text, for the log. */
  text: string;
}

/**
 * Read an acknowledgement. Null when the message is not one — an ORU that
 * happens to arrive while an order is waiting for its answer must go down
 * the results path, not be mistaken for a reply.
 */
export function readAck(msg: Hl7Message): Hl7Ack | null {
  const msa = msg.segments.find((s) => s.name === 'MSA');
  if (!msa) return null;
  const code = fieldOf(msa, 1).toUpperCase();
  const err = msg.segments
    .filter((s) => s.name === 'ERR')
    .map((s) => s.fields.slice(1).filter(Boolean).join(' '))
    .filter(Boolean);
  const text = [fieldOf(msa, 3), ...err].filter(Boolean).join(' — ');
  return {
    controlId: component(fieldOf(msa, 2), 1, msg.encoding),
    code,
    accepted: code === 'AA' || code === 'CA',
    text,
  };
}

/**
 * The receiver answered, and the answer was no. Distinct from a timeout or a
 * dropped socket: the link is alive and the message was read, so this says
 * something about ONE order and nothing about the line.
 */
export class Hl7OrderRejected extends Error {
  /** Read by the orchestrator: a rejection must not open the download breaker. */
  readonly linkAlive = true as const;
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`receiver answered ${code || 'a rejection'}${detail ? `: ${detail}` : ''}`);
    this.name = 'Hl7OrderRejected';
  }
}
