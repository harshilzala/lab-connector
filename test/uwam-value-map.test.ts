import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem } from '../src/types.js';

// Pins the lab's value table for the Sysmex U-WAM strip pads (2026-09-18):
//
//   identifier   from the instrument   sent to HMIS
//   C-PRO        -                     Absent
//                +-                    trace
//                1+ … 4+               1+ … 4+
//   C-GLU        (as C-PRO)
//   C-KET        -                     Absent        1+ … 4+ pass through
//   C-URO        -                     Normal        1+ … 4+ pass through
//   C-BIL        -                     Absent        1+ … 4+ pass through
//   C-NIT        -                     Negative
//                +                     Positive
//
// The map rides on the sysmex-uwam profile and is applied at delivery time
// (toLisResultRows), after the grade-vs-concentration choice in the parser.
//   Run:  npx tsx test/uwam-value-map.test.ts

const dir = mkdtempSync(join(tmpdir(), 'lab-uwam-words-'));
writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://hmis.test/live/portal' },
    analyzers: [{ id: 'sysmex-uwam', profile: 'sysmex-uwam', equipmentCode: 'EC021', transport: { type: 'tcp', port: 15255 } }],
  }),
);
const cfg = loadConfig(join(dir, 'config.json')).analyzers[0]!;
rmSync(dir, { recursive: true, force: true });

const PADS = ['C-PRO', 'C-GLU', 'C-KET', 'C-URO', 'C-BIL', 'C-NIT', 'C-BLD', 'C-LEU', 'C-CLOUD'];
const orderRows: MirthAcknowledgeItem[] = PADS.map((identifier, i) => ({
  sampleID: 'LB2609180500', identifier, labServiceId: 414, parameterId: 90 + i, labResultId: 93390000,
  equipmentId: 19232485, ipAddress: '10.11.103.21', portNo: '2031', resultType: 'PARAMETER', isTransmitted: true,
})) as unknown as MirthAcknowledgeItem[];

function sent(values: Record<string, string>): Record<string, string> {
  const upload = {
    barcode: 'LB2609180500', eqCode: 'EC021', equipmentId: null, isQc: false, messageId: 'm', raw: '',
    results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: 'N', status: 'F', completedAt: null })),
  } as unknown as HmisResultUpload;
  const joined = toLisResultRows(upload, orderRows, undefined, cfg.testCodeAliases, cfg.ignoreTestCodes, cfg.testCodeScale,
    cfg.allowTestCodes, cfg.excludeIdentifiers, cfg.excludeParameterIds, cfg.testValueMap);
  assert.deepEqual(joined.unmatched, [], 'every pad has a row');
  return Object.fromEntries(joined.rows.map((r) => [r.identifier, r.resultValue]));
}

// ---- the table, row by row ------------------------------------------------
const table: Array<[string, string, string]> = [
  ['C-PRO', '-', 'Absent'], ['C-PRO', '+-', 'trace'], ['C-PRO', '1+', '1+'], ['C-PRO', '2+', '2+'], ['C-PRO', '3+', '3+'], ['C-PRO', '4+', '4+'],
  ['C-GLU', '-', 'Absent'], ['C-GLU', '+-', 'trace'], ['C-GLU', '1+', '1+'], ['C-GLU', '4+', '4+'],
  ['C-KET', '-', 'Absent'], ['C-KET', '1+', '1+'], ['C-KET', '4+', '4+'],
  ['C-URO', '-', 'Normal'], ['C-URO', 'normal', 'Normal'], ['C-URO', '1+', '1+'], ['C-URO', '4+', '4+'],
  ['C-BIL', '-', 'Absent'], ['C-BIL', '1+', '1+'], ['C-BIL', '4+', '4+'],
  ['C-NIT', '-', 'Negative'], ['C-NIT', '+', 'Positive'],
];
for (const [pad, from, to] of table) {
  assert.equal(sent({ [pad]: from })[pad], to, `${pad} "${from}" -> "${to}"`);
}
console.log(`✓ ${table.length} table rows: "-" -> Absent/Negative/Normal, "+-" -> trace, "+" -> Positive, grades pass through`);

// ---- pads the table does not name are filed as the instrument sends them ---
assert.deepEqual(sent({ 'C-BLD': '-', 'C-LEU': '-', 'C-CLOUD': '-', 'C-BLD': '+-' } as Record<string, string>),
  { 'C-BLD': '+-', 'C-LEU': '-', 'C-CLOUD': '-' });
console.log('✓ C-BLD / C-LEU / C-CLOUD untouched');

// ---- a whole strip at once, as one U-WAM message files ----------------------
assert.deepEqual(
  sent({ 'C-URO': 'normal', 'C-BLD': '+-', 'C-BIL': '-', 'C-KET': '-', 'C-GLU': '4+', 'C-PRO': '+-', 'C-NIT': '-', 'C-LEU': '2+' }),
  { 'C-URO': 'Normal', 'C-BLD': '+-', 'C-BIL': 'Absent', 'C-KET': 'Absent', 'C-GLU': '4+', 'C-PRO': 'trace', 'C-NIT': 'Negative', 'C-LEU': '2+' },
);
console.log('✓ a full strip files in the lab\'s words');

// ---- an analyzer without the map is unaffected ------------------------------
const bare = toLisResultRows(
  { barcode: 'X', eqCode: 'EC021', equipmentId: null, isQc: false, messageId: 'm', raw: '',
    results: [{ testCode: 'C-PRO', value: '-', unit: null, abnormalFlag: 'N', status: 'F', completedAt: null }] } as unknown as HmisResultUpload,
  orderRows,
);
assert.equal(bare.rows[0]!.resultValue, '-', 'no map, no change');
assert.deepEqual(bare.translated, []);
console.log('✓ without a map the value passes through');

console.log('uwam-value-map: all checks passed');
