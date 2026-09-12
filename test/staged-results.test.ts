// =============================================================================
// Staged filing (filing.mode "staged") — the retired middleware's behaviour on
// the HMIS API, pinned against a fake gateway.
//
// What the lab relied on in the old Lab Integration.exe and must hold here:
//
//   1. a sample run BEFORE its order exists waits, and files when it appears
//   2. one such sample never holds up another whose order does exist
//   3. a partly ordered sample files what it can and waits for the rest
//   4. a re-sent message changes nothing; a rerun with a new value re-files it
//   5. a mistyped id is re-keyed to the real barcode and files
//   6. non-interfaced codes are dropped, not left waiting
//   7. a gateway outage stops the pass, and the next pass carries on
//   8. an HMIS lookup for a waiting sample happens once, then at recheckMs
//
// Run: npx tsx test/staged-results.test.ts   (npm run staged)
// =============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/logger.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import { ResultStore, summarize } from '../src/results/store.js';
import { StagedFiler } from '../src/results/filer.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../src/types.js';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const dir = mkdtempSync(join(tmpdir(), 'staged-'));
const log = logger.child({ test: 'staged' });
log.level = 'silent';
const store = new ResultStore(join(dir, 'results'), log);

// ---- a fake HMIS: orders per barcode, and a record of what was posted -------
const orders = new Map<string, MirthAcknowledgeItem[]>();
const row = (barcode: string, identifier: string, labResultId: number): MirthAcknowledgeItem => ({
  sampleID: barcode,
  equipmentId: 1,
  identifier,
  ipAddress: '',
  isTransmitted: true,
  labResultId,
  labServiceId: 1,
  portNo: '',
  parameterId: labResultId,
});
let liveLookups: string[] = [];
let posted: LisInboundResultRow[][] = [];
let acked: MirthAcknowledgeItem[][] = [];
let gatewayDown = false;

const filer = new StagedFiler({
  store,
  orderRows: async (barcode, opts) => {
    if (opts.refresh) {
      if (gatewayDown) throw new Error('fetch failed');
      liveLookups.push(barcode);
    }
    return orders.get(barcode) ?? [];
  },
  join: (upload, rows) => toLisResultRows(upload, rows, undefined, {}, ['*-IM'], {}, []),
  postResults: async (rows) => {
    if (gatewayDown) throw new Error('fetch failed');
    posted.push(rows);
    return { filed: rows.length, message: 'ok' };
  },
  acknowledge: async (rows) => {
    acked.push(rows);
  },
  log,
  recheckMs: 60_000,
});

const upload = (barcode: string, values: Record<string, string>): HmisResultUpload => ({
  equipmentId: 1,
  eqCode: 'EQ',
  barcode,
  isQc: false,
  results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
  messageId: `${barcode}-${Object.values(values).join('|')}`,
});
const sum = (b: string) => summarize(store.get(b)!);

// ---- 1 + 2: order-less sample first, ordered sample second -----------------
store.upsert(upload('A1', { WBC: '5.1', HGB: '12.0' })); // no order in HMIS yet
orders.set('B1', [row('B1', 'WBC', 101), row('B1', 'HGB', 102)]);
store.upsert(upload('B1', { WBC: '7.2', HGB: '13.1' }));

let r = await filer.run('test');
check(r.samples === 2 && r.filed === 1 && r.waiting === 1 && r.errors === 0, `pass: 2 samples, 1 filed, 1 waiting (got ${JSON.stringify(r)})`);
check(sum('B1').complete && sum('B1').filed === 2, 'B1 (order exists) filed both values even though A1 was ahead of it');
check(!sum('A1').complete && sum('A1').waiting === 2 && sum('A1').filed === 0, 'A1 (no order) is waiting, not failed, not parked');
check(acked.length === 1 && acked[0]!.length === 2, 'B1 rows acknowledged after filing');
check(liveLookups.filter((b) => b === 'A1').length === 1, 'A1 was looked up at HMIS exactly once on first sight');

// A second pass inside recheckMs: no new lookup, still waiting, no error.
liveLookups = [];
r = await filer.run('test');
check(r.waiting === 1 && r.errors === 0 && liveLookups.length === 0, 'inside recheckMs the waiting sample is not re-asked at HMIS');
check(sum('A1').attempts === 2 && /^no order row yet/.test(sum('A1').lastError ?? ''), 'the sample records why it waits');

// The order appears (as the poll would bring it in) → files on the next pass.
orders.set('A1', [row('A1', 'WBC', 201), row('A1', 'HGB', 202)]);
r = await filer.run('poll');
check(sum('A1').complete && sum('A1').filed === 2, 'A1 filed once its order appeared — no operator action needed');
check(posted.length === 2, 'exactly two uploads posted so far');

