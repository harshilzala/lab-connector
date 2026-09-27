// =============================================================================
// Sysmex U-WAM paired-instrument hold — the fix for partial urine reports.
//
// One urine tube is run on two analyzers behind one U-WAM link: the UC-3500
// reads the strip, the UF-4000 counts the particles, and HMIS holds both sets
// of parameters as ONE panel. The U-WAM often sends the two halves as separate
// ASTM messages seconds or minutes apart (60 of 239 samples on the site's wire
// logs of 2026-09-17/18/19), and filing the first half on arrival marks the
// panel interfaced in HMIS so the report prints with the other instrument's
// rows blank.
//
// What must hold:
//
//   1. one instrument's half alone is HELD — not posted, and HMIS is not even
//      asked about the barcode
//   2. the moment the second half arrives the whole sample files in one post
//   3. a partner that never reports does not block for ever — after
//      maxWaitMs the sample files with what it has
//   4. the console's "file now" (reason "operator") overrides the hold
//   5. an analyzer with no pairing rule is completely unaffected
//   6. a rerun of one half, after the sample already filed, does not re-open
//      the wait for a partner that has been and gone
//   7. with maxWaitMs null there is no backstop: a lone half is held for good,
//      and only the operator's "file now" sends it
//
// Run: npx tsx test/uwam-pairing.test.ts   (npm run uwam:pairing)
// =============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/logger.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import { ResultStore } from '../src/results/store.js';
import { StagedFiler } from '../src/results/filer.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../src/types.js';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const dir = mkdtempSync(join(tmpdir(), 'uwam-pairing-'));
const log = logger.child({ test: 'uwam-pairing' });
log.level = 'silent';
const store = new ResultStore(join(dir, 'results'), log);

// ---- a fake HMIS ------------------------------------------------------------
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
let lookups: string[] = [];
let posted: LisInboundResultRow[][] = [];

const PAIR = { devices: ['UC-3500', 'UF-4000'], maxWaitMs: 10 * 60_000 };
/** The site setting: never file half a panel on a timer. */
const PAIR_NO_BACKSTOP = { devices: ['UC-3500', 'UF-4000'], maxWaitMs: null };

const makeFiler = (pairing: typeof PAIR | typeof PAIR_NO_BACKSTOP | null) =>
  new StagedFiler({
    store,
    orderRows: async (barcode, opts) => {
      lookups.push(`${opts.refresh ? 'live' : 'cache'}:${barcode}`);
      return orders.get(barcode) ?? [];
    },
    join: (upload, rows) => toLisResultRows(upload, rows, undefined, {}, [], {}, []),
    postResults: async (rows) => {
      posted.push(rows);
      return { filed: rows.length, message: 'ok' };
    },
    acknowledge: async () => {},
    log,
    recheckMs: 5 * 60_000,
    pairing,
  });

const filer = makeFiler(PAIR);

/** One U-WAM message: the values one of the two instruments reported. */
const message = (barcode: string, instrument: string, values: Array<[string, string]>): HmisResultUpload => ({
  equipmentId: 1,
  eqCode: 'EC022',
  barcode,
  results: values.map(([testCode, value]) => ({ testCode, value, unit: null, status: 'F', instrument })),
  messageId: `${barcode}-${instrument}-${values.map((v) => v[1]).join(',')}`,
});

const PARTICLES: Array<[string, string]> = [
  ['RBC', '53.8'],
  ['WBC', '2.3'],
  ['BACT', '79.3'],
];
const STRIP: Array<[string, string]> = [
  ['C-PRO', 'Absent'],
  ['C-GLU', 'Absent'],
  ['C-PH', '6.0'],
];

const fullOrder = (barcode: string) =>
  orders.set(barcode, [
    row(barcode, 'RBC', 1),
    row(barcode, 'WBC', 2),
    row(barcode, 'BACT', 3),
    row(barcode, 'C-PRO', 4),
    row(barcode, 'C-GLU', 5),
    row(barcode, 'C-PH', 6),
  ]);

const reset = () => {
  lookups = [];
  posted = [];
};

// =============================================================================
// 1 + 2 — the split message, which is what the lab is hitting
// =============================================================================
const A = 'LB2609190001';
fullOrder(A);
reset();

store.upsert(message(A, 'UF-4000', PARTICLES));
let r = await filer.run('message', A);
check(r.held === 1 && r.filed === 0, 'the UF-4000 half alone is held, not filed');
check(posted.length === 0, 'nothing was posted to HMIS while the strip half is missing');
check(lookups.length === 0, 'HMIS was not even asked for the order while the sample is held');
check((store.get(A)?.lastError ?? '').includes('UC-3500'), 'the console says which instrument the sample is waiting for');

