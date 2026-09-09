import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { normalizePending, unwrapRows } from '../src/hmis/pending.js';
import { OrderStore } from '../src/orders/store.js';
import type { MirthPendingRow } from '../src/types.js';

// =============================================================================
// Seed Lab-Interface's order store from the retired middleware's own logs.
//
// The Old Interface's Orders service (E:\API_Integration\Services\Orders)
// wrote every pending row it pulled from HMIS to
//   ORDERSTRING_<siteId><dd-MM-yy>.txt
// as lines of `<timestamp> : JSON : {"data":[...]}` — and then acknowledged
// those rows, so HMIS will never offer them again. Any result for those tubes
// is unfilable unless the rows come from somewhere else. This reads them back
// out of the log files and writes them into spool/<analyzer>/orders/, after
// which the spool worker can file the results that are parked in failed/.
//
// Rows are routed to the analyzer whose equipmentCode / extraEquipmentCodes
// contains the row's equipmentCode, and are marked as already downloaded: the
// Old Interface pushed them to the instrument itself.
//
// Safe to run while Lab-Interface is up (the store is one atomic file per
// barcode) and safe to run twice (identical rows change nothing).
//
//   npx tsx scripts/import-old-interface-orders.ts [--days 7]
//       [--dir "E:\API_Integration\Services\Orders"] [--config ./config.json]
// =============================================================================

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k?.startsWith('--') && v !== undefined) args.set(k.slice(2), v);
}
const days = Number(args.get('days') ?? '7');
const dir = args.get('dir') ?? 'E:\\API_Integration\\Services\\Orders';
const configPath = args.get('config') ?? './config.json';

const cfg = loadConfig(configPath);
const spoolRoot = resolve(cfg.spoolDir);

// equipmentCode (upper) → analyzer
const byCode = new Map<string, (typeof cfg.analyzers)[number]>();
for (const a of cfg.analyzers) {
  for (const c of [a.equipmentCode, ...a.extraEquipmentCodes]) byCode.set(c.trim().toUpperCase(), a);
}

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const stores = new Map<string, OrderStore>();
const storeFor = (id: string) => {
  let s = stores.get(id);
  if (!s) stores.set(id, (s = new OrderStore(join(spoolRoot, id, 'orders'), quiet)));
  return s;
};

// ORDERSTRING_924633205-09-26.txt → the date is the trailing dd-MM-yy.
const FILE = /^ORDERSTRING_\d+?(\d{2}-\d{2}-\d{2})\.txt$/;
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

const files = readdirSync(dir)
  .filter((f) => FILE.test(f))
  .map((f) => ({ f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
  .filter((x) => x.mtime >= cutoff)
  .sort((a, b) => a.mtime - b.mtime);

// Alternative/additional source: the Orders service's own `order_data` table,
// for days it pulled orders without writing an ORDERSTRING file. Dumped with
//   mysql --batch -e "SELECT SampleID, equipmentCode, eqIdntifier, labResultId,
//     ParamCode AS labServiceId, equipmentId, parameterId, ipAddress, portNo,
//     FName, MName, LName, Gender, DOB, mrn, ... FROM order_data WHERE ..."
// Column names match the gateway's JSON so the same normaliser reads them;
// ParamCode is the labServiceId the gateway reports (order_data has no column
// of that name).
const orderDataTsv = args.get('order-data');

if (files.length === 0 && !orderDataTsv) {
  console.log(`no ORDERSTRING files newer than ${days} day(s) in ${dir}`);
  process.exit(0);
}

const perAnalyzer = new Map<string, { samples: Set<string>; rows: number; skipped: number }>();
const unknownCodes = new Map<string, number>();

/** One batch of rows from either source, in gateway shape. */
const batches: Array<{ label: string; bodies: unknown[] }> = [];
for (const { f, path } of files) {
  const bodies: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf(' : JSON : ');
    if (at < 0) continue;
    try {
      bodies.push(JSON.parse(line.slice(at + ' : JSON : '.length)));
    } catch {
      /* a truncated line at the end of a file being written */
    }
  }
  batches.push({ label: f, bodies });
}
if (orderDataTsv) {
  const lines = readFileSync(orderDataTsv, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = lines[0]!.split('\t');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const row: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const v = cells[i];
      row[h] = v === undefined || v === 'NULL' ? null : v;
    });
    return row;
  });
  batches.push({ label: `${orderDataTsv} (order_data)`, bodies: [{ data: rows }] });
}

for (const { label: f, bodies } of batches) {
  let lineRows = 0;
  for (const body of bodies) {
    const rows = unwrapRows(body);
    if (rows.length === 0) continue;
    lineRows += rows.length;

    // Group by analyzer, then by barcode, then normalise like a live lookup.
    const groups = new Map<string, Map<string, { sampleId: string; rows: MirthPendingRow[] }>>();
    for (const row of rows) {
      const code = String(row['equipmentCode'] ?? row['eqCode'] ?? '').trim().toUpperCase();
      const analyzer = byCode.get(code);
      if (!analyzer) {
        unknownCodes.set(code, (unknownCodes.get(code) ?? 0) + 1);
        continue;
      }
      const sampleRaw = row['SampleID'] ?? row['sampleID'] ?? row['sampleId'];
      if (sampleRaw === undefined || sampleRaw === null) continue;
      const sampleId = String(sampleRaw).trim();
      const key = sampleId.toUpperCase();
      const byBarcode = groups.get(analyzer.id) ?? new Map();
      const g = byBarcode.get(key) ?? { sampleId, rows: [] };
      g.rows.push(row);
      byBarcode.set(key, g);
      groups.set(analyzer.id, byBarcode);
    }

    for (const [analyzerId, byBarcode] of groups) {
      const analyzer = cfg.analyzers.find((a) => a.id === analyzerId)!;
      const store = storeFor(analyzerId);
      const stat = perAnalyzer.get(analyzerId) ?? { samples: new Set<string>(), rows: 0, skipped: 0 };
      for (const [key, g] of byBarcode) {
        const eqCode = String(g.rows[0]!['equipmentCode'] ?? analyzer.equipmentCode);
        const pending = normalizePending(g.rows, {
          sampleId: g.sampleId,
          eqCode,
          equipmentId: analyzer.equipmentId ?? null,
          ipAddress: analyzer.ipAddress ?? '',
          portNo: analyzer.portNo ?? '',
          includeTransmitted: true,
        });
        if (!pending.found) {
          stat.skipped++;
          continue;
        }
        const { order } = store.upsert(g.sampleId, pending, 'import');
        store.markDownloaded(g.sampleId, order.testCodes);
        stat.samples.add(key);
        stat.rows += pending.ackItems.length;
      }
      perAnalyzer.set(analyzerId, stat);
    }
  }
  console.log(`${f}: ${lineRows} row(s)`);
}

console.log('');
for (const [id, s] of perAnalyzer) {
  console.log(`${id.padEnd(14)} ${String(s.samples.size).padStart(4)} sample(s)  ${String(s.rows).padStart(5)} row(s)  store now holds ${storeFor(id).count()}`);
}
if (unknownCodes.size) {
  console.log('');
  console.log('rows for equipment codes no analyzer claims (ignored):');
  for (const [c, n] of unknownCodes) console.log(`  ${c || '(blank)'}: ${n}`);
}
