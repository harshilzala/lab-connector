import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';

// =============================================================================
// IM validation gate — decides, per value, whether a result may be certified
// and filed to Mirth without a person looking at it.
//
// A value passes when it is a number that sits inside a reference range the
// connector can vouch for. Everything else is HELD for review: a value outside
// the range, a value with no range at all (there is nothing to certify it
// against), a non-numeric value for a numeric parameter, and anything the
// analyzer itself flagged abnormal. Holding is the safe default: an auto-
// certified value goes on a patient report with nobody having seen it, so the
// gate only ever lets through what it can prove is unremarkable.
//
// Where the range comes from, in order of trust:
//
//   1. the IM config's own `ranges` for this analyzer (per test code) — the
//      lab's explicit word, set by the person who signs off the interface;
//   2. the reference range Mirth attached to the pending row, when the gateway
//      sends one (refLow/refHigh or a text form like "3.5 - 5.5");
//   3. the range the analyzer reported with the value (ASTM R-record field 6,
//      HL7 OBX-7), which is the instrument's own bundled table.
//
// The first source that yields a usable range wins; the verdict records which
// one it was, so the review screen can say "held: no range known" rather than
// leaving the operator to guess why a normal-looking value did not go.
// =============================================================================

export type GateVerdict =
  | { decision: 'certify'; reason: 'in-range'; range: ResolvedRange }
  | { decision: 'hold'; reason: HoldReason; range: ResolvedRange | null; detail: string };

export type HoldReason =
  | 'out-of-range' // outside refLow..refHigh
  | 'critical' // outside criticalLow..criticalHigh
  | 'no-range' // nothing to certify against
  | 'not-numeric' // a numeric parameter with a text value
  | 'analyzer-flag' // the instrument flagged it (H/L/HH/LL/</>/A)
  | 'not-final' // status P (preliminary) or C (correction)
  | 'always-review'; // the lab listed this code as never auto-certified

export interface ResolvedRange {
  low: number | null;
  high: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  /** Where it came from: 'config' | 'mirth' | 'analyzer'. */
  source: 'config' | 'mirth' | 'analyzer';
  /** The range as first written, for the screen. */
  text: string;
}

/** One analyzer's IM settings — the `im` block of the analyzer config. */
export interface GateConfig {
  /** Master switch. Off = every value is filed as before, nothing is held. */
  enabled: boolean;
  /** Test codes (analyzer's own spelling) that are never auto-certified. */
  alwaysReview: string[];
  /** Lab-set ranges by test code. `low`/`high` bound "normal"; either may be
   *  omitted for a one-sided range. Optional critical limits widen the hold
   *  reason to 'critical' so the screen can rank them first. */
  ranges: Record<string, { low?: number; high?: number; criticalLow?: number; criticalHigh?: number }>;
  /** Hold a value the analyzer flagged, even when it sits inside the range
   *  the connector resolved. Default true — the instrument's own flag is
   *  evidence the connector should not overrule silently. */
  holdOnAnalyzerFlag: boolean;
  /** Hold a value with no resolvable range. Default true. Set false only for
   *  an interface where the lab has decided unranged parameters may file. */
  holdWhenNoRange: boolean;
  /** Certify qualitative values whose text is in this list ("Negative",
   *  "Normal", "Absent") — the qualitative analogue of "in range". Compared
   *  case-insensitively after trimming. */
  normalWords: string[];
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: false,
  alwaysReview: [],
  ranges: {},
  holdOnAnalyzerFlag: true,
  holdWhenNoRange: true,
  normalWords: ['negative', 'neg', 'normal', 'absent', 'nil', 'not detected', 'non reactive', 'non-reactive'],
};

const codeKey = (c: string) => (c ?? '').trim().toUpperCase();

/** Flags the instruments in this repo use for anything other than "normal". */
const ABNORMAL_FLAGS = new Set(['H', 'L', 'HH', 'LL', '>', '<', 'A', 'AA', 'HIGH', 'LOW', 'PANIC', 'CRIT', 'C']);

/**
 * Parse "3.5 - 5.5", "3.5-5.5", "3.5 to 5.5", "<200", "> 40", ">=40", "≤ 5",
 * "5.5^7.2" (ASTM) into bounds. Anything unparseable returns null and the
 * caller falls through to the next source.
 */
