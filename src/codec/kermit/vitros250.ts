import type { InstrumentResult, OrderDownload, ParsedMessage } from '../../types.js';

// =============================================================================
// VITROS 250 / 350 PAYLOAD FORMAT
//
// What the Kermit layer carries is not a record language like ASTM — it is a
// FIXED-WIDTH file. Field boundaries are byte offsets, so a single missing or
// extra character silently shifts everything after it.
//
// Every layout below is derived from the lab's own captured traffic and checked
// across the whole capture rather than a sample: 1,353 order transmissions and
// 1,785 result records. Where a field is written as a constant, that constant
// held for every record in the capture — the counts are noted so a future
// reader knows how much evidence stands behind each one.
//
// TEST CODES ARE CHARACTERS. A VITROS assay code is a small integer sent as a
// single byte: code 76 travels as 'L', code 90 as 'Z', code 32 as a SPACE.
// That last one matters — a test code can legitimately be a space, so the test
// list must never be trimmed.
// =============================================================================

/** Offsets shared by both directions. */
const SAMPLE_FIELD = 15;
/** Right-aligned patient name on an order. */
const NAME_FIELD = 25;
/** Ends the test list (order) and the result list (results). */
const LIST_END = '|';
/** Ends one record; several records may be concatenated in one file. */
const RECORD_END = ']';

// -----------------------------------------------------------------------------
// Order download  (host -> analyzer), carried as the file "SFILE<n>.D"
//
//    "   SF260831002810 1.000L3f1;Z.|               SUMANVERMA]"
//     |______________||||_____|______||_______________________|
//     sample id (15)   ^^ ^    tests   patient name (25, right)
//                      || dilution
//                      |single space
//                      "10"
//
// The "10", the single space, the "1.000" dilution and the 25-wide name field
// were identical in all 1,353 captured orders.
// -----------------------------------------------------------------------------

/** Constant block between the sample id and the test list. */
const ORDER_PREFIX = '10 1.000';

export function orderFileName(sequence: number): string {
  // The legacy host cycles SFILE1.D … SFILE8.D; the analyzer treats the name as
  // an identifier for the transfer, not as storage.
  return `SFILE${((sequence - 1) % 8) + 1}.D`;
}

/** Encode a numeric VITROS assay code as its single wire character. */
export function encodeTestCode(code: string): string | null {
  const n = Number(code);
  if (!Number.isInteger(n) || n < 1 || n > 126) return null;
  return String.fromCharCode(n);
}

/** Decode a wire character back to the numeric assay code the HMIS knows. */
export const decodeTestCode = (ch: string): string => String(ch.charCodeAt(0));

/** Flatten a patient name the way the analyzer's 25-column field expects. */
function flatName(o: OrderDownload): string {
  const p = o.patient;
  if (!p) return '';
  const joined = [p.lastName ?? '', p.firstName ?? '', p.middleName ?? ''].join('');
  // WHITESPACE ONLY — nothing else is touched. "MOTIBHAI M CHAUDHARY" goes on
  // the wire as "MOTIBHAIMCHAUDHARY", but punctuation and case both survive:
  // the capture carries "KAPILKUMAR." and "MrsJANAKBANARENDRASINHCHU", so
  // stripping periods or upper-casing each broke real orders in the corpus
  // replay. The names simply arrive already upper-cased from the HMIS.
  return joined.replace(/\s+/g, '').slice(0, NAME_FIELD);
}

export function buildOrderRecord(order: OrderDownload): string {
  const codes = order.testCodes.map(encodeTestCode).filter((c): c is string => c !== null).join('');
  return (
    order.sampleId.slice(0, SAMPLE_FIELD).padStart(SAMPLE_FIELD) +
    ORDER_PREFIX +
    codes +
    LIST_END +
    flatName(order).padStart(NAME_FIELD) +
    RECORD_END
  );
}

/**
 * Read an order record back apart. The connector never needs this to talk to
 * the analyzer — it exists so a captured download can be round-tripped through
 * `buildOrderRecord` and proved identical, and so a simulator can replay one.
 */
export function parseOrderRecord(rec: string): { sampleId: string; testCodes: string[]; name: string } | null {
  const listEnd = rec.lastIndexOf(LIST_END);
  const recEnd = rec.lastIndexOf(RECORD_END);
  if (listEnd === -1 || recEnd === -1 || recEnd < listEnd) return null;
  const head = rec.slice(0, SAMPLE_FIELD + ORDER_PREFIX.length);
  if (!head.endsWith(ORDER_PREFIX)) return null;
  return {
    sampleId: rec.slice(0, SAMPLE_FIELD).trim(),
    // Never trim this slice: assay code 32 is a legitimate SPACE.
    testCodes: [...rec.slice(SAMPLE_FIELD + ORDER_PREFIX.length, listEnd)].map(decodeTestCode),
    name: rec.slice(listEnd + 1, recEnd).trim(),
  };
}

/** Assay codes this build dropped because they are not encodable as one byte. */
export function unencodableTestCodes(order: OrderDownload): string[] {
  return order.testCodes.filter((c) => encodeTestCode(c) === null);
}

