import { createHash } from 'node:crypto';
import type { AnalyzerConfig } from '../config.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem, ParsedMessage } from '../types.js';

// =============================================================================
// Mapper — connector-side shaping only.
//
// The authoritative instrument-code → HMIS-parameter mapping lives on the
// SERVER (LabInstrumentCodeMap), so there is one source of truth and the lab
// can re-map without redeploying the connector. Here we only:
//   • detect QC/control samples (so patient results and QC are routed apart),
//   • group a parsed message's results by sample, and
//   • assign a deterministic messageId so a re-transmit is idempotent while a
//     correction (new value/status) is treated as a distinct message.
// =============================================================================

/** HMIS registers barcodes in canonical uppercase (e.g. LAB-2026-0000016) and
 *  matches them case-SENSITIVELY on both /orders and /results. An analyzer may
 *  emit a manually-typed lowercase barcode, so normalise before every
 *  server-facing lookup/upload. The reply to the analyzer keeps its original
 *  case so the instrument still matches its own pending sample. */
export function normalizeBarcode(sampleId: string): string {
  return (sampleId || '').trim().toUpperCase();
}

export function isQcSample(sampleId: string, cfg: AnalyzerConfig['qc']): boolean {
  const id = (sampleId || '').trim();
  if (!id) return false;
  const upper = id.toUpperCase();
  // Allow list first: on an analyzer whose patient barcodes carry a known
  // prefix, anything without it is a control. This is what catches bare-numeric
  // control ids such as 89772, which no deny list can name in advance.
  if (cfg.patientPrefixes.length > 0 && !cfg.patientPrefixes.some((p) => upper.startsWith(p.toUpperCase())))
    return true;
  if (cfg.sampleIdPrefixes.some((p) => upper.startsWith(p.toUpperCase()))) return true;
  if (cfg.sampleIdRegex) {
    try {
      if (new RegExp(cfg.sampleIdRegex).test(id)) return true;
    } catch {
      /* invalid regex — ignore */
    }
  }
  return false;
}

/** Group a parsed message's results into one upload per sample barcode. */
/**
 * The placeholder an analyzer reports when an assay produced no reportable
 * value is not a result. Filing it would put text where a number belongs, and
 * worse, acknowledge the order row, so the rerun that follows would have
 * nothing to be filed against. It is dropped at intake; the rerun files.
 * Callers log the drop.
 *
 * Four forms, all seen on this site's instruments:
 *
 *   ""                  nothing at all
 *   "No Result"         VITROS ECi/ECiQ; "NO RESULT" on the VITROS 250
 *   "....."             Radiometer ABL9 — the value could not be calculated.
 *                       It always comes with a C record saying why ("1009:
 *                       Unable to calculate - missing Temperature"). Measured
 *                       in a month of ABL9 traffic: 5335 occurrences, 22 of
 *                       them on analytes HMIS actually registers (tCO2(B),
 *                       tHb, Anion gap, ABE, HCO3-, sO2, tCO2(P)).
 *   "****"              Mindray BC-6000 — the channel was measured but the
 *                       instrument withholds the number, which is what it does
 *                       to the LYM/MON differential when a morphology flag
 *                       (blast, abnormal lymph) fires. It is the ONLY
 *                       non-numeric text the BC-6000 ever puts in an NM field:
 *                       590 occurrences across the wire logs; every other NM
 *                       value is a plain number.
 *
 *                       This one used to be filed. On CH2609080028 the
 *                       connector posted resultValue "****" for MON#, HMIS
 *                       accepted it, the sample flipped to "result interfaced"
 *                       and the report showed a blank — worse than leaving it
 *                       pending, because a pending sample is visibly incomplete
 *                       and gets chased whereas an interfaced one does not.
 *
 * A leading "?" is the ABL9's QUESTIONABLE-result marker — "?7.43", "?....."
 * — meaning the instrument does not stand behind the number. It lands on the
 * core measured analytes (pH, pCO2, pO2, Hct, K+, Na+, Ca++, Cl-, Lac), all of
 * which HMIS registers as Numeric, so filing "?7.43" would push a non-numeric
 * string into a numeric field AND retire the order row. Treated as void so the
 * row stays open and the repeat run files a clean value.
 */
