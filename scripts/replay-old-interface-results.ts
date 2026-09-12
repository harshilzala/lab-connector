import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HmisClient } from '../src/hmis/client.js';
import { HmisAudit } from '../src/hmis/audit.js';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { OrderStore } from '../src/orders/store.js';
import { isVoidResult, normalizeBarcode, toLisResultRows } from '../src/mapping/mapper.js';
import { assayKey } from '../src/codec/astm/records.js';
import { logger } from '../src/logger.js';
import type { HmisResultUpload } from '../src/types.js';

// =============================================================================
// One-off migration: file the results the retired middleware received from the
// analyzers but never got into HMIS, using the middleware's own database as
// the reference for what is pending.
//
// Inputs (both produced from the Old Interface, read-only):
//   --results  <tsv>   `equipment_data` rows: s_no, equipment_id, sample_ID,
//                      test_ID, results, alaram, status_flag, dateinserted
//                      (mysql --batch output, header row included)
//   --old-filed <json> rows HMIS accepted from the Old Interface's Results
//                      service, parsed out of its JSONSTRING_result.Log:
//                      [{ sampleId, labResultId, parameterId, ... }]
//
// A (sample, test) is PENDING when the analyzer reported a real value for it
// and neither system has had that row accepted by HMIS. Concretely, a row is
// skipped when its (sampleId, labResultId, parameterId) appears in --old-filed
// or in this connector's own audit log (logs/hmis-YYYY-MM-DD.log). The latest value per
// (sample, test) wins; "No Result" placeholders are ignored.
//
// Rows are joined to the order store (spool/<analyzer>/orders) exactly as a
// live result would be, so labResultId/labServiceId/parameterId come from the
// HMIS order row, never from the old database. Seed the store first:
//     npm run import:old-orders -- --days 15
//
// Nothing is written without --post. With it, each sample is POSTed once,
// the rows HMIS accepts are acknowledged, and a per-sample report is printed.
// HMIS answering successData:[] for a row (the order was completed some other
// way, typically keyed in by hand) is reported, not retried.
//
//   npx tsx scripts/replay-old-interface-results.ts --results .scratch/eqdata.tsv \
//       --old-filed .scratch/old-filed.json [--since 2026-08-25] [--post]
// =============================================================================

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : d;
};
const resultsPath = opt('results');
const oldFiledPath = opt('old-filed');
const since = opt('since', '2026-08-25')!;
const post = flag('post');
if (!resultsPath || !oldFiledPath) {
  console.error('usage: --results <equipment_data.tsv> --old-filed <old-filed.json> [--since YYYY-MM-DD] [--post]');
  process.exit(2);
}

const cfg = loadConfig(opt('config', './config.json'));
const spoolRoot = resolve(cfg.spoolDir);
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;

// Old Interface machine number → analyzer (equipments_master: 2000/2001/2002).
const BY_MACHINE: Record<string, string> = { '2000': 'vitros-eciq', '2001': 'vitros-250', '2002': 'erba-h360' };

// ---- what HMIS has already accepted -----------------------------------------
// parameterId is only meaningful for parameter-type services (CBC); the Old
// Interface sent "0" for everything else and the gateway echoes it, while the
// pending row carries null. Fold both to '' so the same row matches.
const noParam = (p: unknown) => p === null || p === undefined || p === '' || String(p) === '0';
const filedKey = (sampleId: string, labResultId: unknown, parameterId: unknown) =>
  `${normalizeBarcode(String(sampleId))}|${labResultId ?? ''}|${noParam(parameterId) ? '' : parameterId}`;