// -----------------------------------------------------------------------------
// Result upload  (analyzer -> host), carried as the file "R<nnnnnnn>"
//
//   "1131410831               SF2608310014   10%41.000LNO RESULT060MENSPF}…|**250*    ]"
//    |________||_____________||_____________||||^|____||________________|  |__________|
//    HHMMSSMMDD  operator (15)  sample (15)   ^ ^ dilution  result blocks     trailer
//                                             | |fluid type
//                                             |"10"     ^sequence
//
// Each result block is:  <test char><value, 9 wide><alarm flags><'}'>
// The alarm field is variable width, which is why '}' terminates the block
// rather than a fixed offset.
// -----------------------------------------------------------------------------

const OFF_STAMP = 0;
const OFF_OPERATOR = 10;
const OFF_SAMPLE = 25;
const OFF_SEQUENCE = 42;
const OFF_FLUID = 43;
const OFF_RESULTS = 49;
/** Width of the numeric result inside a block. */
const VALUE_WIDTH = 9;
/** Alarm field of a normal, unflagged result. */
const NO_ALARM = '000';
/** Terminates one analyte's block. */
const BLOCK_END = '}';

export interface Vitros250Record {
  sampleId: string;
  /** Operator / workstation label; blank on most records. */
  operator: string | null;
  /** Specimen fluid code the analyzer ran: '4' serum, '0' and '5' also seen. */
  fluidType: string | null;
  /** Position of this sample within the analyzer's run. */
  sequence: number | null;
  results: InstrumentResult[];
}

/**
 * A result is reportable only when the value field actually carries a number.
 * The analyzer fills the field with text such as "NO RESULT" for an assay it
 * could not complete, and filing that as a value would put a non-numeric
 * string into the patient's record.
 */
const hasNumber = (v: string): boolean => /\d/.test(v);

/** Build YYYYMMDDHHMMSS from the record's HHMMSS+MMDD stamp, which omits the year. */
function completedAt(stamp: string, now = new Date()): string | null {
  if (!/^\d{10}$/.test(stamp)) return null;
  const [hh, mi, ss, mm, dd] = [stamp.slice(0, 2), stamp.slice(2, 4), stamp.slice(4, 6), stamp.slice(6, 8), stamp.slice(8, 10)];
  // The analyzer sends no year. Assume the current one, stepping back a year if
  // that would place the result in the future (a run crossing New Year).
  let year = now.getFullYear();
  const asDate = new Date(`${year}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() - now.getTime() > 86_400_000) year -= 1;
  return `${year}${mm}${dd}${hh}${mi}${ss}`;
}

/** Parse ONE fixed-width record (the text between record terminators). */
export function parseResultRecord(rec: string, now = new Date()): Vitros250Record | null {
  if (rec.length < OFF_RESULTS) return null;

  const sampleId = rec.slice(OFF_SAMPLE, OFF_SAMPLE + SAMPLE_FIELD).trim();
  if (!sampleId) return null;

  const stamp = rec.slice(OFF_STAMP, OFF_STAMP + 10);
  const when = completedAt(stamp, now);

  const listEnd = rec.indexOf(LIST_END, OFF_RESULTS);
  const body = listEnd === -1 ? rec.slice(OFF_RESULTS) : rec.slice(OFF_RESULTS, listEnd);

  const results: InstrumentResult[] = [];
  for (const block of body.split(BLOCK_END)) {
    if (block.length < 1 + VALUE_WIDTH) continue;
    const value = block.slice(1, 1 + VALUE_WIDTH).trim();
    if (!hasNumber(value)) continue; // "NO RESULT" and friends
    const alarm = block.slice(1 + VALUE_WIDTH).trim();
    results.push({
      sampleId,
      testCode: decodeTestCode(block[0]!),
      // Values arrive as "122." / ".7" / "1.09"; drop the bare trailing point so
      // HMIS receives "122" rather than "122.".
      value: value.replace(/\.$/, ''),
      unit: null,
      referenceRange: null,
      abnormalFlag: alarm && alarm !== NO_ALARM ? alarm : null,
      status: 'F',
      completedAt: when,
      instrument: null,
    });
  }

  return {
    sampleId,
    operator: rec.slice(OFF_OPERATOR, OFF_OPERATOR + SAMPLE_FIELD).trim() || null,
    fluidType: rec[OFF_FLUID] ?? null,
    sequence: rec.length > OFF_SEQUENCE ? rec.charCodeAt(OFF_SEQUENCE) - 32 : null,
    results,
  };
}

/**
 * Parse a whole result file. One transfer can carry several records — the
 * analyzer batches everything it has pending — so split on the terminator.
 */
export function parseResultFile(payload: string, now = new Date()): ParsedMessage {
  const records: Vitros250Record[] = [];
  for (const chunk of payload.split(RECORD_END)) {
    if (chunk.length < OFF_RESULTS) continue;
    const rec = parseResultRecord(chunk, now);
    if (rec) records.push(rec);
  }
  return {
    protocol: 'kermit',
    sender: 'VITROS250',
    patient: null,
    queries: [],
    results: records.flatMap((r) => r.results),
    raw: payload,
  };
}
