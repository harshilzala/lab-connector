// =============================================================================
// Barcode completion for the Shela H360 (config barcodeCompletion).
//
// The operators key "SF" + the last four digits on the instrument; HMIS calls
// the sample SF<yymmdd><nnnn>. The retired middleware completed those ids
// (its Results log: sf0054 → SF2608290054 on 2026-08-29); this connector left
// every H360 result since 2026-09-05 waiting under its short id. Pinned here:
//
//   1. the rule builds the full barcode from the short id and the receipt day
//   2. a short id with an order under the full barcode is moved there and files
//   3. a short id with NO such order waits under the short id — never guessed
//   4. the live HMIS lookup is spent on the full barcode, at the recheck cadence
//   5. a sample the operator re-keyed by hand is never completed again
//   6. an id that is not of the short shape (a real barcode, a name) is untouched
//   7. a bad rule is rejected at config time
//
// Run: npx tsx test/h360-barcode-completion.test.ts
// =============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/logger.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import { compileCompletion } from '../src/results/complete.js';
import { ResultStore, summarize } from '../src/results/store.js';
import { StagedFiler } from '../src/results/filer.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../src/types.js';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

// ---- 1) the rule itself ------------------------------------------------------
const RULE = { short: '(?:SF)?0*(\\d{1,4})', full: 'SF{yy}{mm}{dd}{seq:4}' };
const complete = compileCompletion(RULE);
const day = new Date(2026, 8, 15, 10, 30); // 15 Sep 2026, local
check(complete('sf0054', day) === 'SF2609150054', 'sf0054 → SF2609150054 (the 29-08 case, on the 15th)');
check(complete('SF0064', day) === 'SF2609150064', 'SF0064 → SF2609150064');
check(complete('29', day) === 'SF2609150029', 'bare "29" → SF2609150029');
check(complete('029', day) === 'SF2609150029', '"029" → SF2609150029');
check(complete('SF030', day) === 'SF2609150030', '"SF030" → SF2609150030');
check(complete('SF2609150064', day) === null, 'a full barcode is not of the short shape — untouched');
check(complete('NARAYAN', day) === null, 'a name is not of the short shape — untouched');
check(complete('BACKGROND', day) === null, 'a background run is untouched');
check(complete('SF00064', day) === 'SF2609150064', 'five digits keep the last four');

// ---- 7) a bad rule fails at config time -------------------------------------
for (const [bad, why] of [
  [{ short: 'SF\\d{4}', full: 'SF{yy}{mm}{dd}{seq:4}' }, 'no capture group'],
  [{ short: '(\\d+)', full: 'SF{yy}{mm}{dd}' }, 'no {seq} in the template'],
  [{ short: '(\\d+)', full: 'SF{yymmdd}{seq:4}' }, 'unknown token'],
  [{ short: '(\\d+', full: 'SF{seq:4}' }, 'malformed regex'],
] as const) {
  let threw = false;
  try {
    compileCompletion(bad);
  } catch {
    threw = true;
  }
  check(threw, `rejected at config time: ${why}`);
}

// ---- the filer with a fake HMIS ----------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'completion-'));
const log = logger.child({ test: 'completion' });
log.level = 'silent';
const store = new ResultStore(join(dir, 'results'), log);

const orders = new Map<string, MirthAcknowledgeItem[]>();
const row = (barcode: string, identifier: string, labResultId: number): MirthAcknowledgeItem => ({
  sampleID: barcode,
  equipmentId: 184919775,
  identifier,
  ipAddress: '',
  isTransmitted: true,
  labResultId,
  labServiceId: 3141,
  portNo: '',
  parameterId: labResultId,
});
let liveLookups: string[] = [];
let posted: LisInboundResultRow[][] = [];

const filer = new StagedFiler({
  store,
  orderRows: async (barcode, opts) => {
    if (opts.refresh) liveLookups.push(barcode);
    return orders.get(barcode) ?? [];
  },
  join: (upload, rows) => toLisResultRows(upload, rows, undefined, { HGB: 'HAEMOGLOBIN' }, [], {}, []),
  postResults: async (rows) => {
    posted.push(rows);
    return { filed: rows.length, message: 'ok' };
  },
  acknowledge: async () => {},
  log,
  recheckMs: 60_000,
  completeBarcode: complete,
});