const filed = new Set<string>();
for (const r of JSON.parse(readFileSync(oldFiledPath, 'utf8')) as Array<{ sampleId: string; labResultId: unknown; parameterId: unknown }>) {
  filed.add(filedKey(r.sampleId, r.labResultId, r.parameterId));
}
const oldFiledCount = filed.size;
try {
  // Every day file of the HMIS log, so a result this connector filed weeks
  // ago is still seen as already accepted.
  const auditLines = DailyLogFile.files(resolve(cfg.hmis.auditLog ?? './logs/hmis.log')).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n'),
  );
  for (const line of auditLines) {
    if (!line.includes('"kind":"result"')) continue;
    const e = JSON.parse(line) as { response?: { successData?: Array<{ sampleId?: string; labResultId?: unknown; parameterId?: unknown }> } };
    for (const s of e.response?.successData ?? []) if (s.sampleId) filed.add(filedKey(s.sampleId, s.labResultId, s.parameterId));
  }
} catch {
  /* no audit log yet */
}
console.log(`already accepted by HMIS: ${oldFiledCount} rows via the Old Interface, ${filed.size - oldFiledCount} via this connector`);

// ---- latest real value per (machine, sample, test) --------------------------
interface Latest { value: string; at: string; flag: string }
const latest = new Map<string, Map<string, Map<string, Latest>>>(); // analyzer → barcode → test → value
const lines = readFileSync(resultsPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
const header = lines[0]!.split('\t');
const col = (name: string) => header.indexOf(name);
const [cEq, cSample, cTest, cRes, cFlag, cAt] = ['equipment_id', 'sample_ID', 'test_ID', 'results', 'status_flag', 'dateinserted'].map(col);
let rowsRead = 0;
let voids = 0;
for (const line of lines.slice(1)) {
  const f = line.split('\t');
  const at = f[cAt!] ?? '';
  if (at < since) continue;
  rowsRead++;
  const analyzerId = BY_MACHINE[f[cEq!] ?? ''];
  if (!analyzerId) continue;
  const value = (f[cRes!] ?? '').trim();
  if (isVoidResult(value)) {
    voids++;
    continue;
  }
  const barcode = normalizeBarcode(f[cSample!] ?? '');
  const test = (f[cTest!] ?? '').trim();
  if (!barcode || !test) continue;
  const perAnalyzer = latest.get(analyzerId) ?? new Map();
  const perSample = perAnalyzer.get(barcode) ?? new Map();
  const have = perSample.get(test) as Latest | undefined;
  if (!have || have.at <= at) perSample.set(test, { value, at, flag: f[cFlag!] ?? '' });
  perAnalyzer.set(barcode, perSample);
  latest.set(analyzerId, perAnalyzer);
}
console.log(`machine results since ${since}: ${rowsRead} rows (${voids} void placeholders ignored)\n`);

// ---- HMIS client (same audit trail as the live connector) -------------------
const audit = cfg.hmis.auditLog
  ? new HmisAudit(resolve(cfg.hmis.auditLog), logger.child({ mod: 'hmis-audit', replay: true }), cfg.hmis.auditMaxBytes)
  : undefined;
const hmis = new HmisClient({
  baseUrl: cfg.hmis.baseUrl,
  pendingPath: cfg.hmis.pendingPath,
  acknowledgePath: cfg.hmis.acknowledgePath,
  resultsPath: cfg.hmis.resultsPath,
  timeoutMs: cfg.hmis.timeoutMs,
  tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
  logger: quiet,
  audit,
});

interface Report { sample: string; tests: number; pending: number; noOrderRow: string[]; skippedFiled: number; accepted?: number; rejected?: number; error?: string }
const summary: Record<string, { samples: number; pendingRows: number; noRows: number; accepted: number; rejected: number; errors: number; unfilable: string[] }> = {};

for (const [analyzerId, perSample] of latest) {
  const analyzer = cfg.analyzers.find((a) => a.id === analyzerId)!;
  const store = new OrderStore(join(spoolRoot, analyzerId, 'orders'), quiet);
  const canonical = analyzer.protocol === 'astm' ? assayKey(analyzer.astm.dialect) : undefined;
  const s = (summary[analyzerId] ??= { samples: 0, pendingRows: 0, noRows: 0, accepted: 0, rejected: 0, errors: 0, unfilable: [] });
  console.log(`=== ${analyzerId} (${perSample.size} samples with results)`);

  for (const [barcode, tests] of [...perSample].sort()) {
    const upload: HmisResultUpload = {
      equipmentId: analyzer.equipmentId ?? null,
      eqCode: analyzer.equipmentCode,
      barcode,
      results: [...tests].map(([testCode, v]) => ({ testCode, value: v.value, status: 'F', completedAt: v.at })),
      messageId: `replay-${barcode}`,
    };
    const orderRows = store.get(barcode)?.rows ?? [];
    const j = toLisResultRows(upload, orderRows, canonical, analyzer.testCodeAliases);
    const rep: Report = { sample: barcode, tests: tests.size, pending: 0, noOrderRow: j.unmatched, skippedFiled: 0 };

    const rows = j.rows.filter((r) => {
      if (filed.has(filedKey(r.sampleId, r.labResultId, r.parameterId))) {
        rep.skippedFiled++;
        return false;
      }
      return true;
    });
    const keep = new Set(rows.map((r) => r.uniqueIdentifier));
    const ack = j.matched.filter((m) => keep.has(m.identifier));
    rep.pending = rows.length;

    if (orderRows.length === 0) {
      s.noRows++;
      s.unfilable.push(barcode);
    }
    if (rows.length === 0) {
      console.log(`  ${barcode.padEnd(14)} ${String(tests.size).padStart(2)} tests  nothing pending` + (rep.skippedFiled ? ` (${rep.skippedFiled} already in HMIS)` : '') + (orderRows.length === 0 ? '  NO ORDER ROWS' : rep.noOrderRow.length ? `  no row for [${rep.noOrderRow.join(',')}]` : ''));
      continue;
    }
    s.samples++;
    s.pendingRows += rows.length;
    const desc = rows.map((r) => `${r.identifier.replace(/^1\.0+\+|\+1$/g, '')}=${r.resultValue}`).join(' ');

    if (!post) {
      console.log(`  ${barcode.padEnd(14)} ${String(rows.length).padStart(2)} pending  ${desc}` + (rep.skippedFiled ? `  (+${rep.skippedFiled} already in HMIS)` : '') + (rep.noOrderRow.length ? `  no row for [${rep.noOrderRow.join(',')}]` : ''));
      continue;
    }

    try {
      const res = await hmis.postResults(rows);
      const acceptedIds = new Set(res.successData.map((x) => `${x.labResultId}|${x.parameterId ?? ''}`));
      const acceptedAck = ack.filter((m) => acceptedIds.has(`${m.labResultId}|${m.parameterId ?? ''}`));
      rep.accepted = res.filed;
      rep.rejected = rows.length - res.filed;
      s.accepted += res.filed;
      s.rejected += rep.rejected;
      if (acceptedAck.length) await hmis.acknowledge(acceptedAck);
      console.log(`  ${barcode.padEnd(14)} ${String(res.filed).padStart(2)}/${rows.length} accepted  ${desc}` + (rep.rejected ? `  REJECTED ${rep.rejected}` : ''));
    } catch (err) {
      // HmisClient throws when nothing was accepted ("accepted 0 of N") and on
      // transport errors; both are reported and NOT retried.
      const msg = err instanceof Error ? err.message : String(err);
      const zero = /accepted 0 of/.test(msg);
      if (zero) {
        s.rejected += rows.length;
      } else {
        s.errors++;
      }
      console.log(`  ${barcode.padEnd(14)} ${zero ? 'REJECTED by HMIS' : 'ERROR'}  ${desc}  ${zero ? '' : msg}`);
    }
  }
}

console.log('\n=== summary' + (post ? ' (posted)' : ' (dry run — nothing sent)'));
for (const [id, s] of Object.entries(summary)) {
  console.log(`${id.padEnd(12)} samples pending=${s.samples} rows pending=${s.pendingRows}` + (post ? ` accepted=${s.accepted} rejected=${s.rejected} errors=${s.errors}` : '') + `  samples with no order rows=${s.noRows}`);
  if (s.unfilable.length) console.log(`             no order rows: ${s.unfilable.join(' ')}`);
}
if (post) writeFileSync(resolve('.scratch/replay-report.json'), JSON.stringify(summary, null, 2));
