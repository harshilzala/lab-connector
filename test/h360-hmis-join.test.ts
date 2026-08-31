import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import { loadConfig } from '../src/config.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

// Joins a real H360 message to the real ZHFC03 CBC parameter set.
//
// ZHFC03 is the CBC equipment: one lab service made of many parameters, each
// registered under its REPORT name ("HAEMOGLOBIN", "Lymphocytes"), while the
// analyzer reports instrument names ("HGB", "LYM%"). A result whose code
// matches no pending row cannot be filed at all, so this pins which of the 22
// analytes reach HMIS and which do not.
//   Run:  npx tsx test/h360-hmis-join.test.ts

const here = dirname(fileURLToPath(import.meta.url));

// The 27 identifiers ZHFC03 actually returns on GET /mirth/pending, verbatim.
const ZHFC03_IDENTIFIERS = [
  '% NRBC*',
  'Absolute Eosinophil count',
  'Absolute Lymphocyte count*',
  'Absolute Neutrophil count',
  'Band cells',
  'Basophils',
  'Blasts',
  'Eosinophils',
  'HAEMOGLOBIN',
  'HEMATOCRIT',
  'IMG% ( Immature granulocytes )',
  'Lymphocytes',
  'MCH',
  'MCHC',
  'MCV',
  'MPV',
  'Metamyelocytes',
  'Monocytes',
  'Myelocytes*',
  'Neutrophils',
  'PARASITE',
  'PERIPHERAL SMEAR FINDINGS/COMMENT',
  'PLT',
  'Promyelocytes',
  'RBC',
  'RDW-CV',
  'WBC',
];

const cfg = loadConfig('./config.json');
const analyzer = cfg.analyzers.find((a) => a.id === 'erba-h360')!;
assert.equal(analyzer.equipmentCode, 'ZHFC03', 'the H360 files against the CBC equipment');

// One pending row per parameter, as the CBC order produces.
const orderRows: MirthAcknowledgeItem[] = ZHFC03_IDENTIFIERS.map((identifier, i) => ({
  sampleID: 'LB2608310044',
  equipmentId: 184919775,
  identifier,
  ipAddress: '10.11.100.59',
  isTransmitted: true,
  labResultId: 92509058,
  labServiceId: 3141,
  portNo: '4002',
  parameterId: 2100 + i,
}));

const wire = readFileSync(join(here, 'fixtures', 'h360-oru.hl7')).toString('utf8');
const parsed = hl7ToParsedMessage(parseHl7(wire), { valueTypes: analyzer.hl7.valueTypes })!;
const upload = toResultUploads(analyzer, parsed)[0]!;
assert.equal(upload.results.length, 22, 'the analyzer reports 22 numeric analytes');
assert.equal(upload.eqCode, 'ZHFC03');

// ---- without aliases: only the codes ZHFC03 already spells the same way ----
{
  const { rows } = toLisResultRows(upload, orderRows);
  const filed = rows.map((r) => r.identifier).sort();
  assert.deepEqual(filed, ['MCH', 'MCHC', 'MCV', 'MPV', 'PLT', 'RBC', 'RDW-CV', 'WBC'], 'exact-name matches only');
  console.log(`✓ without aliases: ${filed.length}/22 file — ${filed.join(', ')}`);
}

// ---- with the configured aliases -------------------------------------------
const { rows, unmatched } = toLisResultRows(upload, orderRows, undefined, analyzer.testCodeAliases);
const filed = rows.map((r) => r.identifier).sort();
console.log(`✓ with aliases   : ${filed.length}/22 file — ${filed.join(', ')}`);
console.log(`  still unmatched: ${unmatched.join(', ')}`);

// Every alias in config must name an identifier ZHFC03 actually has, or it is
// a typo that silently files nothing.
for (const [from, to] of Object.entries(analyzer.testCodeAliases)) {
  assert.ok(
    ZHFC03_IDENTIFIERS.some((id) => id.toUpperCase() === to.toUpperCase()),
    `alias ${from} → "${to}" names no ZHFC03 parameter`,
  );
  assert.ok(
    upload.results.some((r) => r.testCode.toUpperCase() === from.toUpperCase()),
    `alias ${from} → "${to}" names no code the H360 sends`,
  );
}
console.log(`✓ all ${Object.keys(analyzer.testCodeAliases).length} aliases name a real parameter on both sides`);

// An alias must never shadow a code that already matches on its own name.
{
  const shadowed = toLisResultRows(upload, orderRows, undefined, { WBC: 'Lymphocytes' });
  const wbc = shadowed.rows.find((r) => r.resultValue === '8.52');
  assert.equal(wbc?.identifier, 'WBC', 'the analyzer own code wins over an alias');
  console.log('✓ an alias never shadows a code that already matches');
}

// The values must ride with the right parameter — a mis-join files a real
// number against the wrong analyte, which is worse than filing nothing.
const byId = new Map(rows.map((r) => [r.identifier, r.resultValue]));
assert.equal(byId.get('WBC'), '8.52');
assert.equal(byId.get('HAEMOGLOBIN'), '10.9', 'HGB value lands on HAEMOGLOBIN');
assert.equal(byId.get('HEMATOCRIT'), '31.5', 'HCT value lands on HEMATOCRIT');
assert.equal(byId.get('Lymphocytes'), '23.7', 'LYM% lands on the percentage parameter');
assert.equal(byId.get('Absolute Lymphocyte count*'), '2.02', 'LYM# lands on the absolute count');
assert.notEqual(byId.get('Lymphocytes'), byId.get('Absolute Lymphocyte count*'), '% and # are distinct parameters');
console.log('✓ each value lands on the parameter it belongs to');

// Every filed row carries the ids the results endpoint files against.
for (const r of rows) {
  assert.ok(r.labResultId, `${r.identifier} has no labResultId`);
  assert.ok(r.labServiceId, `${r.identifier} has no labServiceId`);
  assert.ok(r.parameterId, `${r.identifier} has no parameterId`);
}
console.log('✓ every filed row carries labResultId / labServiceId / parameterId');

console.log('\nALL H360 → ZHFC03 JOIN TESTS PASSED');