export function isVoidResult(value: string | null | undefined): boolean {
  const raw = (value ?? '').trim();
  const v = raw.toUpperCase();
  if (v === '' || v === 'NO RESULT' || v === 'NORESULT') return true;
  // ABL9: a run of dots ("....."), optionally behind the "?" marker.
  if (/^\.+$/.test(raw)) return true;
  // Mindray: a run of asterisks ("****") - the instrument withheld the value.
  if (/^[*]+$/.test(raw)) return true;
  // ABL9: any questionable value, numeric or not.
  if (raw.startsWith('?')) return true;
  return false;
}

export function toResultUploads(analyzer: AnalyzerConfig, msg: ParsedMessage): HmisResultUpload[] {
  const bySample = new Map<string, ParsedMessage['results']>();
  for (const r of msg.results) {
    if (!r.sampleId) continue;
    if (isVoidResult(r.value)) continue;
    const arr = bySample.get(r.sampleId) ?? [];
    arr.push(r);
    bySample.set(r.sampleId, arr);
  }

  const uploads: HmisResultUpload[] = [];
  for (const [sampleId, results] of bySample) {
    const payload = results.map((r) => ({
      testCode: r.testCode,
      value: r.value,
      unit: r.unit ?? null,
      abnormalFlag: r.abnormalFlag ?? null,
      status: r.status ?? 'F',
      completedAt: r.completedAt ?? null,
    }));
    const barcode = normalizeBarcode(sampleId);
    uploads.push({
      equipmentId: analyzer.equipmentId ?? null,
      eqCode: analyzer.equipmentCode,
      barcode,
      // Either the protocol said so (HL7 MSH-11 = Q) or the barcode shape does.
      isQc: msg.isQc === true || isQcSample(sampleId, analyzer.qc),
      results: payload,
      raw: msg.raw,
      messageId: deterministicMessageId(analyzer.equipmentCode, barcode, payload),
    });
  }
  return uploads;
}

