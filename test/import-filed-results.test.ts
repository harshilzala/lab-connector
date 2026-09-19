import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultStore, summarize } from '../src/results/store.js';
import { importFiledFromAudit } from '../src/results/import-audit.js';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { assayKey } from '../src/codec/astm/records.js';

// Pins the restore of filed samples from the HMIS transaction log
// (scripts/import-filed-results.ts), run when an analyzer moves from queued
// to staged filing so "Force" reaches samples filed before the switch.
//
//   • an accepted upload's rows become filed values, coded the way the
//     filing join compares them ("1.000000+075+1" → "075" for the ECi),
//   • only what the gateway named in successData counts as filed,
//   • a later upload of the same code wins (a rerun re-filed),
//   • rejected uploads, other machines and uploads before `since` are ignored,
//   • a value the store already holds is never touched,
//   • running it twice adds nothing,
//   • the restored sample Forces like one the analyzer filed live.
//   Run:  npx tsx test/import-filed-results.test.ts

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'lab-audit-import-'));
const logs = join(dir, 'logs');
const store = new ResultStore(join(dir, 'results'), quiet);

const row = (sampleId: string, identifier: string, resultValue: string, labResultId: number) => ({
  sampleId, labServiceId: 4761, labResultId, equipmentId: 222778829, ipAddress: '10.20.1.54', portNo: '4001',
  identifier, resultValue, isLoaded: false, uniqueIdentifier: identifier, parameterId: null,
});
const upload = (ts: string, eqCode: string, rows: ReturnType<typeof row>[], opts: { status?: number; accepted?: number[] } = {}) =>
  JSON.stringify({
    ts, kind: 'result', sampleId: rows[0]?.sampleId ?? '', eqCode, method: 'POST', url: '/results',
    request: rows, httpStatus: opts.status ?? 200,
    response: opts.status && opts.status !== 200
      ? { status: 'error', message: 'gateway down' }
      : { successData: (opts.accepted ?? rows.map((r) => r.labResultId)).map((labResultId) => ({ labResultId })), message: 'data transmitted successfully', status: 'success' },
    outcome: opts.status && opts.status !== 200 ? 'failed' : 'filed',
  });

// Two day files, plus a query line and a broken line that must be skipped.
mkdirSync(logs, { recursive: true });
writeFileSync(
  join(logs, 'hmis-2026-09-18.log'),
  [
    upload('2026-09-18T04:00:00.000Z', 'ZYCAPIFC01', [row('SF2609180001', '1.000000+075+1', '1.10', 1)]), // before `since`
    upload('2026-09-18T09:00:00.000Z', 'ZYCAPIFC01', [row('SF2609180009', '1.000000+035+1', '3.30', 9)]),
  ].join('\n') + '\n',
);
writeFileSync(
  join(logs, 'hmis-2026-09-19.log'),
  [
    '{"ts":"2026-09-19T05:00:00.000Z","kind":"query","eqCode":"ZYCAPIFC01","rows":0}',
    upload('2026-09-19T05:31:29.216Z', 'ZYCAPIFC01', [row('SF2609190004', '1.000000+075+1', '0.441', 93425205)]),
    // two rows sent, the gateway took one
    upload('2026-09-19T06:00:00.000Z', 'ZHFC01', [row('SF2609190014', '1.000000+035+1', '5.559', 14), row('SF2609190014', '1.000000+032+1', '217', 15)], { accepted: [14] }),
    // a rerun re-filed later: the later value must win
    upload('2026-09-19T07:00:00.000Z', 'ZHFC01', [row('SF2609190004', '1.000000+075+1', '0.450', 93425205)]),
    upload('2026-09-19T07:30:00.000Z', 'ZHFC02', [row('SF2609190004', '32', '135', 77)]), // another machine
    upload('2026-09-19T08:00:00.000Z', 'ZYCAPIFC01', [row('SF2609190017', '1.000000+035+1', '5.234', 17)], { status: 502 }),
    // an H360 upload: HMIS spells two of its analytes after the report line
    upload('2026-09-19T08:30:00.000Z', 'ZHFC03', [row('SF2609190040', 'HAEMOGLOBIN', '12.1', 40), row('SF2609190040', 'WBC', '6.2', 41), row('SF2609190040', 'Lymphocytes', '31.0', 42)]),
    '{not json',
  ].join('\n') + '\n',
);

// A value the analyzer sent live and that is still waiting: must survive untouched.
store.upsert(
  { equipmentId: 222778829, eqCode: 'ZYCAPIFC01', barcode: 'SF2609180009', results: [{ testCode: '035', value: '3.31' }], messageId: 'live' },
  '2026-09-18T09:05:00.000Z',
);

const run = () =>
  importFiledFromAudit({
    store,
    files: DailyLogFile.files(join(logs, 'hmis.log')),
    eqCodes: ['ZYCAPIFC01', 'zhfc01'],
    equipmentId: 222778829,
    canonicalCode: assayKey('vitros-eciq'),
    since: new Date('2026-09-18T06:00:00.000Z'),
    log: quiet,
  });

