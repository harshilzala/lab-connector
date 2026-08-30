import { createHash } from 'node:crypto';
import type { AnalyzerConfig } from '../config.js';
import type { HmisResultUpload, ParsedMessage } from '../types.js';

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
