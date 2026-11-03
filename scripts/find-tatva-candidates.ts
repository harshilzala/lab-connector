// Read-only: which Maglumi tubes filed in live HINAI (deploy logs) does the
// Tatva v1 worklist also know? Prints barcode + the values HINAI got.
//
//   Run:  npx tsx scripts/find-tatva-candidates.ts [deployDir] [days]
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { makeTatvaClient, tatvaClientOptions } from '../src/hmis/tatva.js';
import { logger } from '../src/logger.js';

const deployDir = process.argv[2] ?? 'C:/lab/lab-conector-deploy';
const days = Number(process.argv[3] ?? 7);
const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const t = cfg.hmis.tatva;

// 1) Maglumi values HINAI accepted, from the deploy install's audit logs.
const logDir = resolve(deployDir, 'logs');
const results = new Map<string, Map<string, string>>(); // barcode -> identifier -> value
for (const f of readdirSync(logDir).filter((n) => /^hmis-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(n))) {
  for (const line of readFileSync(resolve(logDir, f), 'utf8').split(/\r?\n/)) {
    if (!line.includes('"kind":"result"') || !line.includes('MGAPI1000')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.outcome !== 'filed' || !Array.isArray(e.request)) continue;
    for (const r of e.request) {
      const b = String(r.sampleId).toUpperCase();
      (results.get(b) ?? results.set(b, new Map()).get(b)!).set(r.identifier, r.resultValue);
    }
  }
}
console.log(`Maglumi tubes filed in HINAI (deploy logs): ${results.size}`);

// 2) Ask the Tatva v1 worklist about each tube (?barcode=, read-only).
void days;
const client = makeTatvaClient(tatvaClientOptions(t as never, { timeoutMs: cfg.hmis.timeoutMs, tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized, logger } as never));
const onWorklist = new Set<string>();
for (const b of results.keys()) {
  try {
    const rows = (await client.getPending({ sampleId: b, eqCode: '' } as never)) as unknown[];
    if (rows.length > 0) onWorklist.add(b);
  } catch (err) {
    console.log(`  ${b}: ${(err as Error).message}`);
  }
}
console.log(`Tubes Tatva v1 knows: ${onWorklist.size}`);

// 3) Intersection.
const both = [...results.keys()].filter((b) => onWorklist.has(b));
console.log(`\nIn both: ${both.length}`);
for (const b of both) {
  const v = [...results.get(b)!].map(([k, val]) => `${k}=${val}`).join(', ');
  console.log(`  ${b}  ${v}`);
}
