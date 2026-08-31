import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import { loadConfig } from '../src/config.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

// Pins the acknowledge ordering: a pending row is retired only once its RESULT
// has been filed, never at order-download time.
//
// The risk this guards is silent data loss. If a row is acknowledged when the
// order is handed to the analyzer, and the run then fails, the row is retired
// with no value against it — the order disappears from the worklist and nobody
// notices. Acknowledging after the file means the worst case is a duplicate
// download, which is self-healing.
//   Run:  npx tsx test/ack-after-file.test.ts

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig('./config.json');
const analyzer = cfg.analyzers.find((a) => a.id === 'erba-h360')!;

const IDENTIFIERS = ['WBC', 'RBC', 'PLT', 'HAEMOGLOBIN', 'HEMATOCRIT', 'MCV', 'Blasts', 'PARASITE'];
const orderRows: MirthAcknowledgeItem[] = IDENTIFIERS.map((identifier, i) => ({
  sampleID: 'LB2608310044',
  equipmentId: 184919775,
  identifier,
  ipAddress: '10.11.100.59',
  isTransmitted: false,
  labResultId: 92509058,
  labServiceId: 3141,
  portNo: '4002',
  parameterId: 2100 + i,
}));

const wire = readFileSync(join(here, 'fixtures', 'h360-oru.hl7')).toString('utf8');
const parsed = hl7ToParsedMessage(parseHl7(wire), { valueTypes: analyzer.hl7.valueTypes })!;
const upload = toResultUploads(analyzer, parsed)[0]!;

const { rows, matched, unmatched } = toLisResultRows(upload, orderRows, undefined, analyzer.testCodeAliases);

// ---- 1) only the rows actually filed are acknowledged ----------------------
const ackIds = matched.map((m) => m.identifier).sort();
assert.deepEqual(ackIds, ['HAEMOGLOBIN', 'HEMATOCRIT', 'MCV', 'PLT', 'RBC', 'WBC'], 'acknowledged = filed');
assert.ok(!ackIds.includes('Blasts'), 'a parameter the analyzer cannot produce is NOT retired');
assert.ok(!ackIds.includes('PARASITE'), 'a microscopy parameter is NOT retired');
console.log(`✓ ${matched.length}/${orderRows.length} rows acknowledged — only the ones filed`);
console.log(`  left pending: ${IDENTIFIERS.filter((i) => !ackIds.includes(i)).join(', ')}`);

// ---- 2) the acknowledge set matches the filed set exactly ------------------
const filedIds = [...new Set(rows.map((r) => r.identifier))].sort();
assert.deepEqual(ackIds, filedIds, 'every filed row is acknowledged and nothing else is');
assert.equal(matched.length, new Set(matched).size, 'no duplicate rows in the acknowledge body');
console.log('✓ acknowledge set == filed set, no duplicates');

// ---- 3) nothing filed → nothing acknowledged ------------------------------
{
  const none = toLisResultRows(upload, [], undefined, analyzer.testCodeAliases);
  assert.equal(none.rows.length, 0);
  assert.equal(none.matched.length, 0, 'no order rows → nothing to acknowledge');
  assert.equal(none.unmatched.length, 22, 'all 22 analytes reported unmatched');
  console.log('✓ no pending rows → nothing filed and nothing acknowledged');
}

// ---- 4) the acknowledge body carries what the endpoint echoes -------------
for (const m of matched) {
  assert.ok(m.sampleID, 'sampleID');
  assert.ok(m.identifier, 'identifier');
  assert.notEqual(m.labResultId, null, 'labResultId');
  assert.notEqual(m.labServiceId, null, 'labServiceId');
}
console.log('✓ every acknowledge item carries sampleID / identifier / labResultId / labServiceId');

// ---- 5) the orchestrator calls them in the right order --------------------
// Guarded by reading the source: acknowledge must appear AFTER postResults in
// the spool handler, and must not appear in the order-download path at all.
const src = readFileSync(join(here, '..', 'src', 'session', 'orchestrator.ts'), 'utf8');
const post = src.indexOf('this.hmis.postResults(');
const ack = src.indexOf('this.hmis.acknowledge(');
assert.ok(post !== -1 && ack !== -1, 'both calls present');
assert.ok(ack > post, 'acknowledge is called after postResults');
assert.equal(src.split('this.hmis.acknowledge(').length - 1, 1, 'acknowledge is called from exactly one place');

const answerQuery = src.slice(src.indexOf('private async answerQuery('));
const nextMethod = answerQuery.indexOf('\n  private ', 1);
assert.ok(
  !answerQuery.slice(0, nextMethod).includes('this.hmis.acknowledge('),
  'the order-download path must not acknowledge',
);
console.log('✓ orchestrator: acknowledge follows postResults, and never runs at download time');

console.log('\nALL ACKNOWLEDGE-ORDERING TESTS PASSED');
