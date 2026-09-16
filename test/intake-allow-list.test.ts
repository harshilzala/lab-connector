import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interfacedCodeFilter, keepInterfacedResults, willSyncIdentifier } from '../src/mapping/mapper.js';
import { ResultStore, summarize } from '../src/results/store.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';
import type { HmisResultUpload } from '../src/types.js';

// The allow-list is applied at INTAKE, not only at filing: a staged sample
// holds exactly the parameters the interface is scoped to, so the console
// counts "0 of 22", lists 22, and never waits for — or shows — the analyzer's
// other channels. Measured on the Shela BC-5150, 2026-09-12: 60 numeric OBX
// per message, 22 interfaced. Before this the store held all 60 (38 flagged
// "ignored") and the console read "0 of 60 filed — 38 not interfaced".
//   Run:  npx tsx test/intake-allow-list.test.ts

// The 60 NM codes the BC-5150 sent for sample "bhavesh" (wire log), in order.
const SENT = [
  'WBC', 'BAS#', 'BAS%', 'NEU#', 'NEU%', 'EOS#', 'EOS%', 'LYM#', 'LYM%', 'MON#', 'MON%',
  '*ALY#', '*ALY%', '*LIC#', '*LIC%', 'Blast#', 'Blast%', 'Pltclump#', 'Pltclump%', 'Lip#', 'Lip%',
  'PDW-SD', 'NLR', 'PLR', 'Neu-X', 'Neu-Y', 'Neu-Z', 'Lym-X', 'Lym-Y', 'Lym-Z', 'Mon-X', 'Mon-Y', 'Mon-Z',
  'RBC', 'HGB', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD', 'HCT', 'PLT', 'MPV', 'PDW', 'PCT',
  'NRBC#', 'NRBC%', 'PLCC', 'PLCR',
  'WBC Histogram. Total', 'RBC Histogram. Left Line', 'RBC Histogram. Right Line', 'RBC Histogram. Total',
  'PLT Histogram. Left Line', 'PLT Histogram. Right Line', 'PLT Histogram. Total',
  'WBC DIFF Scattergram. Fsc dimension', 'WBC DIFF Scattergram. Ssc dimension',
  'Baso Scattergram. Fsc dimension', 'Baso Scattergram. Ssc dimension',
];
assert.equal(SENT.length, 60);

// The Shela block's allow-list: the 22 the lab scoped the interface to.
const ALLOW = [
  'WBC', 'NEU#', 'LYM#', 'MON#', 'EOS#', 'BAS#', 'NEU%', 'LYM%', 'MON%', 'EOS%', 'BAS%',
  'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'PLT', 'MPV', 'PDW', 'PCT',
];
const IGNORE = PROFILE_LIBRARY['mindray-bc5150'].defaults.ignoreTestCodes as string[];

const upload: HmisResultUpload = {
  equipmentId: null,
  eqCode: 'ZHPN001',
  barcode: 'SF2609120042',
  isQc: false,
  results: SENT.map((code, i) => ({ testCode: code, value: String(i + 1), unit: '%', abnormalFlag: null, status: 'F', completedAt: null })),
  raw: 'MSH|...',
  messageId: 'SF2609120042-test',
};

// ---- 1) the filter: allow-list wins, ignore-list on top, wildcards honoured
{
  const f = interfacedCodeFilter({ allowTestCodes: ALLOW, ignoreTestCodes: IGNORE });
  assert.equal(f.isInterfaced('WBC'), true);
  assert.equal(f.isInterfaced('wbc'), true, 'case-insensitive');
  assert.equal(f.isInterfaced('RDW-SD'), false, 'reportable but outside the allow-list');
  assert.equal(f.isInterfaced('Neu-X'), false, '*-X wildcard');
  assert.equal(f.isInterfaced('WBC Histogram. Total'), false, '*Histogram* wildcard');
  const none = interfacedCodeFilter({ allowTestCodes: [], ignoreTestCodes: ['*-IM'] });
  assert.equal(none.isInterfaced('RDW-SD'), true, 'no allow-list → everything not ignored is interfaced');
  assert.equal(none.isInterfaced('Blasts?-IM'), false);
  console.log('✓ filter: allow-list + ignore-list, wildcards, case-insensitive');
}

