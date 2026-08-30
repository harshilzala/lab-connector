import type { InstrumentResult } from '../../types.js';

// =============================================================================
// ADVIA 2120i result parser — proprietary Siemens fixed-width serial format.
//
// This is NOT ASTM. It reproduces the parsing the legacy caretech middleware
// did (its `FormateData` routine): each transmission from the analyzer is one
// result record made of a header line + a data line, e.g. (spaces significant):
//
//   2R 02026040200471                  04/03/26 02:14:44
//     1 7.81   2 3.78   3 10.6 ...  191 71.11  192 67.19  37    +  ...
//   a                                     ← 1-char checksum/terminator line
//
// Header line:  <frameChar>R <sampleId> <MM/dd/yy> <HH:mm:ss>
// Data line:    a run of fixed 9-char CELLS = 3-char field-id + 6-char value,
//               both right-justified. The field-id IS the instrument test code
//               the HMIS server maps (LabInstrumentCodeMap), e.g. 1=WBC, 2=RBC…
//               Values are numeric ("7.81", "335", "0") or morphology flags
//               ("+", "++", "+++"). Verified against real captures — field 191
//               parses as 71.11 and 192 as 67.19 only under the 3+6 split.
//
// The instrument-code → analyte mapping deliberately stays on the SERVER, so we
// emit the raw field-id as testCode and never guess a mnemonic here.
// =============================================================================

export const ADVIA_CELL_WIDTH = 9;
const FIELD_WIDTH = 3; // remaining 6 chars are the value

// Header: <frameChar>R <sampleId> [rack-position] <MM/dd/yy> <HH:mm:ss>
// The optional rack/cup token (e.g. "019-06") appears between the sample id and
// the date on some transmissions (confirmed against live old-middleware logs),
// and is absent on others — so we skip anything between the id and the date.
const HEADER_RE = /R\s+(\S+)\s+.*?(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/;

export interface AdviaRecord {
  sampleId: string;
  /** YYYYMMDDHHMMSS as reported by the instrument, or null if unparseable. */
  completedAt: string | null;
  results: InstrumentResult[];
}

/** True if a line looks like an ADVIA record header (`…R <id> mm/dd/yy hh:mm:ss`). */
export function isAdviaHeader(line: string): boolean {
  return HEADER_RE.test(line);
}

/**
 * Parse one ADVIA record (a header line plus one or more data lines).
 * Returns null when the header can't be recognised.
 */
export function parseAdviaRecord(headerLine: string, dataLines: string[]): AdviaRecord | null {
  const m = HEADER_RE.exec(headerLine);
  if (!m) return null;
  const [, sampleId, mm, dd, yy, hh, mi, ss] = m;
  const completedAt = `20${yy}${mm}${dd}${hh}${mi}${ss}`;

  // Concatenate all data lines, then walk fixed 9-char cells.
  const data = dataLines.join('');
  const results: InstrumentResult[] = [];
  for (let p = 0; p + ADVIA_CELL_WIDTH <= data.length; p += ADVIA_CELL_WIDTH) {
    const cell = data.slice(p, p + ADVIA_CELL_WIDTH);
    const field = cell.slice(0, FIELD_WIDTH).trim();
    const value = cell.slice(FIELD_WIDTH).trim();
    // Field-id must be a small integer; skip padding/garbage cells defensively.
    if (!/^\d{1,3}$/.test(field)) continue;
    if (value === '') continue;
    results.push({
      sampleId: sampleId!,
      testCode: field,
      value,
      completedAt,
      instrument: 'ADVIA2120I',
    });
  }
  return { sampleId: sampleId!, completedAt, results };
}
