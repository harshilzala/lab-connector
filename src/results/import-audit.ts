import { readFileSync } from 'node:fs';
import type { Logger } from '../logger.js';
import type { LisInboundResultRow } from '../types.js';
import { normalizeBarcode } from '../mapping/mapper.js';
import type { ResultStore } from './store.js';

// =============================================================================
// Fill the staged result store from the HMIS transaction log.
//
// An analyzer that ran QUEUED kept nothing once an upload was accepted — the
// spool item was deleted — so on the day it is switched to staged filing the
// samples it already filed are not on the console and cannot be Forced. The
// transaction log (logs/hmis-<day>.log) holds every POST the gateway took,
// row by row, with the value and the identifier it was filed against. This
// reads those back into the store as filed values, so "Force" can re-push a
// sample filed before the switch exactly as one filed after it.
//
// It only ADDS. A value the store already holds — whatever its state — is left
// alone: the analyzer's own transmission is the truth, and overwriting a
// waiting value with the logged one would mark it unfiled and send it again.
// Where the log holds a sample more than once (a rerun re-filed), the latest
// upload wins. Idempotent: a second run adds nothing.
// =============================================================================

export interface AuditImportOptions {
  store: ResultStore;
  /** The transaction-log files to read, oldest first (DailyLogFile.files). */
  files: string[];
  /** Every equipment code this analyzer files under, any case. */
  eqCodes: string[];
  equipmentId: string | number | null;
  /** HMIS identifier → the analyzer's own test code, the way the filing join
   *  compares them (assayKey for an ASTM dialect; identity otherwise). */
  canonicalCode?: (identifier: string) => string;
  /** The analyzer's testCodeAliases (analyzer code → HMIS identifier). The log
   *  holds the HMIS side ("HAEMOGLOBIN"); the store is keyed on the analyzer's
   *  ("HGB"), so the alias is applied in reverse. Case-insensitive. */
  aliases?: Record<string, string>;
  /** Uploads before this instant are ignored. */
  since: Date;
  log: Logger;
}

export interface AuditImportReport {
  /** Accepted result uploads for this analyzer found in the window. */
  uploads: number;
  /** Samples the store gained values for. */
  samples: number;
  /** Values added, all marked filed. */
  values: number;
  /** Values the store already held under that code — not touched. */
  skipped: number;
}

interface AuditResultRecord {
  ts: string;
  kind: string;
  eqCode?: string;
  httpStatus?: number;
  outcome?: string;
  request?: LisInboundResultRow[];
  response?: { status?: string; successData?: Array<{ labResultId?: number | null }> };
}

interface FiledValue {
  ts: string;
  identifier: string;
  value: string;
  labResultId: number | null;
}

export function importFiledFromAudit(opts: AuditImportOptions): AuditImportReport {
  const report: AuditImportReport = { uploads: 0, samples: 0, values: 0, skipped: 0 };
  const codes = new Set(opts.eqCodes.map((c) => c.trim().toUpperCase()));
  const canonical = opts.canonicalCode ?? ((id: string) => id);
  const unalias = new Map<string, string>();
  for (const [code, identifier] of Object.entries(opts.aliases ?? {})) unalias.set(identifier.trim().toUpperCase(), code);
  const analyzerCode = (identifier: string): string => unalias.get(identifier.trim().toUpperCase()) ?? canonical(identifier);
  const sinceMs = opts.since.getTime();

  // barcode → testCode → latest filed value
  const latest = new Map<string, Map<string, FiledValue>>();
  for (const file of opts.files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"kind":"result"')) continue;
      let rec: AuditResultRecord;
      try {
        rec = JSON.parse(line) as AuditResultRecord;
      } catch {
        continue;
      }
      if (rec.kind !== 'result' || !rec.eqCode || !codes.has(rec.eqCode.toUpperCase())) continue;
      if (rec.httpStatus !== 200 || !Array.isArray(rec.request)) continue;
      if (rec.outcome !== 'filed' && rec.response?.status !== 'success') continue;
      const ts = Date.parse(rec.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      report.uploads++;

      // The gateway names what it took; anything else in the body did not file.
      const accepted = rec.response?.successData;
      const taken = Array.isArray(accepted)
        ? new Set(accepted.map((r) => r.labResultId).filter((id): id is number => typeof id === 'number'))
        : null;

      for (const row of rec.request) {
        if (!row || typeof row.sampleId !== 'string' || typeof row.identifier !== 'string') continue;
        if (taken && (row.labResultId === null || !taken.has(row.labResultId))) continue;
        const barcode = normalizeBarcode(row.sampleId);
        const testCode = analyzerCode(row.identifier);
        if (!barcode || !testCode) continue;
        let bySample = latest.get(barcode);
        if (!bySample) latest.set(barcode, (bySample = new Map()));
        const have = bySample.get(testCode);
        if (!have || have.ts < rec.ts) {
          bySample.set(testCode, { ts: rec.ts, identifier: row.identifier, value: String(row.resultValue), labResultId: row.labResultId ?? null });
        }
      }
    }
  }

  for (const [barcode, bySample] of latest) {
    const existing = opts.store.get(barcode);
    const fresh = [...bySample.entries()].filter(([code]) => {
      const held = existing?.values[code] !== undefined;
      if (held) report.skipped++;
      return !held;
    });
    if (fresh.length === 0) continue;
    // One upsert per upload instant so each value keeps the time it was filed.
    const byTs = new Map<string, Array<[string, FiledValue]>>();
    for (const entry of fresh) {
      const list = byTs.get(entry[1].ts) ?? [];
      list.push(entry);
      byTs.set(entry[1].ts, list);
    }
    for (const [ts, entries] of [...byTs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      opts.store.upsert(
        {
          equipmentId: opts.equipmentId,
          eqCode: opts.eqCodes[0] ?? '',
          barcode,
          isQc: false,
          results: entries.map(([testCode, v]) => ({ testCode, value: v.value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
          messageId: `audit-import-${barcode}-${ts}`,
        },
        ts,
      );
      opts.store.markFiled(
        barcode,
        entries.map(([testCode, v]) => ({ testCode, identifier: v.identifier, labResultId: v.labResultId })),
        ts,
      );
    }
    report.samples++;
    report.values += fresh.length;
    opts.log.info({ barcode, values: fresh.map(([c]) => c) }, 'filed values restored from the HMIS transaction log');
  }
  return report;
}