export function parseRangeText(text: string | null | undefined): { low: number | null; high: number | null } | null {
  if (!text) return null;
  const t = text.trim().replace(/,/g, '');
  if (!t) return null;
  const num = '([-+]?\\d+(?:\\.\\d+)?)';
  let m = t.match(new RegExp(`^${num}\\s*(?:-|–|—|to|\\^|~)\\s*${num}$`, 'i'));
  if (m) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) return { low, high };
    return null;
  }
  m = t.match(new RegExp(`^(<=?|≤|<)\\s*${num}$`));
  if (m) return { low: null, high: Number(m[2]) };
  m = t.match(new RegExp(`^(>=?|≥|>)\\s*${num}$`));
  if (m) return { low: Number(m[2]), high: null };
  m = t.match(new RegExp(`^${num}$`));
  if (m) return { low: null, high: Number(m[1]) }; // a lone upper bound ("200")
  return null;
}

/** A result value as a number, or null for anything the lab would read as text. */
export function numericValue(value: string): number | null {
  const v = (value ?? '').trim().replace(/,/g, '');
  if (!v) return null;
  // Strip a leading qualifier the instrument sometimes prefixes ("<0.02",
  // ">1000"): such a value is by definition at or past a limit, so it is
  // treated as non-numeric and held — the number alone would mislead.
  if (/^[<>]/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the range to judge one value by. `code` is the analyzer's own test
 * code; `row` is the Mirth pending row it was joined to (may be undefined for
 * a forced push); `analyzerRange` is what the instrument sent with the value.
 */
export function resolveRange(
  cfg: GateConfig,
  code: string,
  row: MirthAcknowledgeItem | undefined,
  analyzerRange: string | null | undefined,
): ResolvedRange | null {
  const own = cfg.ranges[code] ?? cfg.ranges[codeKey(code)] ??
    Object.entries(cfg.ranges).find(([k]) => codeKey(k) === codeKey(code))?.[1];
  if (own && (own.low !== undefined || own.high !== undefined)) {
    return {
      low: own.low ?? null,
      high: own.high ?? null,
      criticalLow: own.criticalLow ?? null,
      criticalHigh: own.criticalHigh ?? null,
      source: 'config',
      text: describe(own.low ?? null, own.high ?? null),
    };
  }
  if (row) {
    const low = row.refLow ?? null;
    const high = row.refHigh ?? null;
    if (low !== null || high !== null) {
      return {
        low,
        high,
        criticalLow: row.criticalLow ?? null,
        criticalHigh: row.criticalHigh ?? null,
        source: 'mirth',
        text: row.refText ?? describe(low, high),
      };
    }
    const parsed = parseRangeText(row.refText);
    if (parsed) {
      return {
        ...parsed,
        criticalLow: row.criticalLow ?? null,
        criticalHigh: row.criticalHigh ?? null,
        source: 'mirth',
        text: row.refText!.trim(),
      };
    }
  }
  const fromAnalyzer = parseRangeText(analyzerRange);
  if (fromAnalyzer) {
    return { ...fromAnalyzer, criticalLow: null, criticalHigh: null, source: 'analyzer', text: analyzerRange!.trim() };
  }
  return null;
}

function describe(low: number | null, high: number | null): string {
  if (low !== null && high !== null) return `${low} - ${high}`;
  if (low !== null) return `>= ${low}`;
  if (high !== null) return `<= ${high}`;
  return '';
}

/** The verdict for one value. Pure: no I/O, no clock. */
export function judge(
  cfg: GateConfig,
  value: { testCode: string; value: string; abnormalFlag?: string | null; status?: string | null; referenceRange?: string | null },
  row: MirthAcknowledgeItem | undefined,
): GateVerdict {
  const code = value.testCode;
  const range = resolveRange(cfg, code, row, value.referenceRange);

  if (cfg.alwaysReview.some((c) => codeKey(c) === codeKey(code))) {
    return { decision: 'hold', reason: 'always-review', range, detail: 'listed in im.alwaysReview' };
  }
  const status = (value.status ?? 'F').trim().toUpperCase();
  if (status && status !== 'F') {
    return { decision: 'hold', reason: 'not-final', range, detail: `result status ${status}` };
  }
  const flag = (value.abnormalFlag ?? '').trim().toUpperCase();
  if (cfg.holdOnAnalyzerFlag && flag && flag !== 'N' && ABNORMAL_FLAGS.has(flag)) {
    return { decision: 'hold', reason: 'analyzer-flag', range, detail: `analyzer flagged ${flag}` };
  }

  const n = numericValue(value.value);
  if (n === null) {
    // Qualitative: certify a word the lab has listed as normal, hold the rest.
    const word = value.value.trim().toLowerCase();
    if (word && cfg.normalWords.some((w) => w.trim().toLowerCase() === word)) {
      return {
        decision: 'certify',
        reason: 'in-range',
        range: range ?? { low: null, high: null, criticalLow: null, criticalHigh: null, source: 'config', text: `"${value.value.trim()}" is a normal word` },
      };
    }
    if (range) return { decision: 'hold', reason: 'not-numeric', range, detail: `"${value.value}" is not a number` };
    return { decision: 'hold', reason: 'no-range', range: null, detail: `"${value.value}" — no range and not a listed normal word` };
  }

  if (!range) {
    if (cfg.holdWhenNoRange) return { decision: 'hold', reason: 'no-range', range: null, detail: 'no reference range from config, Mirth or the analyzer' };
    return { decision: 'certify', reason: 'in-range', range: { low: null, high: null, criticalLow: null, criticalHigh: null, source: 'config', text: 'unranged — filed by im.holdWhenNoRange=false' } };
  }

  if ((range.criticalLow !== null && n < range.criticalLow) || (range.criticalHigh !== null && n > range.criticalHigh)) {
    return { decision: 'hold', reason: 'critical', range, detail: `${n} is past the critical limit (${range.criticalLow ?? '…'} – ${range.criticalHigh ?? '…'})` };
  }
  if ((range.low !== null && n < range.low) || (range.high !== null && n > range.high)) {
    return { decision: 'hold', reason: 'out-of-range', range, detail: `${n} is outside ${range.text}` };
  }
  return { decision: 'certify', reason: 'in-range', range };
}

/** One value's verdict, keyed the way the filer works — by the join's index. */
export interface GatedValue {
  testCode: string;
  identifier: string;
  value: string;
  unit: string | null;
  verdict: GateVerdict;
}

/**
 * Split a joined upload into what may file now and what must wait for a
 * person. `rows[i]` and `filedCodes[i]` describe the same value (the mapper
 * builds them in lockstep), so both lists are partitioned by the same index.
 */
export function gateJoined(
  cfg: GateConfig,
  upload: HmisResultUpload,
  joined: {
    rows: LisInboundResultRow[];
    matched: MirthAcknowledgeItem[];
    filedCodes: Array<{ testCode: string; identifier: string; labResultId: number | null }>;
  },
  orderRows: MirthAcknowledgeItem[],
): {
  certify: { rows: LisInboundResultRow[]; filedCodes: typeof joined.filedCodes; matched: MirthAcknowledgeItem[] };
  hold: GatedValue[];
  verdicts: GatedValue[];
} {
  const byCode = new Map(upload.results.map((r) => [r.testCode, r] as const));
  const rowByIdentifier = new Map(orderRows.map((r) => [codeKey(r.identifier), r] as const));
  const certifyRows: LisInboundResultRow[] = [];
  const certifyCodes: typeof joined.filedCodes = [];
  const hold: GatedValue[] = [];
  const verdicts: GatedValue[] = [];

  for (let i = 0; i < joined.rows.length; i++) {
    const row = joined.rows[i]!;
    const fc = joined.filedCodes[i]!;
    const src = byCode.get(fc.testCode);
    const orderRow = rowByIdentifier.get(codeKey(fc.identifier));
    const verdict = judge(
      cfg,
      {
        testCode: fc.testCode,
        // Judge the value AS FILED (after unit scaling / word translation),
        // because that is the number the range in Mirth refers to.
        value: row.resultValue,
        abnormalFlag: src?.abnormalFlag,
        status: src?.status,
        referenceRange: src?.referenceRange,
      },
      orderRow,
    );
    const gv: GatedValue = { testCode: fc.testCode, identifier: fc.identifier, value: row.resultValue, unit: src?.unit ?? null, verdict };
    verdicts.push(gv);
    if (verdict.decision === 'certify') {
      certifyRows.push(row);
      certifyCodes.push(fc);
    } else {
      hold.push(gv);
    }
  }

  // Acknowledge only the pending rows every one of whose values is going now.
  // A row whose value is held must stay pending in Mirth until it is verified.
  const goingIdentifiers = new Set(certifyCodes.map((c) => codeKey(c.identifier)));
  const heldIdentifiers = new Set(hold.map((h) => codeKey(h.identifier)));
  const matched = joined.matched.filter((m) => goingIdentifiers.has(codeKey(m.identifier)) && !heldIdentifiers.has(codeKey(m.identifier)));

  return { certify: { rows: certifyRows, filedCodes: certifyCodes, matched }, hold, verdicts };
}
