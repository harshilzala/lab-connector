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
  if (cfg.sampleIdPrefixes.some((p) => id.toUpperCase().startsWith(p.toUpperCase()))) return true;
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
export function toResultUploads(analyzer: AnalyzerConfig, msg: ParsedMessage): HmisResultUpload[] {
  const bySample = new Map<string, ParsedMessage['results']>();
  for (const r of msg.results) {
    if (!r.sampleId) continue;
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
      isQc: isQcSample(sampleId, analyzer.qc),
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
): { rows: LisInboundResultRow[]; unmatched: string[]; matched: MirthAcknowledgeItem[] } {
  // Analyzers are inconsistent about case and padding on assay codes; the
  // pending row is authoritative for the spelling actually sent on the wire.
  const key = (id: string) => canonicalCode((id || '').trim()).trim().toUpperCase();

  const aliasOf = new Map<string, string>();
  for (const [from, to] of Object.entries(aliases)) {
    const k = key(from);
    if (k) aliasOf.set(k, key(to));
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

  for (const r of upload.results) {
    const own = key(r.testCode);
    // Try the analyzer's own code first: an alias must never shadow a code that
    // already matches a pending row.
    const ctx = byCode.get(own) ?? (aliasOf.has(own) ? byCode.get(aliasOf.get(own)!) : undefined);
    if (!ctx) {
      unmatched.push(r.testCode);
      continue;
    }
    if (!seen.has(ctx)) {
      seen.add(ctx);
      matched.push(ctx);
    }
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
      resultValue: r.value,
      // The server sets this when it loads the value; we always report false.
      isLoaded: false,
      uniqueIdentifier: ctx.identifier,
      parameterId: ctx.parameterId,
    });
  }

  return { rows, unmatched, matched };
}
