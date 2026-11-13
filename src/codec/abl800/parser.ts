import type { InstrumentResult, ParsedMessage } from '../../types.js';
import { component, fieldOf, parseHl7, type Hl7Message } from '../hl7/parser.js';

// =============================================================================
// Radiometer ABL800 FLEX (ABL835) — HL7 v2.5 ORU^R31 result parser.
//
// From the legacy Lab Integration.exe capture at Ahmedabad (ABL800.txt,
// Aug–Nov 2026, ~3 500 samples). Each message travels inside SOH … EOT:
//
//   SOH MSH|^~\&|ABL835^ZYDUS HOSPITAL-AHD|ABL835^…|||20261112202629||ORU^R31|601|P|2.5|||AL|NE
//       PID|1||LB2611120712||^|…
//       PV1|1|U|…
//       ORC|NW|…
//       OBR|1|||Syringe^|||…|BLDA^^^LLFA^^^P|^||||||20261112201500|||F|…
//       OBX|1|ST|^^^pO2^M||164|mmHg||H|||F|||20261112201500|…
//       NTE|1|L|83^
//       OBX|2|ST|^^^pCO2^M||39.3|mmHg||N|||F|…
//       …                                                              EOT
//
// Differences from the H360-style HL7 parser, and why this one exists:
//   • the BARCODE is PID-3 (OBR-2/3 are empty);
//   • the PARAMETER is the 4th component of OBX-3 ("^^^pO2^M"); the 5th says
//     how it was obtained: M measured, C calculated, I entered (T, FIO2),
//     E estimated;
//   • every value is type ST, and a parameter the run did not produce is
//     sent as dots (".....").
// =============================================================================

export const SOH = 0x01;
export const EOT = 0x04;

/** A value the analyzer sends when the parameter has no result. */
const NO_VALUE = /^[.\-?*]*$/;

export interface Abl800Result {
  message: ParsedMessage | null;
  hl7: Hl7Message;
  /** PID-3 as sent — the tube barcode, or an operator-typed name. */
  barcode: string;
  /** OBX lines skipped because the value was empty or dots. */
  skipped: string[];
}

export function parseAbl800(text: string): Abl800Result {
  const hl7 = parseHl7(text);
  const enc = hl7.encoding;
  let barcode = '';
  let obrTime: string | null = null;
  const results: InstrumentResult[] = [];
  const skipped: string[] = [];

  for (const seg of hl7.segments) {
    if (seg.name === 'PID') {
      barcode = component(fieldOf(seg, 3), 1, enc) || barcode;
    } else if (seg.name === 'OBR') {
      barcode = barcode || component(fieldOf(seg, 3), 1, enc) || component(fieldOf(seg, 2), 1, enc);
      obrTime = fieldOf(seg, 22) || fieldOf(seg, 7) || obrTime;
    } else if (seg.name === 'OBX') {
      const id = fieldOf(seg, 3);
      const code = component(id, 4, enc) || component(id, 2, enc) || component(id, 1, enc);
      const value = fieldOf(seg, 5);
      if (!code) continue;
      if (NO_VALUE.test(value)) {
        skipped.push(code);
        continue;
      }
      results.push({
        sampleId: '',
        testCode: code,
        value,
        unit: fieldOf(seg, 6) || null,
        referenceRange: fieldOf(seg, 7) || null,
        abnormalFlag: fieldOf(seg, 8).split(enc.repeat)[0]?.trim() || null,
        status: fieldOf(seg, 11) || 'F',
        completedAt: fieldOf(seg, 14) || null,
        instrument: 'ABL800',
      });
    }
  }

  for (const r of results) {
    r.sampleId = barcode;
    r.completedAt = r.completedAt || obrTime;
  }

  const message: ParsedMessage | null =
    barcode && results.length
      ? { protocol: 'abl800', sender: hl7.sendingApp || 'ABL800', patient: null, queries: [], results, raw: text }
      : null;
  return { message, hl7, barcode, skipped };
}

/** The HL7 acknowledgement for one ABL message: MSA-2 echoes its MSH-10. */
export function abl800Ack(hl7: Hl7Message, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const trigger = hl7.triggerEvent || 'R31';
  return [
    ['MSH', '^~\\&', 'LIS', '', hl7.sendingApp, hl7.sendingFacility, stamp, '', `ACK^${trigger}`, hl7.controlId || stamp, 'P', hl7.version || '2.5'].join('|'),
    ['MSA', 'AA', hl7.controlId].join('|'),
  ].join('\r') + '\r';
}