store.upsert(message(A, 'UC-3500', STRIP));
r = await filer.run('message', A);
check(r.filed === 1 && r.held === 0, 'the sample files once the UC-3500 half arrives');
check(posted.length === 1, 'both halves went to HMIS in ONE post, not two');
check(posted[0]?.length === 6, 'all six parameters filed together');
check(store.get(A)?.lastError === null, 'no error left on a filed sample');

// =============================================================================
// 3 — the partner that never reports must not block for ever
// =============================================================================
const B = 'LB2609190002';
fullOrder(B);
reset();

// Received eleven minutes ago: past the ten-minute pairing window.
const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
store.upsert(message(B, 'UF-4000', PARTICLES), elevenMinAgo);
r = await filer.run('timer');
check(r.filed === 1 && r.held === 0, 'after maxWaitMs the sample files without its partner');
check(posted[0]?.length === 3, 'it filed exactly the half it actually has');

// Inside the window it would still be held — the same sample, fresh.
const C = 'LB2609190003';
fullOrder(C);
reset();
store.upsert(message(C, 'UF-4000', PARTICLES));
r = await filer.run('timer');
check(r.held === 1 && posted.length === 0, 'inside the window the same sample is still held');

// =============================================================================
// 7 — no backstop: the lone half never files on a timer, only when the
//     partner reports or the operator says so
// =============================================================================
const noBackstop = makeFiler(PAIR_NO_BACKSTOP);
const G = 'LB2609190007';
fullOrder(G);
reset();
const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
store.upsert(message(G, 'UF-4000', PARTICLES), sevenHoursAgo);
r = await noBackstop.run('timer', G);
check(r.held === 1 && r.filed === 0, 'with maxWaitMs null a seven-hour-old half is still held');
check(posted.length === 0 && lookups.length === 0, 'nothing posted and HMIS not asked while it waits');

store.upsert(message(G, 'UC-3500', STRIP));
r = await noBackstop.run('message', G);
check(r.filed === 1 && posted.length === 1 && posted[0]?.length === 6, 'the partner arriving still files the whole panel at once');

const H = 'LB2609190008';
fullOrder(H);
reset();
store.upsert(message(H, 'UF-4000', PARTICLES), sevenHoursAgo);
r = await noBackstop.run('operator', H);
check(r.filed === 1 && posted[0]?.length === 3, 'the operator "file now" is the only way a lone half leaves the queue');

// =============================================================================
// 4 — the operator can always override from the console
// =============================================================================
reset();
r = await filer.run('operator', C);
check(r.filed === 1, 'the operator "file now" button overrides the hold');
check(posted.length === 1 && posted[0]?.length === 3, 'it posted the half that had arrived');

// =============================================================================
// 5 — every other analyzer is untouched
// =============================================================================
const D = 'CH2609190004';
orders.set(D, [row(D, 'WBC', 7), row(D, 'HGB', 8)]);
reset();
const plain = makeFiler(null);
store.upsert({
  equipmentId: 1,
  eqCode: 'ZHPN001',
  barcode: D,
  results: [
    { testCode: 'WBC', value: '8.1', unit: null, status: 'F' },
    { testCode: 'HGB', value: '13.4', unit: null, status: 'F' },
  ],
  messageId: `${D}-cbc`,
});
r = await plain.run('message', D);
check(r.filed === 1 && r.held === 0, 'an analyzer with no pairing rule files on arrival, as before');

// A U-WAM-shaped sample whose values name NO instrument is not held either:
// holding on absent evidence would stall every sample for the full window.
const E = 'LB2609190005';
orders.set(E, [row(E, 'RBC', 9)]);
reset();
store.upsert({
  equipmentId: 1,
  eqCode: 'EC022',
  barcode: E,
  results: [{ testCode: 'RBC', value: '12.0', unit: null, status: 'F' }],
  messageId: `${E}-noinstrument`,
});
r = await filer.run('message', E);
check(r.filed === 1 && r.held === 0, 'a value that names no instrument is never held');

// =============================================================================
// 6 — a rerun of one half after the sample filed does not re-open the wait
// =============================================================================
reset();
store.upsert(message(A, 'UF-4000', [['RBC', '61.4']]));
r = await filer.run('message', A);
check(r.filed === 1 && r.held === 0, 'a corrected UF-4000 value files at once — the strip half already came');
check(
  posted.length === 1 && posted[0]?.length === 1 && posted[0]?.[0]?.resultValue === '61.4',
  'only the corrected value was re-filed',
);

// -----------------------------------------------------------------------------
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL U-WAM PAIRING TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
