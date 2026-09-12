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

// Reads the reference config, not the deployed config.json — see the note in
// test/ack-after-file.test.ts. The ZHFC03 corpus below is Nashik's, so the
// analyzer definition it joins against has to be Nashik's too.
const cfg = loadConfig(join(here, 'fixtures', 'reference-config.json'));
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
// LYM# is deliberately NOT aliased. testCodeAliases carries exactly the three
// renames the retired middleware filed; the absolute counts and GRAN%/MID% were
// left out because widening the set is a lab decision, not a connector one.
// What matters for safety is that the unmapped "#" count is not filed at all,
// and above all that it never lands on the "%" parameter — those are different
// analytes and 2.02 filed as 23.7% would be a real, plausible-looking error.
assert.equal(byId.get('Absolute Lymphocyte count*'), undefined, 'LYM# is not filed while it has no alias');
assert.notEqual(byId.get('Lymphocytes'), '2.02', 'the absolute count never lands on the percentage parameter');
console.log('✓ each value lands on the parameter it belongs to');

// Every filed row carries the ids the results endpoint files against.
for (const r of rows) {
  assert.ok(r.labResultId, `${r.identifier} has no labResultId`);
  assert.ok(r.labServiceId, `${r.identifier} has no labServiceId`);
  assert.ok(r.parameterId, `${r.identifier} has no parameterId`);
}
console.log('✓ every filed row carries labResultId / labServiceId / parameterId');

// equipmentId names the machine that produced the value, so it comes from
// config.json — NOT from the pending row, which carries whichever equipment the
// order happened to be raised against.
{
  // The rule is exercised against a FIXTURE id, not whatever config.json holds
  // today: this pins the mapper's behaviour, and a lab editing config.json must
  // not be able to turn the check red or, worse, green-by-omission.
  const CONFIGURED = 424242;
  const configured = { ...analyzer, equipmentId: CONFIGURED } as never;
  const upl = toResultUploads(configured, parsed)[0]!;
  const otherEq = orderRows.map((o) => ({ ...o, equipmentId: 999999999 }));

  for (const r of toLisResultRows(upl, orderRows, undefined, analyzer.testCodeAliases).rows) {
    assert.equal(r.equipmentId, CONFIGURED, `${r.identifier} must report the configured equipmentId`);
  }
  // Pending rows saying something else must not win.
  const viaOther = toLisResultRows(upl, otherEq, undefined, analyzer.testCodeAliases);
  for (const r of viaOther.rows) {
    assert.equal(r.equipmentId, CONFIGURED, 'config wins over the pending row');
  }

  // Whether the LIVE config fills it in is a deployment question, not a code
  // one — but say so, because with it unset every H360 result is filed under
  // whichever equipment the order happened to be raised against.
  if (!analyzer.equipmentId) {
    console.log('  NOTE: config.json sets no equipmentId for this analyzer — results fall back to the pending row');
  }
  // …but a config with no id still falls back rather than sending null.
  const noId = toResultUploads({ ...analyzer, equipmentId: undefined } as never, parsed)[0]!;
  const viaFallback = toLisResultRows(noId, otherEq, undefined, analyzer.testCodeAliases);
  assert.equal(viaFallback.rows[0]!.equipmentId, 999999999, 'falls back to the pending row when config omits it');
  console.log('✓ equipmentId comes from config.json, with the pending row as fallback');
}

console.log('\nALL H360 → ZHFC03 JOIN TESTS PASSED');