const upload = (barcode: string, values: Record<string, string>): HmisResultUpload => ({
  equipmentId: 184919775,
  eqCode: 'ZHFC03',
  barcode,
  isQc: false,
  results: Object.entries(values).map(([testCode, value]) => ({
    testCode,
    value,
    unit: null,
    abnormalFlag: null,
    status: 'F',
    completedAt: null,
  })),
  raw: '',
  messageId: `${barcode}-msg`,
});

// Today's full barcode for sequence 64, as the rule will build it.
const today = new Date();
const FULL64 = complete('SF0064', today)!;
const FULL71 = complete('SF0071', today)!;

// ---- 2) short id with an order under the full barcode: moved and filed ------
orders.set(FULL64, [row(FULL64, 'WBC', 1), row(FULL64, 'HAEMOGLOBIN', 2)]);
store.upsert(upload('SF0064', { WBC: '6.1', HGB: '13.2' }), new Date().toISOString());
await filer.run('arrival', 'SF0064');
check(store.get('SF0064') === null, 'the short id no longer exists as a staged sample');
const moved = store.get(FULL64);
check(!!moved && moved.rekeyedFrom === 'SF0064', `moved to ${FULL64}, re-keyed from SF0064`);
check(!!moved && summarize(moved).filed === 2 && summarize(moved).waiting === 0, 'both values filed under the full barcode');
check(posted.length === 1 && posted[0]!.every((r) => r.sampleId === FULL64), 'HMIS was posted the FULL barcode, not the short id');
check(liveLookups.length === 0, 'no live lookup was needed — the order was cached');

// ---- 3) + 4) short id with NO order: waits, and the live lookup targets the full barcode
posted = [];
liveLookups = [];
store.upsert(upload('SF0071', { WBC: '5.0' }), new Date().toISOString());
await filer.run('arrival', 'SF0071');
check(store.get('SF0071') !== null && store.get(FULL71) === null, 'no order under the full barcode → stays under SF0071, nothing moved');
check(posted.length === 0, 'nothing posted');
check(liveLookups.length === 1 && liveLookups[0] === FULL71, `the one live lookup asked HMIS for ${FULL71}, not SF0071`);
check((store.get('SF0071')?.lastError ?? '').includes(FULL71), 'the sample says which full barcode it is waiting on');
liveLookups = [];
await filer.run('timer');
check(liveLookups.length === 0, 'the next pass respects the recheck cadence (no second live lookup)');
// the order appears later → completes on the next pass
orders.set(FULL71, [row(FULL71, 'WBC', 3)]);
await filer.run('poll');
check(store.get(FULL71)?.rekeyedFrom === 'SF0071' && posted.length === 1, 'once the order appears, SF0071 completes and files');

// ---- 5) an operator re-key is never completed again --------------------------
posted = [];
store.upsert(upload('SF0080', { WBC: '4.4' }), new Date().toISOString());
const yesterday = 'SF2609010080';
orders.set(yesterday, [row(yesterday, 'WBC', 4)]);
store.rekey('SF0080', yesterday); // operator: "that tube is from the 1st"
await filer.run('arrival', yesterday);
check(store.get(yesterday)?.rekeyedFrom === 'SF0080' && posted.length === 1, 'the operator\'s re-key stands and files');
check(!posted[0]!.some((r) => r.sampleId !== yesterday), 'filed under the operator\'s barcode, not a rebuilt one');

// ---- 6) ids not of the short shape are untouched ----------------------------
posted = [];
liveLookups = [];
store.upsert(upload('NARAYAN', { WBC: '7.7' }), new Date().toISOString());
await filer.run('arrival', 'NARAYAN');
check(store.get('NARAYAN') !== null && liveLookups[0] === 'NARAYAN', 'a name is looked up as itself and waits for a re-key');

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
