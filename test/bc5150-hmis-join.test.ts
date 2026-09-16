import assert from 'node:assert';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem } from '../src/types.js';

// The Shela BC-5150 (ZHPN001) against HMIS's OWN identifier list for its CBC
// service, as returned by the pending endpoint on 2026-09-12.
//
// HMIS names the count parameters by report line ("WBC COUNT", "HAEMOGLOBIN",
// "Neutrophils" …) and, in the same service, carries peripheral-smear rows
// literally named "WBC", "RBC" and "PLATELET". Matching is by exact identifier,
// so without the site mapping the instrument's WBC count filed into the smear
// row — which happened on sample PL2609120001 (WBC 4.76 → parameterId 2166,
// RBC 5.09 → 2152). This pins that, with the block's excludeIdentifiers and
// testCodeAliases, every one of the 22 interfaced analytes lands on its count
// row and none can reach a smear row.
//   Run:  npx tsx test/bc5150-hmis-join.test.ts

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'zhp-bc5150');
if (!analyzer) throw new Error('zhp-bc5150 is not configured');

// parameterId → eqIdntifier, verbatim from the ZHPN001 pending rows.
const HMIS: Array<[number, string]> = [
  [2122, 'RDW-CV'], [2123, 'WBC COUNT'], [2124, 'RBC COUNT'], [2127, 'MCV'], [2128, 'MCHC'], [2129, 'MCH'],
  [2130, 'HAEMOGLOBIN'], [2131, 'HEMATOCRIT'], [2142, 'Blasts'], [2143, 'Neutrophils'], [2144, 'Lymphocytes'],
  [2145, 'Eosinophils'], [2146, 'Monocytes'], [2147, 'Basophils'], [2148, 'Promyelocytes'], [2149, 'Myelocytes'],
  [2150, 'Metamyelocytes'], [2151, 'Band cells'], [2152, 'RBC'], [2162, 'PLATELET'], [2165, 'PARASITE'],
  [2166, 'WBC'], [2168, 'PLATELET COUNT'], [6193, 'MPV'], [6960, 'Absolute Neutrophil count'],
  [6961, 'Absolute Lymphocyte count*'], [6962, 'Absolute Eosinophil count'], [7056, 'PERIPHERAL SMEAR FINDINGS/COMMENT'],
  [12524, 'IMG% ( Immature granulocytes )'], [12525, '% NRBC*'],
  // Seen on PL2609120001's own rows (filed successfully): the two absolute
  // counts HMIS registers under the instrument mnemonic.
  [11305, 'BAS#'], [11304, 'MON#'], [7002, 'PDW'], [6964, 'PCT'],
];
const rows: MirthAcknowledgeItem[] = HMIS.map(([parameterId, identifier]) => ({
  sampleID: 'PL2609120001',
  equipmentId: 224302864,
  identifier,
  ipAddress: '10.20.4.50',
  isTransmitted: true,
  labResultId: 93122704,
  labServiceId: 3141,
  portNo: '5100',
  parameterId,
  resultType: 'PARAMETER',
}));

// The 22 interfaced values, as the BC-5150 sent them for PL2609120001.
const SENT: Array<[string, string]> = [
  ['WBC', '4.76'], ['BAS#', '0.02'], ['BAS%', '0.4'], ['NEU#', '2.51'], ['NEU%', '52.7'], ['EOS#', '0.30'], ['EOS%', '6.3'],
  ['LYM#', '1.18'], ['LYM%', '24.8'], ['MON#', '0.75'], ['MON%', '15.8'], ['RBC', '5.09'], ['HGB', '15.8'], ['MCV', '95.7'],
  ['MCH', '31.0'], ['MCHC', '32.4'], ['RDW-CV', '16.6'], ['HCT', '48.7'], ['PLT', '349'], ['MPV', '8.2'], ['PDW', '16.0'], ['PCT', '0.286'],
];
const upload: HmisResultUpload = {
  equipmentId: null,
  eqCode: 'ZHPN001',
  barcode: 'PL2609120001',
  isQc: false,
  results: SENT.map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
  raw: '',
  messageId: 'PL2609120001-test',
};

