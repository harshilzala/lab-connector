import type { InstrumentResult } from '../../types.js';

// =============================================================================
// Alifax ROLLER 20LC (ESR) — serial message parser.
//
// Source: ROLLER 20LC Technical Manual rev 1.3 (2016-05-06), ch. 24 "RS232
// protocol description" and "Query process", pp. 77–82. Serial port 2,
// 9600 8-N-1. Every message is  STX <body> <checksum> ETX :
//
//   'R' result  (DAT15 / BCI, 31 chars on the wire)
//     R  ws(2)  sampleId(15)  rack(2) position(2) cycle(2)  result(4)
//   'R' result  (DAT08, 24 chars — old systems only)
//     R  ws(2)  sampleId(8)   rack(2) position(2) cycle(2)  result(4)
//   'Q' query from the analyzer (BCI only, 25 chars)
//     Q  ws(2)  sampleId(15)  result(4)
//
// Checksum: XOR of every body character (between STX and the checksum);
// a value of 0x00 / 0x02 / 0x03 is sent as 0x7F. Confirmed against the
// manual's latex and patient examples.
//
// Result field (4 chars):
//   "0012"  ESR 12 mm/h (manual range 0002–0120)
//   "*015"  valid ESR, very low haematocrit (~20%) — "*" option in TECH MENU
//   "-004", "0-04", "--01"  instrument error (SM / NR / NF …) — no result
//
// Latex controls arrive as 'R' messages whose sample id starts with "LATEX"
// (LATEXSTDLn… calibration-control kit, LATEX0<lot>n… control kit).
// =============================================================================

export const STX = 0x02;
export const ETX = 0x03;
export const ACK = 0x06;
export const NAK = 0x15;

export const ROLLER_TEST_CODE = 'ESR';
export const ROLLER_UNIT = 'mm/h';

const WS = 2;
const TAIL = 2 + 2 + 2 + 4; // rack, position, cycle, result
const RESULT_BODY_DAT15 = 1 + WS + 15 + TAIL; // 28
const RESULT_BODY_DAT08 = 1 + WS + 8 + TAIL; // 21
const QUERY_BODY = 1 + WS + 15 + 4; // 22

/** XOR checksum over the body, with the manual's 0x00/0x02/0x03 → 0x7F rule. */
export function rollerChecksum(body: string): number {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i) & 0xff;
  return c === 0x00 || c === 0x02 || c === 0x03 ? 0x7f : c;
}

/** Build a framed message (STX body checksum ETX) — used for 'T' replies and tests. */
export function frameRoller(body: string): Buffer {
  return Buffer.from(`\x02${body}${String.fromCharCode(rollerChecksum(body))}\x03`, 'latin1');
}

export type RollerOutcome = 'value' | 'low-hematocrit' | 'error';

export interface RollerResultMessage {
  kind: 'result';
  workstation: string;
  sampleId: string;
  rack: string;
  position: string;
  cycle: string;
  /** The 4-char result field exactly as sent. */
  rawResult: string;
  outcome: RollerOutcome;
  /** ESR in mm/h with leading zeros stripped ("12"); null on an error. */
  value: string | null;
  /** Latex control / calibration run (sample id starts with LATEX). */
  isQc: boolean;
  format: 'DAT15' | 'DAT08';
}

export interface RollerQueryMessage {
  kind: 'query';
  workstation: string;
  sampleId: string;
}

export type RollerMessage = RollerResultMessage | RollerQueryMessage;

export interface ParsedFrame {
  message: RollerMessage | null;
  checksumOk: boolean;
  /** Why the frame could not be read, when message is null. */
  reason?: string;
}

/**
 * Parse one frame's content — everything between STX and ETX, checksum
 * included as the last character.
 */
export function parseRollerFrame(inner: string): ParsedFrame {
  if (inner.length < 2) return { message: null, checksumOk: false, reason: `frame too short (${inner.length} chars)` };
  const body = inner.slice(0, -1);
  const sent = inner.charCodeAt(inner.length - 1) & 0xff;
  const checksumOk = rollerChecksum(body) === sent;
  const type = body[0];

  if (type === 'R') {
    let idWidth: number;
    let format: 'DAT15' | 'DAT08';
    if (body.length === RESULT_BODY_DAT15) {
      idWidth = 15;
      format = 'DAT15';
    } else if (body.length === RESULT_BODY_DAT08) {
      idWidth = 8;
      format = 'DAT08';
    } else {
      return {
        message: null,
        checksumOk,
        reason: `R message body is ${body.length} chars; expected ${RESULT_BODY_DAT15} (DAT15/BCI) or ${RESULT_BODY_DAT08} (DAT08)`,
      };
    }
    let pos = 1;
    const take = (w: number) => {
      const s = body.slice(pos, pos + w);
      pos += w;
      return s;
    };
    const workstation = take(WS);
    const sampleId = take(idWidth).trim();
    const rack = take(2);
    const position = take(2);
    const cycle = take(2);
    const rawResult = take(4);
    const { outcome, value } = readResult(rawResult);
    return {
      checksumOk,
      message: {
        kind: 'result',
        workstation,
        sampleId,
        rack,
        position,
        cycle,
        rawResult,
        outcome,
        value,
        isQc: /^LATEX/i.test(sampleId),
        format,
      },
    };
  }

  if (type === 'Q') {
    if (body.length !== QUERY_BODY) {
      return { message: null, checksumOk, reason: `Q message body is ${body.length} chars; expected ${QUERY_BODY}` };
    }
    return {
      checksumOk,
      message: { kind: 'query', workstation: body.slice(1, 1 + WS), sampleId: body.slice(1 + WS, 1 + WS + 15).trim() },
    };
  }

  return { message: null, checksumOk, reason: `unknown message type ${JSON.stringify(type)}` };
}

/** The 'T' reply to a query: "0001" = run the tube, "0000" = do not. */
export function rollerQueryReply(workstation: string, sampleId: string, run: boolean): Buffer {
  return frameRoller(`T${workstation.padEnd(WS, '0').slice(0, WS)}${sampleId.padEnd(15, ' ').slice(0, 15)}${run ? '0001' : '0000'}`);
}

function readResult(raw: string): { outcome: RollerOutcome; value: string | null } {
  if (raw.includes('-')) return { outcome: 'error', value: null };
  const lowHct = raw.startsWith('*');
  const digits = (lowHct ? raw.slice(1) : raw).trim();
  if (!/^\d+$/.test(digits)) return { outcome: 'error', value: null };
  return { outcome: lowHct ? 'low-hematocrit' : 'value', value: String(Number.parseInt(digits, 10)) };
}

/** One InstrumentResult for a parsed result message that carries a value. */
export function toInstrumentResult(m: RollerResultMessage, instrument = 'ROLLER20LC'): InstrumentResult {
  return {
    sampleId: m.sampleId,
    testCode: ROLLER_TEST_CODE,
    value: m.value ?? '',
    unit: ROLLER_UNIT,
    referenceRange: null,
    abnormalFlag: m.outcome === 'low-hematocrit' ? 'A' : null,
    status: 'F',
    completedAt: null,
    instrument,
  };
}
