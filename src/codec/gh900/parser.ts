import type { InstrumentResult } from '../../types.js';

// =============================================================================
// Lifotronic GH900 Plus (HbA1c, HPLC) — sample data block parser.
//
// Source: GH900 Plus operator's manual, Appendix B "Communication" (B.2/B.3),
// confirmed against the first live transmission at Shela on 2026-09-12
// (version "07", 1362 characters, logs/wire-zhp-gh900plus-2026-09-12.log):
//
//   STX 'S' <fields, widths below> <curve values> <error code> ETX
//
//   S 07 -- -- 04 WBR5 0350 01 0007 0 260911205333 13 18 26 35 52 88
//     0.0013 0.0030 0.0014 0.0023 0.0057 0.2414       absorbance  #.####
//     00.016 00.088 00.042 00.094 00.723 13.262       peak area   ##.###
//     00.1   00.6   00.3   00.7   05.1   93.2         ratio %     ##.#
//     032.0  05.5   099.1  200  <200 × #.####>  0
//
// Two things differ from the manual's placeholder glyphs, and the wire wins:
//   • the SAMPLE ID is not 16 fixed characters — it is exactly "Code length"
//     characters long (04 → "WBR5"), so the header is sized per block;
//   • the six PEAK-AREA RATIOS are "##.#" (4 characters), not "##.##". They
//     sum to 100.0, and HbA1c 5.1 % agrees with the IFCC 32.0 mmol/mol and
//     eAG 99.1 mg/dL / 5.5 mmol/L that follow, so the boundary is certain.
// Everything else is as documented. The parser still checks the block's total
// length against the layout — the curve count says how many 6-character curve
// values follow, and the block must end exactly one error-code character later
// — and refuses a block that does not add up rather than filing numbers cut at
// the wrong offset; the raw block is in the wire log either way.
//
// Character set (B.2): STX 0x02, ETX 0x03, digits, '*', '-', '+', '.', and the
// block specifiers 'S' (sample), 'Q', 'C'. Only 'S' is documented; 'Q' and 'C'
// are presumably QC and calibration blocks and are ignored by the link. The
// live block carries "--" for parameter count and description format.
// =============================================================================

export const STX = 0x02;
export const ETX = 0x03;

/** The six haemoglobin fractions, always in this order on the wire. */
const FRACTIONS = ['HbA1a', 'HbA1b', 'HbF', 'LA1c', 'HbA1c', 'HbA0'] as const;

/** The fixed-width fields before the sample id, after the 'S' specifier. */
const PREAMBLE: ReadonlyArray<readonly [name: string, width: number]> = [
  ['version', 2],
  ['parameterCount', 2],
  ['descriptionFormat', 2],
  /** Width of the sample id that follows — the one variable-width field. */
  ['codeLength', 2],
];

/** Fixed-width header fields after the sample id, in wire order. */
const HEADER: ReadonlyArray<readonly [name: string, width: number]> = [
  ['temperatureX10', 4],
  ['rackPosition', 2],
  ['seriesNo', 4],
  ['bloodType', 1],
  ['year', 2],
  ['month', 2],
  ['day', 2],
  ['hour', 2],
  ['minute', 2],
  ['second', 2],
  // One value per fraction, in FRACTIONS order.
  ...FRACTIONS.map((f) => [`${f}.appearanceTime`, 2] as const),
  ...FRACTIONS.map((f) => [`${f}.absorbance`, 6] as const), // #.####
  ...FRACTIONS.map((f) => [`${f}.peakArea`, 6] as const), // ##.###
  ...FRACTIONS.map((f) => [`${f}.ratio`, 4] as const), // ##.#   (percent) — wire, not the manual's ##.##
  ['hba1cIfcc', 5], // ###.#  mmol/mol
  ['eagMmol', 4], // ##.#   mmol/L
  ['eagMgdl', 5], // ###.#  mg/dL
  ['curveCount', 3], // ###
];
const CURVE_VALUE_WIDTH = 6; // #.####
const ERROR_CODE_WIDTH = 1;

const PREAMBLE_LENGTH = PREAMBLE.reduce((n, [, w]) => n + w, 0);
/** Header width after the 'S' specifier, EXCLUDING the variable-width sample id. */
export const HEADER_LENGTH = PREAMBLE_LENGTH + HEADER.reduce((n, [, w]) => n + w, 0);

/** Blood type (B.2). 0x30 venous, 0x31 diluted, 0x32 QC material, 0x33 calibrator. */
export type BloodType = 'venous' | 'diluted' | 'qc' | 'calibrator' | 'unknown';
const BLOOD_TYPES: Record<string, BloodType> = { '0': 'venous', '1': 'diluted', '2': 'qc', '3': 'calibrator' };

/** Test error code (B.2). '0' no error, '1' E1 sampling too little, '2' E2 sampling too much. */
const ERROR_TEXT: Record<string, string> = { '0': '', '1': 'E1 sampling too less', '2': 'E2 sampling too much' };

export interface Gh900Sample {
  sampleId: string;
  bloodType: BloodType;
  /** Raw blood-type character, for the log. */
  bloodTypeCode: string;
  /** yyyyMMddHHmmss from the block's own clock. */
  testedAt: string;
  /** '' when the instrument reported no error. */
  error: string;
  errorCode: string;
  curveCount: number;
  /** Every header field as sent (trimmed), for the audit log. */
  fields: Record<string, string>;
  results: InstrumentResult[];
}

