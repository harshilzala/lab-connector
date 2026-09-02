import type { InstrumentResult, ParsedMessage, PatientDemographics } from '../../types.js';

// =============================================================================
// HL7 v2.x result parser (ORU^R01).
//
// Written against real Erba H360 traffic captured by the legacy middleware
// (E:\API_Integration\Devices\H360\H360.txt, bogg.log, arrOBX.log):
//
//   MSH|^~\&|H360|Erba|||20260609225133||ORU^R01|20260609_225044_797|P|2.3.1||||||UNICODE
//   PID|1
//   PV1|1
//   OBR|1||sf0024|01001^Automated Count^99MRC||20260609225951|20260609225951|...|HM|...|admin
//   OBX|7|NM|6690-2^WBC^LN||8.52|10*3/uL|3.50-9.50|~N|||F
//   OBX|29|IS|13112^Increased Mid Cells^99MRC||T||||||F
//
// Points that matter, all confirmed against the capture:
//   • the SAMPLE BARCODE is OBR-3 (filler order number), not PID-3 — the H360
//     leaves PID empty and puts the scanned tube id on the OBR;
//   • the ASSAY CODE the HMIS maps is the SECOND component of OBX-3 ("WBC",
//     "LYM%", "RDW-SD"), not the LOINC code in component 1. The legacy
//     middleware filed exactly those names (InsertData_Param.txt);
//   • OBX-8 carries repeats separated by "~" ("H~A", "~N"): the first
//     non-empty repeat is the abnormal flag;
//   • only OBX segments whose value type (OBX-2) is in `valueTypes` and whose
//     OBX-5 is non-empty become results. With the default ['NM'] that
//     reproduces the legacy filing set exactly — the 22 numeric CBC analytes,
//     without the IS-typed run modes, remarks and morphology alarm flags.
// =============================================================================

export interface Hl7Encoding {
  field: string;
  component: string;
  repeat: string;
  escape: string;
  subcomponent: string;
}

const DEFAULT_ENCODING: Hl7Encoding = { field: '|', component: '^', repeat: '~', escape: '\\', subcomponent: '&' };

export interface Hl7Segment {
  name: string;
  /** fields[n] is HL7 field n; fields[0] is the segment name. */
  fields: string[];
}

export interface Hl7Message {
  encoding: Hl7Encoding;
  segments: Hl7Segment[];
  /** MSH-9, e.g. "ORU^R01". */
  messageType: string;
  /** MSH-9 second component, e.g. "R01". */
  triggerEvent: string;
  /** MSH-10 — echoed back in the ACK's MSH-10 and MSA-2. */
  controlId: string;
  sendingApp: string; // MSH-3
  sendingFacility: string; // MSH-4
  version: string; // MSH-12
  charset: string; // MSH-18
  raw: string;
}

/** Split a raw HL7 message into segments, honouring the MSH-2 encoding chars. */
export function parseHl7(raw: string): Hl7Message {
  const text = raw.replace(/^[\x0b\x1c]+|[\x0b\x1c]+$/g, '');
  // Segments are CR-delimited; accept LF / CRLF from sloppy senders too.
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0]!.startsWith('MSH')) {
    throw new Error('not an HL7 message: no MSH segment');
  }

  const header = lines[0]!;
  const field = header[3] ?? '|';
  const encEnd = header.indexOf(field, 4);
  const encChars = header.slice(4, encEnd === -1 ? 8 : encEnd);
  const encoding: Hl7Encoding = {
    field,
    component: encChars[0] ?? DEFAULT_ENCODING.component,
    repeat: encChars[1] ?? DEFAULT_ENCODING.repeat,
    escape: encChars[2] ?? DEFAULT_ENCODING.escape,
    subcomponent: encChars[3] ?? DEFAULT_ENCODING.subcomponent,
  };

  const segments: Hl7Segment[] = lines.map((line) => {
    const parts = line.split(encoding.field);
    if (parts[0] === 'MSH') {
      // MSH-1 IS the field separator and MSH-2 the encoding characters, so the
      // split loses one position. Re-insert it to keep field numbering honest.
      return { name: 'MSH', fields: ['MSH', encoding.field, ...parts.slice(1)] };
    }
    return { name: parts[0] ?? '', fields: parts };
  });

  const msh = segments[0]!;
  const messageType = fieldOf(msh, 9);
  return {
    encoding,
    segments,
    messageType,
    triggerEvent: component(messageType, 2, encoding),
    controlId: fieldOf(msh, 10),
    sendingApp: fieldOf(msh, 3),
    sendingFacility: fieldOf(msh, 4),
    version: fieldOf(msh, 12),
    charset: fieldOf(msh, 18),
    raw: text,
  };
}