const join = (a: typeof analyzer, r: MirthAcknowledgeItem[] = rows) =>
  toLisResultRows(upload, r, undefined, a.testCodeAliases, a.ignoreTestCodes, a.testCodeScale, a.allowTestCodes, a.excludeIdentifiers, a.excludeParameterIds);

// ---- 1) what happened on 2026-09-12: no mapping → counts into smear rows ---
{
  const bare = join({ ...analyzer, testCodeAliases: {}, excludeIdentifiers: [], excludeParameterIds: [] });
  const where = new Map(bare.rows.map((r) => [r.identifier, r.parameterId]));
  assert.equal(where.get('WBC'), 2166, 'reproduces the fault: WBC count filed into the smear "WBC" row');
  assert.equal(where.get('RBC'), 2152, 'reproduces the fault: RBC count filed into the smear "RBC" row');
  assert.equal(bare.rows.length, 11, 'and only 11 of 22 filed at all');
  console.log('✓ without the site mapping the fault of 2026-09-12 reproduces (WBC→2166, RBC→2152, 11 filed)');
}

// ---- 2) with the block's mapping: every count on its count row -------------
{
  const mapped = join(analyzer);
  const where = new Map(mapped.rows.map((r) => [r.identifier, r.parameterId]));
  const expect: Record<string, number> = {
    'WBC COUNT': 2123, 'RBC COUNT': 2124, HAEMOGLOBIN: 2130, HEMATOCRIT: 2131, 'PLATELET COUNT': 2168,
    Neutrophils: 2143, Lymphocytes: 2144, Monocytes: 2146, Eosinophils: 2145, Basophils: 2147,
    'Absolute Neutrophil count': 6960, 'Absolute Lymphocyte count*': 6961, 'Absolute Eosinophil count': 6962,
    'BAS#': 11305, 'MON#': 11304, MCV: 2127, MCH: 2129, MCHC: 2128, 'RDW-CV': 2122, MPV: 6193, PDW: 7002, PCT: 6964,
  };
  for (const [identifier, parameterId] of Object.entries(expect)) {
    assert.equal(where.get(identifier), parameterId, `${identifier} → parameterId ${parameterId}`);
  }
  assert.equal(mapped.rows.length, 22, 'all 22 interfaced analytes file');
  assert.deepEqual(mapped.unmatched, [], 'nothing left waiting');
  const smear = mapped.rows.filter((r) => [2166, 2152, 2162].includes(r.parameterId as number));
  assert.equal(smear.length, 0, 'no value can reach a smear row');
  const wbc = mapped.rows.find((r) => r.identifier === 'WBC COUNT')!;
  assert.equal(wbc.resultValue, '4.76');
  const filedAs = new Map(mapped.filedCodes.map((f) => [f.testCode, f.identifier]));
  assert.equal(filedAs.get('WBC'), 'WBC COUNT');
  assert.equal(filedAs.get('NEU%'), 'Neutrophils');
  assert.equal(filedAs.get('NEU#'), 'Absolute Neutrophil count');
  console.log('✓ with excludeIdentifiers + testCodeAliases: 22 of 22 file, WBC→2123 (WBC COUNT), RBC→2124, none into smear rows');
}

// ---- 3) exclusion alone is safe even without an alias ----------------------
{
  const half = join({ ...analyzer, testCodeAliases: {} });
  const where = new Map(half.rows.map((r) => [r.identifier, r.parameterId]));
  assert.ok(!where.has('WBC') && !where.has('RBC'), 'excluded rows are never used');
  assert.ok(half.unmatched.includes('WBC') && half.unmatched.includes('RBC'), 'the counts wait instead of mis-filing');
  console.log('✓ excludeIdentifiers alone: WBC/RBC wait rather than file into the wrong row');
}