/**
 * The analyte codes this codec reports, as they appear in `testCode`. These
 * are the connector's own names for the block's positional values — the
 * instrument sends no codes — and are what config.json's allowTestCodes /
 * testCodeAliases refer to.
 */
export const GH900_CODES = {
  HBA1C: 'HBA1C', //        HbA1c peak-area ratio, %  (the NGSP result)
  HBA1C_IFCC: 'HBA1C-IFCC', // mmol/mol
  EAG_MGDL: 'EAG-MGDL', //  estimated average glucose, mg/dL
  EAG_MMOL: 'EAG-MMOL', //  estimated average glucose, mmol/L
  HBF: 'HBF', //            HbF peak-area ratio, %
  HBA1A: 'HBA1A',
  HBA1B: 'HBA1B',
  LA1C: 'LA1C',
  HBA0: 'HBA0',
} as const;

/**
 * Parse the text between STX and ETX. Throws when the block is not an 'S'
 * block or its length does not match the documented layout.
 */
export function parseGh900Sample(block: string, opts: { instrument?: string | null } = {}): Gh900Sample {
  if (block[0] !== 'S') throw new Error(`GH900: not a sample block (specifier ${JSON.stringify(block[0] ?? '')})`);

  let pos = 1;
  const fields: Record<string, string> = {};
  const take = (name: string, width: number): void => {
    fields[name] = block.slice(pos, pos + width).trim();
    pos += width;
  };

  if (block.length < 1 + PREAMBLE_LENGTH) {
    throw new Error(`GH900: block too short for the preamble — ${block.length} chars, needs ${1 + PREAMBLE_LENGTH}`);
  }
  for (const [name, width] of PREAMBLE) take(name, width);

  // The sample id is the one field whose width the block itself states.
  const codeLength = Number.parseInt(fields.codeLength!, 10);
  if (!Number.isFinite(codeLength) || codeLength < 0) {
    throw new Error(`GH900: unreadable code length ${JSON.stringify(fields.codeLength)}`);
  }
  const headerLength = 1 + HEADER_LENGTH + codeLength;
  if (block.length < headerLength) {
    throw new Error(
      `GH900: block too short for the header — ${block.length} chars, header needs ${headerLength} (sample id ${codeLength})`,
    );
  }
  take('sampleId', codeLength);
  for (const [name, width] of HEADER) take(name, width);

  const curveCount = Number.parseInt(fields.curveCount!, 10);
  if (!Number.isFinite(curveCount) || curveCount < 0) {
    throw new Error(`GH900: unreadable curve count ${JSON.stringify(fields.curveCount)}`);
  }
  const expected = headerLength + curveCount * CURVE_VALUE_WIDTH + ERROR_CODE_WIDTH;
  if (block.length !== expected) {
    throw new Error(
      `GH900: block is ${block.length} chars but the layout says ${expected} ` +
        `(header ${headerLength} incl. ${codeLength}-char sample id + ${curveCount} curve values × ${CURVE_VALUE_WIDTH} + error code 1) — ` +
        'field widths need confirming against this transmission',
    );
  }
  pos += curveCount * CURVE_VALUE_WIDTH; // chromatogram points are not results
  const errorCode = block.slice(pos, pos + ERROR_CODE_WIDTH);

  const sampleId = fields.sampleId!;
  const yy = fields.year!.padStart(2, '0');
  const testedAt =
    `20${yy}${fields.month!.padStart(2, '0')}${fields.day!.padStart(2, '0')}` +
    `${fields.hour!.padStart(2, '0')}${fields.minute!.padStart(2, '0')}${fields.second!.padStart(2, '0')}`;
  const bloodTypeCode = fields.bloodType!;
  const bloodType = BLOOD_TYPES[bloodTypeCode] ?? 'unknown';

  const instrument = opts.instrument ?? 'GH900';
  const result = (testCode: string, raw: string, unit: string): InstrumentResult => ({
    sampleId,
    testCode,
    value: numeric(raw),
    unit,
    referenceRange: null,
    abnormalFlag: null,
    status: 'F',
    completedAt: testedAt,
    instrument,
  });

  const results: InstrumentResult[] = [
    result(GH900_CODES.HBA1C, fields['HbA1c.ratio']!, '%'),
    result(GH900_CODES.HBA1C_IFCC, fields.hba1cIfcc!, 'mmol/mol'),
    result(GH900_CODES.EAG_MGDL, fields.eagMgdl!, 'mg/dL'),
    result(GH900_CODES.EAG_MMOL, fields.eagMmol!, 'mmol/L'),
    result(GH900_CODES.HBF, fields['HbF.ratio']!, '%'),
    result(GH900_CODES.HBA1A, fields['HbA1a.ratio']!, '%'),
    result(GH900_CODES.HBA1B, fields['HbA1b.ratio']!, '%'),
    result(GH900_CODES.LA1C, fields['LA1c.ratio']!, '%'),
    result(GH900_CODES.HBA0, fields['HbA0.ratio']!, '%'),
  ];

  return {
    sampleId,
    bloodType,
    bloodTypeCode,
    testedAt,
    error: ERROR_TEXT[errorCode] ?? `unknown error code ${JSON.stringify(errorCode)}`,
    errorCode,
    curveCount,
    fields,
    results,
  };
}

/** "05.60" → "5.60", " 7.1" → "7.1"; anything non-numeric is passed through
 *  trimmed so isVoidResult can judge it ("****"). */
function numeric(raw: string): string {
  const v = raw.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(v)) return v;
  const sign = v.startsWith('-') ? '-' : '';
  const body = v.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
  return sign + body;
}