// ---- 2) intake keeps the 22 and reports the 38 --------------------------
const f = interfacedCodeFilter({ allowTestCodes: ALLOW, ignoreTestCodes: IGNORE });
const { upload: kept, dropped } = keepInterfacedResults(upload, f);
assert.equal(kept.results.length, 22, '22 interfaced values kept');
assert.equal(dropped.length, 38, '38 other channels dropped at intake');
assert.deepEqual(new Set(kept.results.map((r) => r.testCode)), new Set(ALLOW));
assert.equal(kept.raw, upload.raw, 'raw wire text is kept for the audit trail');
assert.strictEqual(keepInterfacedResults(kept, f).upload, kept, 'nothing to drop → same object back');
console.log('✓ intake: 60 sent → 22 stored, 38 dropped');

// ---- 3) the staged store and console see only the 22 -------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-connector-intake-'));
  const store = new ResultStore(dir);
  store.upsert(kept);
  const s = summarize(store.get('SF2609120042')!);
  assert.equal(s.total, 22, 'console counts "0 of 22"');
  assert.equal(s.waiting, 22);
  assert.equal(s.dropped, 0, 'nothing "not interfaced" to report');
  assert.deepEqual(s.waitingCodes, ALLOW.filter((c) => SENT.includes(c)).sort((a, b) => SENT.indexOf(a) - SENT.indexOf(b)));
  assert.equal(s.values.length, 22, 'the parameter list shown on the console is the interfaced set');
  assert.ok(s.values.every((v) => v.state === 'waiting'));
  assert.equal(s.values[0]!.testCode, 'WBC');
  assert.equal(s.values[0]!.value, '1');
  assert.equal(s.values[0]!.unit, '%');
  console.log(`✓ store: ${s.total} values, ${s.values.length} listed for the console`);
}

// ---- 4) a sample stored by the previous build (all 60, 38 flagged ignored)
//         reads "x of 22" and loses the dead weight on its next update -------
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-connector-legacy-'));
  const store = new ResultStore(dir);
  store.upsert(upload); // the unfiltered 60, as the old build stored them
  const legacy = store.get('SF2609120042')!;
  for (const v of Object.values(legacy.values)) if (!f.isInterfaced(v.testCode)) v.dropped = 'ignored';
  // write it back the way the old filer left it
  (store as any).write(legacy);
  const before = summarize(store.get('SF2609120042')!);
  assert.equal(before.total, 22, 'legacy sample: console counts 22, not 60');
  assert.equal(before.dropped, 0, 'ignored channels are not "not interfaced" noise');
  assert.equal(before.values.length, 22);
  // the analyzer re-sends → the 38 dead values are forgotten on disk
  store.upsert(kept);
  assert.equal(Object.keys(store.get('SF2609120042')!.values).length, 22, 'dead values pruned on the next upsert');
  console.log('✓ legacy 60-value sample: shows 22, pruned to 22 on re-transmit');
}

// ---- 5) the Orders view: which HMIS rows this analyzer will sync ---------
{
  const cfg = {
    allowTestCodes: ALLOW,
    ignoreTestCodes: IGNORE,
    testCodeAliases: { WBC: 'WBC COUNT', RBC: 'RBC COUNT', HGB: 'HAEMOGLOBIN', 'NEU%': 'Neutrophils', 'NEU#': 'Absolute Neutrophil count' },
    excludeIdentifiers: ['WBC', 'RBC', 'PLATELET'],
  };
  const sync = (id: string) => willSyncIdentifier(id, cfg);
  assert.equal(sync('MCV'), true, 'direct match');
  assert.equal(sync('WBC COUNT'), true, 'via alias');
  assert.equal(sync('Neutrophils'), true, 'via alias');
  assert.equal(sync('WBC'), false, 'excluded smear row, even though the instrument code is spelled WBC');
  assert.equal(sync('PLATELET'), false, 'excluded');
  assert.equal(sync('Blasts'), false, 'no instrument code maps to it');
  assert.equal(sync('PERIPHERAL SMEAR FINDINGS/COMMENT'), false);
  assert.equal(sync('RDW-SD'), false, 'reportable but outside the allow-list');
  assert.equal(willSyncIdentifier('ANYTHING', { ...cfg, allowTestCodes: [] }), true, 'no allow-list → every non-excluded row may sync');
  assert.equal(willSyncIdentifier('WBC', { ...cfg, allowTestCodes: [] }), false, '…except excluded ones');
  console.log('✓ orders view: sync / no-sync per HMIS row, aliases and exclusions honoured');
}

console.log('intake-allow-list: all checks passed');