/** Keyed on equipmentCode, not equipmentId — equipmentId is optional now. */
function deterministicMessageId(equipmentCode: string, sampleId: string, results: unknown): string {
  const h = createHash('sha256')
    .update(`${equipmentCode}|${sampleId}|${JSON.stringify(results)}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `${sampleId}-${h}`;
}

// -----------------------------------------------------------------------------
// Result upload → wire rows.
//
// The results endpoint files against `labResultId`, which only the PENDING ROW
// carries — the analyzer knows nothing about it. So an upload is joined back to
// the order rows for its barcode on the analyzer's own assay code (the pending
// row's `eqIdntifier`, carried here as `identifier`). A result whose code has no
// pending row cannot be filed and is returned as `unmatched` rather than sent
// with a null id, which the server would silently drop.
// -----------------------------------------------------------------------------
/**
 * Multiply a reported value by a unit-conversion factor.
 *
 * Returns the value UNCHANGED unless it is a plain number — a flag, a censored
 * "<0.1" or a "****" must not become a number, and silently mangling one is
 * worse than filing the analyzer's own text. Binary floating point is trimmed
 * back to 12 significant digits so 8.89 x 1000 files as 8890 rather than
 * 8890.000000000002; 12 digits is far more precision than any haematology
 * channel carries, so it can only remove the artefact, never a real digit.
 */
export function scaleResultValue(value: string, factor: number): string {
  const raw = (value ?? '').trim();
  if (!raw || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return value;
  const scaled = Number((n * factor).toPrecision(12));
  return Number.isFinite(scaled) ? String(scaled) : value;
}

export function toLisResultRows(
  upload: HmisResultUpload,
  orderRows: MirthAcknowledgeItem[],
  /**
   * Reduce an assay identifier to the key both sides agree on. Needed because
   * the two sides do not always spell it the same way: HMIS stores the VITROS
   * `eqIdntifier` as the full Universal Test ID ("1.000000+032+1") while the
   * codec reports the assay it measured as "032". Defaults to identity, so
   * analyzers whose codes already match are unaffected.
   */
  canonicalCode: (identifier: string) => string = (id) => id,
  /**
   * Analyzer assay code → the HMIS `eqIdntifier` that means the same analyte,
   * for the cases where the two genuinely differ in NAME rather than spelling:
   * the Erba H360 reports "HGB" and "LYM%" where ZHFC03's CBC parameters are
   * registered as "HAEMOGLOBIN" and "Lymphocytes". Applied at delivery time, so
   * correcting a mapping repairs results already sitting in the spool.
   *
   * Prefer fixing the Identifier column in HMIS — that keeps one source of
   * truth. This is for the analytes HMIS names after the report line rather
   * than after the instrument. Matching is case-insensitive.
   */
  aliases: Record<string, string> = {},
  /**
   * Assay codes this analyzer emits that are NOT reportable results and will
   * therefore never have a pending row: research-only channels and flag scores.
   * The BC-6000 interleaves 28 of them with the 22 CBC analytes (WBC-D, TNC-N,
   * HFC%, NLR, the whole "…?-IM" suspect-flag block). Without this they land in
   * `unmatched`, get re-queued as their own spool item, and burn 50 delivery
   * attempts before parking in failed/ — once per CBC.
   *
   * Reported as `ignored`: neither filed nor counted as unmatched, so a genuine
   * analyte that is merely missing its HMIS row still surfaces as unmatched and
   * still gets retried. An entry may lead with "*" to match by suffix
   * ("*-IM") or trail with "*" to match by prefix ("InR*"); matching is
   * case-insensitive.
   */
  ignoreTestCodes: string[] = [],
  /**
   * Analyzer assay code → the factor its value is multiplied by before it is
   * filed, for analytes the two sides report in different UNITS rather than
   * under different names. The BC-6000 reports WBC and PLT in 10^9/L (WBC 8.89,
   * PLT 226 — it labels them either "10*9/L" or the numerically identical
   * "10*3/uL") while HMIS holds them per microlitre (8890, 226000), so both
   * carry a factor of 1000.
   *
   * Applied here, at delivery time, for the same reason aliases are: a
   * corrected factor then also repairs items already sitting in the spool.
   * Non-numeric values are filed unchanged — a factor must never turn a flag
   * or a censored "<0.1" into a number.
   */
  scales: Record<string, number> = {},
  /**
   * The ONLY analyzer assay codes that may be filed. Empty means no allow-list.
   * When set, a code outside the list is reported as `ignored` — dropped
   * before the void check and before the pending-row join, so it is neither
   * filed nor retried as unmatched. The BC-6000 interface is scoped to the 22
   * CBC analytes HMIS registers under the instrument mnemonic; everything else
   * the analyzer emits (research channels, flag scores, and the analytes HMIS
   * has not interfaced) stays out of HMIS by this list, whatever pending rows
   * exist. Exact, case-insensitive, no wildcards.
   */
  allowTestCodes: string[] = [],
): {
  rows: LisInboundResultRow[];
  unmatched: string[];
  matched: MirthAcknowledgeItem[];
  voided: string[];
  ignored: string[];
  /** Analyte codes whose value was unit-converted, as "WBC 8.89->8890". */
  scaled: string[];
  /** The analyzer's OWN code for every row in `rows`, with the HMIS
   *  identifier and labResultId it was joined to — so a caller that tracks
   *  filing per analyte (the staged result store) can mark exactly the values
   *  that went out without re-deriving the join. Same order as `rows`. */
  filedCodes: Array<{ testCode: string; identifier: string; labResultId: number | null }>;
} {
  // Analyzers are inconsistent about case and padding on assay codes; the
  // pending row is authoritative for the spelling actually sent on the wire.
  const key = (id: string) => canonicalCode((id || '').trim()).trim().toUpperCase();

  const ignoreExact = new Set<string>();
  const ignoreSuffix: string[] = [];
  const ignorePrefix: string[] = [];
  const ignoreContains: string[] = [];
  for (const pattern of ignoreTestCodes) {
    const raw = (pattern || '').trim();
    if (!raw || raw === '*' || raw === '**') continue; // would silence the whole analyzer
    if (raw.startsWith('*') && raw.endsWith('*')) ignoreContains.push(key(raw.slice(1, -1)));
    else if (raw.startsWith('*')) ignoreSuffix.push(key(raw.slice(1)));
    else if (raw.endsWith('*')) ignorePrefix.push(key(raw.slice(0, -1)));
    else ignoreExact.add(key(raw));
  }
  const isIgnored = (code: string): boolean => {
    const k = key(code);
    if (!k) return false;
    if (ignoreExact.has(k)) return true;
    return (
      ignoreSuffix.some((s) => s && k.endsWith(s)) ||
      ignorePrefix.some((p) => p && k.startsWith(p)) ||
      ignoreContains.some((c) => c && k.includes(c))
    );
  };

  const allow = new Set<string>();
  for (const code of allowTestCodes) {
    const k = key(code);
    if (k) allow.add(k);
  }
  const isAllowed = (code: string): boolean => allow.size === 0 || allow.has(key(code));

  const aliasOf = new Map<string, string>();
  for (const [from, to] of Object.entries(aliases)) {
    const k = key(from);
    if (k) aliasOf.set(k, key(to));
  }

  const scaleOf = new Map<string, number>();
  for (const [code, factor] of Object.entries(scales)) {
    const k = key(code);
    if (k && Number.isFinite(factor) && factor > 0 && factor !== 1) scaleOf.set(k, factor);
  }

  const byCode = new Map<string, MirthAcknowledgeItem>();
  for (const row of orderRows) {
    const k = key(row.identifier);
    if (k && !byCode.has(k)) byCode.set(k, row); // first row wins
  }

  const rows: LisInboundResultRow[] = [];
  const unmatched: string[] = [];
  // The pending rows these results were filed against — what the acknowledge
  // body must echo once the upload has actually succeeded.
  const matched: MirthAcknowledgeItem[] = [];
  const seen = new Set<MirthAcknowledgeItem>();
  // Placeholders that slipped into the spool before intake filtered them — an
  // item parked under the old code. Neither filed nor counted as unmatched.
  const voided: string[] = [];
  // Research channels and flag scores this analyzer always emits. Dropped
  // before the void check so a research channel reporting "****" is reported
  // as ignored rather than as a value the lab should expect on a rerun.
  const ignored: string[] = [];
  // Unit conversions actually applied, so the delivery log can show the lab the
  // number that was filed next to the number the analyzer sent.
  const scaled: string[] = [];
  const filedCodes: Array<{ testCode: string; identifier: string; labResultId: number | null }> = [];

  for (const r of upload.results) {
    if (!isAllowed(r.testCode) || isIgnored(r.testCode)) {
      ignored.push(r.testCode);
      continue;
    }
    if (isVoidResult(r.value)) {
      voided.push(r.testCode);
      continue;
    }
    const own = key(r.testCode);
    // Try the analyzer's own code first: an alias must never shadow a code that
    // already matches a pending row.
    const ctx = byCode.get(own) ?? (aliasOf.has(own) ? byCode.get(aliasOf.get(own)!) : undefined);
    if (!ctx) {
      unmatched.push(r.testCode);
      continue;
    }
    // Unit conversion is keyed on the analyzer's OWN code, not the alias, so a
    // factor stays readable next to the mnemonic the instrument prints.
    const factor = scaleOf.get(own);
    let value = r.value;
    if (factor !== undefined) {
      value = scaleResultValue(r.value, factor);
      if (value !== r.value) scaled.push(`${r.testCode} ${r.value}->${value}`);
    }
    if (!seen.has(ctx)) {
      seen.add(ctx);
      matched.push(ctx);
    }
    filedCodes.push({ testCode: r.testCode, identifier: ctx.identifier, labResultId: ctx.labResultId });
    rows.push({
      sampleId: upload.barcode,
      labServiceId: ctx.labServiceId,
      labResultId: ctx.labResultId,
      // The analyzer's OWN equipmentId, from config.json, is authoritative: it
      // names the machine that actually produced the value. The pending row's
      // equipmentId names whichever equipment the order was raised against,
      // which is not necessarily the same machine, and is only a fallback for
      // an analyzer whose config omits the id.
      equipmentId: upload.equipmentId ?? ctx.equipmentId,
      ipAddress: ctx.ipAddress,
      portNo: ctx.portNo,
      identifier: ctx.identifier,
      resultValue: value,
      // The server sets this when it loads the value; we always report false.
      isLoaded: false,
      uniqueIdentifier: ctx.identifier,
      parameterId: ctx.parameterId,
    });
  }

  return { rows, unmatched, matched, voided, ignored, scaled, filedCodes };
}