// ---- 4) the HMIS master AFTER the lab's 14:13Z rename ---------------------
// Count rows now carry the instrument mnemonics, so "WBC" names both 2123 and
// the smear row 2166, "RBC" both 2124 and 2152, and the smear PLATELET row
// 2162 was renamed "PCT". Verbatim from the 14:13:09Z poll.
{
  const RENAMED: Array<[number, string]> = [
    [2122, 'RDW-CV'], [2123, 'WBC'], [2124, 'RBC'], [2127, 'MCV'], [2128, 'MCHC'], [2129, 'MCH'],
    [2130, 'HGB'], [2131, 'HCT'], [2142, 'Blasts'], [2143, 'NEU%'], [2144, 'LYM%'], [2145, 'EOS%'],
    [2146, 'MON%'], [2147, 'BAS%'], [2148, 'Promyelocytes'], [2149, 'Myelocytes'], [2150, 'Metamyelocytes'],
    [2151, 'Band cells'], [2152, 'RBC'], [2162, 'PCT'], [2165, 'PARASITE'], [2166, 'WBC'], [2168, 'PLT'],
    [6193, 'MPV'], [6960, 'Absolute Neutrophil count'], [6961, 'Absolute Lymphocyte count*'],
    [6962, 'Absolute Eosinophil count'], [7056, 'PERIPHERAL SMEAR FINDINGS/COMMENT'],
    [12524, 'IMG% ( Immature granulocytes )'], [12525, '% NRBC*'], [11305, 'BAS#'], [11304, 'MON#'], [7002, 'PDW'],
  ];
  // Smear rows listed FIRST, so "first row wins" would pick the wrong one.
  const renamedRows: MirthAcknowledgeItem[] = [...RENAMED]
    .sort(([a], [b]) => ([2166, 2152, 2162].includes(a) ? -1 : 0) - ([2166, 2152, 2162].includes(b) ? -1 : 0))
    .map(([parameterId, identifier]) => ({ ...rows[0]!, identifier, parameterId }));

  // Without exclusions: ambiguous identifiers are withheld, never guessed.
  const bare = join({ ...analyzer, testCodeAliases: {}, excludeIdentifiers: [], excludeParameterIds: [] }, renamedRows);
  assert.deepEqual(bare.ambiguous.sort(), ['RBC', 'WBC'], 'WBC and RBC map to two parameters each → withheld');
  assert.ok(bare.unmatched.includes('WBC') && bare.unmatched.includes('RBC'), 'they wait, they do not file');
  assert.ok(!bare.rows.some((r) => [2166, 2152].includes(r.parameterId as number)), 'nothing into the smear WBC/RBC rows');
  const pctBare = bare.rows.find((r) => r.identifier === 'PCT');
  assert.equal(pctBare?.parameterId, 2162, 'but PCT alone would still land on the renamed smear row 2162');

  // With the block as configured (smear rows excluded by parameterId):
  const now = join(analyzer, renamedRows);
  const where = new Map(now.rows.map((r) => [r.identifier + '@' + r.parameterId, r]));
  assert.ok(where.has('WBC@2123'), 'WBC → the count row 2123');
  assert.ok(where.has('RBC@2124'), 'RBC → the count row 2124');
  assert.ok(where.has('HGB@2130') && where.has('HCT@2131') && where.has('PLT@2168'), 'renamed rows match directly');
  assert.ok(where.has('NEU%@2143') && where.has('LYM%@2144') && where.has('BAS%@2147'), 'differential % rows');
  assert.ok(
    where.has('Absolute Neutrophil count@6960') && where.has('Absolute Lymphocyte count*@6961') && where.has('Absolute Eosinophil count@6962'),
    'absolute counts via the aliases',
  );
  assert.ok(!now.rows.some((r) => [2166, 2152, 2162].includes(r.parameterId as number)), 'no value can reach a smear row');
  assert.deepEqual(now.ambiguous, [], 'exclusions resolve the ambiguity');
  assert.deepEqual(now.unmatched, ['PCT'], 'PCT waits: its only row is the excluded smear row 2162');
  assert.equal(now.rows.length, 21, '21 of 22 file; PCT is held until the lab fixes 2162 / 6964');
  console.log('✓ after the 14:13Z HMIS rename: 21 of 22 file on the right rows, WBC/RBC unambiguous via excludeParameterIds, PCT withheld');
}

console.log('bc5150-hmis-join: all checks passed');