const r1 = run();
assert.equal(r1.uploads, 4, 'the 4 accepted ECi uploads in the window (not the 502, not ZHFC02, not the one before since)');
assert.equal(r1.samples, 2, 'SF2609190004 and SF2609190014 gained values');
assert.equal(r1.values, 2);
assert.equal(r1.skipped, 1, 'the live 035 on SF2609180009 was left alone');
console.log('✓ accepted uploads are read; rejected, foreign and too-old ones are not');

const s4 = store.get('SF2609190004')!;
assert.ok(s4, 'sample restored');
assert.deepEqual(Object.keys(s4.values), ['075'], 'coded the way the ECi join compares (not the HMIS spelling)');
assert.equal(s4.values['075']!.value, '0.450', 'the later re-file wins');
assert.equal(s4.values['075']!.filedAt, '2026-09-19T07:00:00.000Z');
assert.equal(s4.values['075']!.identifier, '1.000000+075+1');
assert.equal(s4.values['075']!.labResultId, 93425205);
assert.equal(summarize(s4).values[0]!.state, 'filed');
assert.ok(summarize(s4).complete, 'nothing waiting — the filer will not touch it');
console.log('✓ values land as filed, under the analyzer code, latest upload first');

const s14 = store.get('SF2609190014')!;
assert.deepEqual(Object.keys(s14.values), ['035'], 'only the row the gateway named in successData');
console.log('✓ a partly accepted upload restores only what HMIS took');

const s9 = store.get('SF2609180009')!;
assert.equal(s9.values['035']!.value, '3.31', 'the live value is untouched');
assert.equal(s9.values['035']!.filedAt, null, 'and still waiting');
console.log('✓ a value the store already holds is never overwritten');

assert.equal(store.get('SF2609190017'), null, 'a 502 filed nothing');
assert.equal(store.get('SF2609180001'), null, 'before since');
assert.ok(!s4.values['32'], 'the 250 upload for the same barcode is not this analyzer');

const r2 = run();
assert.equal(r2.values, 0, 'second run adds nothing');
assert.equal(r2.skipped, 3, 'everything is already held');
console.log('✓ idempotent');

// What Force would send for the restored sample.
const force = store.forceUpload(s4, 'force-1');
assert.deepEqual(force.results.map((r) => [r.testCode, r.value, r.status]), [['075', '0.450', 'F']]);
assert.equal(force.eqCode, 'ZYCAPIFC01');
assert.equal(force.equipmentId, 222778829);
console.log('✓ the restored sample Forces like a live one');

// The analyzer re-sends the sample after the restore (the ECi did exactly this
// at 12:36 on 19 Sep). The log carries no unit, the instrument does: the same
// value with a unit is still the same value — it must stay filed, and learn
// the unit, rather than be marked unfiled and posted again.
const again = store.upsert(
  { equipmentId: 222778829, eqCode: 'ZYCAPIFC01', barcode: 'SF2609190004', results: [{ testCode: '075', value: '0.450', unit: 'ng/mL' }], messageId: 'resend' },
  '2026-09-19T12:36:26.000Z',
);
assert.deepEqual(again.changed, [], 'not a change');
assert.deepEqual(again.unchanged, ['075']);
const s4b = store.get('SF2609190004')!;
assert.equal(s4b.values['075']!.filedAt, '2026-09-19T07:00:00.000Z', 'still filed');
assert.equal(s4b.values['075']!.unit, 'ng/mL', 'unit learned from the analyzer');
const corrected = store.upsert(
  { equipmentId: 222778829, eqCode: 'ZYCAPIFC01', barcode: 'SF2609190004', results: [{ testCode: '075', value: '0.470', unit: 'ng/mL' }], messageId: 'rerun' },
);
assert.deepEqual(corrected.changed, ['075'], 'a different value is a rerun');
assert.equal(store.get('SF2609190004')!.values['075']!.filedAt, null, 'and goes out again');
console.log('✓ an analyzer re-send of a restored value keeps it filed; a rerun still re-files');

// An aliased analyzer: the log holds HMIS's spelling, the store must hold the
// instrument's, or the live "HGB" and a restored "HAEMOGLOBIN" would sit side
// by side and Force would post the value twice.
const h360 = new ResultStore(join(dir, 'results-h360'), quiet);
const rh = importFiledFromAudit({
  store: h360,
  files: DailyLogFile.files(join(logs, 'hmis.log')),
  eqCodes: ['ZHFC03'],
  equipmentId: null,
  aliases: { HGB: 'HAEMOGLOBIN', HCT: 'HEMATOCRIT', 'LYM%': 'Lymphocytes' },
  since: new Date('2026-09-18T06:00:00.000Z'),
  log: quiet,
});
assert.equal(rh.values, 3);
assert.deepEqual(Object.keys(h360.get('SF2609190040')!.values).sort(), ['HGB', 'LYM%', 'WBC'], 'aliases applied in reverse');
assert.equal(h360.get('SF2609190040')!.values['HGB']!.identifier, 'HAEMOGLOBIN', 'filed-against identifier kept as HMIS spells it');
console.log('✓ testCodeAliases are reversed so restored values sit under the analyzer code');

rmSync(dir, { recursive: true, force: true });
console.log('\nALL IMPORT-FILED-RESULTS TESTS PASSED');