// ---- 3: a partly ordered sample ---------------------------------------------
orders.set('C1', [row('C1', 'WBC', 301)]); // HGB not ordered (yet)
store.upsert(upload('C1', { WBC: '4.4', HGB: '9.9' }));
r = await filer.run('message', 'C1');
check(sum('C1').filed === 1 && sum('C1').waiting === 1 && sum('C1').waitingCodes[0] === 'HGB', 'C1: WBC filed, HGB waits for its row');
orders.set('C1', [row('C1', 'WBC', 301), row('C1', 'HGB', 302)]);
await filer.run('poll');
check(sum('C1').complete, 'C1: HGB filed when its row was added to the order');
check(posted[posted.length - 1]!.length === 1 && posted[posted.length - 1]![0]!.identifier === 'HGB', 'only the missing value was posted the second time — no double file of WBC');

// ---- 4: re-send vs rerun -----------------------------------------------------
posted = [];
let up = store.upsert(upload('B1', { WBC: '7.2', HGB: '13.1' }));
check(up.changed.length === 0 && up.unchanged.length === 2, 'identical re-send: nothing changed');
await filer.run('message', 'B1');
check(posted.length === 0 && sum('B1').complete, 'identical re-send: nothing re-posted');
up = store.upsert(upload('B1', { WBC: '7.9', HGB: '13.1' }));
check(up.changed.join() === 'WBC' && sum('B1').waiting === 1, 'rerun with a new WBC re-opens only WBC');
await filer.run('message', 'B1');
check(posted.length === 1 && posted[0]!.length === 1 && posted[0]![0]!.resultValue === '7.9', 'the corrected WBC was filed, and only it');

// ---- 5: re-key a mistyped id ----------------------------------------------
store.upsert(upload('10032026040037', { WBC: '6.0', HGB: '11.5' })); // MRN typed on the instrument
await filer.run('message', '10032026040037');
check(sum('10032026040037').waiting === 2, 'an MRN-keyed sample waits (HMIS knows no such barcode)');
orders.set('ZC2609080001', [row('ZC2609080001', 'WBC', 401), row('ZC2609080001', 'HGB', 402)]);
posted = [];
const moved = store.rekey('10032026040037', 'zc2609080001');
check(moved?.barcode === 'ZC2609080001' && store.get('10032026040037') === null, 're-keyed to the canonical barcode; the old id is gone');
check(moved?.rekeyedFrom === '10032026040037', 'the sample remembers where it came from');
await filer.run('rekey', 'ZC2609080001');
check(sum('ZC2609080001').complete && posted.length === 1 && posted[0]![0]!.sampleId === 'ZC2609080001', 'filed under the real barcode');

// ---- 6: non-interfaced codes are dropped, not left waiting -----------------
orders.set('D1', [row('D1', 'WBC', 501)]);
store.upsert(upload('D1', { WBC: '3.3', 'Blasts-IM': '12' }));
await filer.run('message', 'D1');
check(sum('D1').complete && sum('D1').dropped === 1 && sum('D1').filed === 1, 'the "*-IM" flag score is dropped and the sample is complete');

// ---- 7: gateway outage ---------------------------------------------------------
for (const b of ['E1', 'E2', 'E3', 'E4']) {
  orders.set(b, [row(b, 'WBC', 600)]);
  store.upsert(upload(b, { WBC: '1.0' }));
}
gatewayDown = true;
r = await filer.run('timer');
check(r.errors === 3 && r.samples === 3, `three gateway errors stop the pass (got ${JSON.stringify(r)})`);
check(store.waiting().length === 4, 'nothing was lost or parked during the outage');
gatewayDown = false;
r = await filer.run('timer');
check(r.filed === 4 && store.waiting().length === 0, 'the next pass files all four');

// ---- 8: recheck cadence ---------------------------------------------------------
store.upsert(upload('F1', { WBC: '2.2' }));
liveLookups = [];
await filer.run('timer');
await filer.run('timer');
check(liveLookups.filter((b) => b === 'F1').length === 1, 'a waiting sample is asked at HMIS once, then not again inside recheckMs');
const f1 = store.get('F1')!;
f1.lastCheckedAt = new Date(Date.now() - 120_000).toISOString();
// Write back through the public API to keep the file consistent.
store.recordAttempt('F1', { error: f1.lastError, checkedHmis: false });
store.get('F1')!; // noop read
// recordAttempt does not move lastCheckedAt, so age it via the file directly:
{
  const { readFileSync, writeFileSync } = await import('node:fs');
  const p = join(dir, 'results', 'F1.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.lastCheckedAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(p, JSON.stringify(j));
}
liveLookups = [];
await filer.run('timer');
check(liveLookups.filter((b) => b === 'F1').length === 1, 'after recheckMs it is asked again');

// ---- sweep ----------------------------------------------------------------------
{
  const { readFileSync, writeFileSync } = await import('node:fs');
  const p = join(dir, 'results', 'F1.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.firstReceivedAt = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  writeFileSync(p, JSON.stringify(j));
}
const swept = store.sweep(7, 2);
check(swept.discarded === 1 && store.get('F1') === null, 'a sample waiting longer than retention is discarded');
check(swept.cleared === 0 && store.get('B1') !== null, 'filed samples inside keepFiledDays are kept');

console.log(`\nstore: ${JSON.stringify(store.counts())}`);
rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL STAGED-FILING TESTS PASSED');
