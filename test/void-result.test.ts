import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isVoidResult, toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import { loadConfig } from '../src/config.js';
import type { MirthAcknowledgeItem, ParsedMessage } from '../src/types.js';

// Pins the handling of the VITROS "No Result" placeholder.
//
// Seen live: the ECiQ sent `R|1|^^^1.000000+075+1|No Result|...` for a PSA and
// the connector filed the string "No Result" as the value AND acknowledged the
// order row — so when the rerun produced 6.10 there was no pending row left to
// file it against. A placeholder must be dropped, never filed, and must leave
// the row alone.
//   Run:  npx tsx test/void-result.test.ts

assert.ok(isVoidResult('No Result'));
assert.ok(isVoidResult('NO RESULT'));
assert.ok(isVoidResult('  '));
assert.ok(!isVoidResult('0'));
assert.ok(!isVoidResult('<0.02'));
assert.ok(!isVoidResult('4.700'));

// Reads the reference config, not the deployed config.json — see the note in
// test/ack-after-file.test.ts. Every site's VITROS ECiQ is a different analyzer
// id (Nashik "vitros-eciq", Cancer "cancer-vitros-eciq"), and this test pins
// mapper behaviour, not one deployment's naming.
const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(join(here, 'fixtures', 'reference-config.json'));
const eciq = cfg.analyzers.find((a) => a.id === 'vitros-eciq')!;

const msg: ParsedMessage = {
  protocol: 'astm',
  queries: [],
  raw: '',
  results: [
    { sampleId: 'SF2609040041', testCode: '075', value: 'No Result' },
    { sampleId: 'SF2609040041', testCode: '035', value: '2.1' },
    { sampleId: 'SF2609040042', testCode: '075', value: 'No Result' },
  ],
};

// intake: the void is dropped, a sample with nothing real gets no upload at all
const uploads = toResultUploads(eciq, msg);
assert.strictEqual(uploads.length, 1, 'void-only sample produces no upload');
assert.deepStrictEqual(uploads[0]!.results.map((r) => r.testCode), ['035']);

// delivery: a void already sitting in a spooled item is reported, not filed
const row = (identifier: string): MirthAcknowledgeItem => ({
  sampleID: 'SF2609040041', equipmentId: 177335561, identifier, ipAddress: '10.20.1.54', isTransmitted: true,
  labResultId: 1, labServiceId: 1, portNo: '4001', parameterId: null,
});
const parked = {
  ...uploads[0]!,
  results: [
    { testCode: '075', value: 'No Result' },
    { testCode: '035', value: '2.1' },
  ],
};
const j = toLisResultRows(parked, [row('1.000000+075+1'), row('1.000000+035+1')], (id) => id.replace(/^1\.0+\+|\+1$/g, ''));
assert.deepStrictEqual(j.voided, ['075']);
assert.deepStrictEqual(j.unmatched, []);
assert.strictEqual(j.rows.length, 1);
assert.strictEqual(j.rows[0]!.resultValue, '2.1');
assert.strictEqual(j.matched.length, 1, 'only the filed row is acknowledged');
assert.strictEqual(j.matched[0]!.identifier, '1.000000+035+1', 'the voided row stays pending for the rerun');

console.log('void-result: OK');