export interface Hl7ParseOptions {
  /** OBX-2 value types that become results. Empty array = accept every type. */
  valueTypes?: string[];
  /** Reported on each result as the source instrument. */
  instrument?: string | null;
}

/**
 * Turn a parsed ORU into the connector's neutral ParsedMessage.
 * Returns null when the message carries no filable result.
 */
export function hl7ToParsedMessage(msg: Hl7Message, opts: Hl7ParseOptions = {}): ParsedMessage | null {
  const enc = msg.encoding;
  const accepted = (opts.valueTypes ?? ['NM']).map((t) => t.trim().toUpperCase()).filter(Boolean);

  let patient: PatientDemographics | null = null;
  let sampleId = '';
  let obrTime: string | null = null;
  const results: InstrumentResult[] = [];

  for (const seg of msg.segments) {
    switch (seg.name) {
      case 'PID':
        patient = readPid(seg, enc) ?? patient;
        break;
      case 'OBR':
        // OBR-3 (filler order number) is the tube barcode; OBR-2 (placer) is the
        // fallback for an analyzer that fills the other one.
        sampleId = component(fieldOf(seg, 3), 1, enc) || component(fieldOf(seg, 2), 1, enc) || sampleId;
        obrTime = fieldOf(seg, 7) || fieldOf(seg, 6) || null;
        break;
      case 'OBX': {
        const valueType = fieldOf(seg, 2).trim().toUpperCase();
        const value = fieldOf(seg, 5).trim();
        if (!value) break;
        if (accepted.length > 0 && !accepted.includes(valueType)) break;

        const identifier = fieldOf(seg, 3);
        // Component 2 is the analyzer's own mnemonic ("WBC"); fall back to the
        // coded value in component 1 when the analyzer sends no text.
        const testCode = component(identifier, 2, enc) || component(identifier, 1, enc);
        if (!testCode) break;

        results.push({
          sampleId,
          testCode,
          value,
          unit: fieldOf(seg, 6) || null,
          referenceRange: fieldOf(seg, 7) || null,
          abnormalFlag: firstRepeat(fieldOf(seg, 8), enc),
          status: fieldOf(seg, 11) || 'F',
          completedAt: fieldOf(seg, 14) || obrTime,
          instrument: opts.instrument ?? msg.sendingApp ?? null,
        });
        break;
      }
      default:
        break;
    }
  }

  // OBX segments that arrived before their OBR (or an analyzer that only puts
  // the id on a later OBR) would otherwise carry an empty barcode.
  if (sampleId) for (const r of results) if (!r.sampleId) r.sampleId = sampleId;

  const filable = results.filter((r) => r.sampleId);
  if (filable.length === 0) return null;

  return {
    protocol: 'hl7',
    sender: msg.sendingApp || null,
    patient,
    queries: [], // ORU is an unsolicited upload; the H360 never host-queries.
    results: filable,
    raw: msg.raw,
  };
}

// ---- field helpers ---------------------------------------------------------
export function fieldOf(seg: Hl7Segment, n: number): string {
  return (seg.fields[n] ?? '').trim();
}

/** 1-based component of a field ("6690-2^WBC^LN", 2) → "WBC". */
export function component(field: string, n: number, enc: Hl7Encoding): string {
  return (field.split(enc.component)[n - 1] ?? '').trim();
}

/** First non-empty repeat of a field: "H~A" → "H", "~N" → "N", "" → null. */
function firstRepeat(field: string, enc: Hl7Encoding): string | null {
  for (const part of field.split(enc.repeat)) {
    const v = part.trim();
    if (v) return v;
  }
  return null;
}

function readPid(seg: Hl7Segment, enc: Hl7Encoding): PatientDemographics | null {
  const id = component(fieldOf(seg, 3), 1, enc) || fieldOf(seg, 2);
  const name = fieldOf(seg, 5);
  const sexRaw = fieldOf(seg, 8).toUpperCase();
  const sex = sexRaw === 'M' || sexRaw === 'F' ? sexRaw : sexRaw ? 'O' : null;
  const birthDate = fieldOf(seg, 7).slice(0, 8) || null;
  if (!id && !name && !sex && !birthDate) return null;
  return {
    patientId: id || null,
    lastName: component(name, 1, enc) || null,
    firstName: component(name, 2, enc) || null,
    middleName: component(name, 3, enc) || null,
    sex,
    birthDate,
  };
}
