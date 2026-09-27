import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem } from '../src/types.js';

// Pins how the UF-4000's judgement items file on the U-WAM link
// (lab request 2026-09-19): the numeric RBC-Info. / BACT-Info. codes become
// the manual's words (UF-4000 BO §5.3.4), code 0 ("judgment not performed,
// field left blank", GI §5.6.4) is NOT filed, UTI-Info. is never filed.
// The site aliases the dotted wire codes to HMIS's RBC-Info / BACT-Info.
//   Run:  npx tsx test/uwam-info.test.ts

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log('✓', name); } catch (e) { failures++; console.log('✗', name, '\n   ', (e as Error).message); }
}

const dir = mkdtempSync(join(tmpdir(), 'lab-uwam-info-'));
writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://hmis.test/live/portal' },
    analyzers: [{
      id: 'sysmex-uwam', profile: 'sysmex-uwam', equipmentCode: 'EC022', transport: { type: 'tcp', port: 15257 },
      testCodeAliases: { 'RBC-Info.': 'RBC-Info', 'BACT-Info.': 'BACT-Info' },
    }],
  }),
);
const cfg = loadConfig(join(dir, 'config.json')).analyzers[0]!;
rmSync(dir, { recursive: true, force: true });

const IDS = ['RBC-Info', 'BACT-Info', 'RBC', 'BACT'];
const orderRows: MirthAcknowledgeItem[] = IDS.map((identifier, i) => ({
  sampleID: 'LB2609190051', identifier, labServiceId: 414, parameterId: 5960 + i, labResultId: 93452411,
  equipmentId: 225358334, ipAddress: '10.11.102.16', portNo: '2031', resultType: 'PARAMETER', isTransmitted: true,
})) as unknown as MirthAcknowledgeItem[];

function join_(values: Record<string, string>) {
  const upload = {
    barcode: 'LB2609190051', eqCode: 'EC022', equipmentId: null, isQc: false, messageId: 'm', raw: '',
    results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: 'N', status: 'F', completedAt: null })),
  } as unknown as HmisResultUpload;
  const j = toLisResultRows(upload, orderRows, undefined, cfg.testCodeAliases, cfg.ignoreTestCodes, cfg.testCodeScale,
    cfg.allowTestCodes, cfg.excludeIdentifiers, cfg.excludeParameterIds, cfg.testValueMap, cfg.testCodeDecimals);
  return { values: Object.fromEntries(j.rows.map((r) => [r.identifier, r.resultValue])), voided: j.voided, ignored: j.ignored, unmatched: j.unmatched, translated: j.translated };
}

check('RBC-Info codes 1-3 file as the manual’s words into the RBC-Info row', () => {
  // HMIS holds the row as a coded list (lab, 2026-09-21): the CODE is sent.
  // 1 Isomorphic type, 2 Dismorphic type, 3 Mixed type, 0 Unclassified.
  assert.equal(join_({ 'RBC-Info.': '1' }).values['RBC-Info'], '1');
  assert.equal(join_({ 'RBC-Info.': '2' }).values['RBC-Info'], '2');
  assert.equal(join_({ 'RBC-Info.': '3' }).values['RBC-Info'], '3');
  assert.equal(join_({ 'RBC-Info.': '0' }).values['RBC-Info'], '0');
});
check('BACT-Info codes 1-4 file as the manual’s words into the BACT-Info row', () => {
  // Settings-screen order (BO), confirmed on LB2609190776: code 2 = Gram Positive?
  // 1 Gram Negative, 2 Gram positive, 3 Gram mixed, 0 Unclassified.
  assert.equal(join_({ 'BACT-Info.': '1' }).values['BACT-Info'], '1');
  assert.equal(join_({ 'BACT-Info.': '2' }).values['BACT-Info'], '2');
  assert.equal(join_({ 'BACT-Info.': '3' }).values['BACT-Info'], '3');
  assert.equal(join_({ 'BACT-Info.': '0' }).values['BACT-Info'], '0');
  // Wire 4 is Sysmex's "Unclassified" (too few bacteria to type) → the lab's 0.
  assert.equal(join_({ 'BACT-Info.': '4' }).values['BACT-Info'], '0');
});
check('code 0 files as 0 (the lab\'s Unclassified), and the rest of the tube files with it', () => {
  const j = join_({ 'RBC-Info.': '0', 'BACT-Info.': '4', RBC: '2.1', BACT: '27.2' });
  assert.deepEqual(j.values, { 'RBC-Info': '0', 'BACT-Info': '0', RBC: '2.1', BACT: '27.2' });
  assert.deepEqual(j.voided, []);
  assert.deepEqual(j.unmatched, []);
  assert.deepEqual(j.translated, ['BACT-Info. 4->0']);
});
check('UTI-Info. is still ignored (HMIS has no row for it)', () => {
  const j = join_({ 'UTI-Info.': '1', RBC: '1.0' });
  assert.deepEqual(j.ignored, ['UTI-Info.']);
  assert.deepEqual(j.unmatched, []);
});
check('a code outside the table passes through unchanged and is visible in the log', () => {
  const j = join_({ 'BACT-Info.': '7' });
  assert.equal(j.values['BACT-Info'], '7');
});

console.log(failures === 0 ? '\nuwam-info: all checks passed' : `\nuwam-info: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
