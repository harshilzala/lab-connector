import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { roundResultValue, toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem } from '../src/types.js';

// Pins the lab's whole-number reporting for the UF-4000 epithelial cell
// counts (asked for 2026-09-19): EC, Squa.EC, Non SEC and RTEC arrive in /HPF
// with one decimal ("0.9") and file rounded ("1"). Every other parameter
// keeps the instrument's decimal. `testCodeDecimals` is a site-block setting,
// applied at delivery time in toLisResultRows, after scaling and before the
// word map.
//   Run:  npx tsx test/uwam-decimals.test.ts

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log('✓', name); } catch (e) { failures++; console.log('✗', name, '\n   ', (e as Error).message); }
}

// ---- the helper on its own ---------------------------------------------------
check('rounds half up and drops the decimal', () => {
  assert.equal(roundResultValue('0.9', 0), '1');
  assert.equal(roundResultValue('1.0', 0), '1');
  assert.equal(roundResultValue('0.5', 0), '1');
  assert.equal(roundResultValue('0.4', 0), '0');
  assert.equal(roundResultValue('0.0', 0), '0');
  assert.equal(roundResultValue('12.49', 0), '12');
  assert.equal(roundResultValue('2.345', 2), '2.35');
});
check('a non-numeric value is left exactly as sent', () => {
  for (const v of ['-', '+-', '<0.1', '****', '', ' ', '1+', 'abs']) assert.equal(roundResultValue(v, 0), v);
});

// ---- through the delivery join, with the site's setting ----------------------
const dir = mkdtempSync(join(tmpdir(), 'lab-uwam-decimals-'));
writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://hmis.test/live/portal' },
    analyzers: [{
      id: 'sysmex-uwam', profile: 'sysmex-uwam', equipmentCode: 'EC022', transport: { type: 'tcp', port: 15256 },
      testCodeDecimals: { EC: 0, 'Squa.EC': 0, 'Non SEC': 0, RTEC: 0 },
    }],
  }),
);
const cfg = loadConfig(join(dir, 'config.json')).analyzers[0]!;
rmSync(dir, { recursive: true, force: true });

const CODES = ['EC', 'Squa.EC', 'Non SEC', 'RTEC', 'RBC', 'WBC', 'BACT', 'C-PRO'];
const orderRows: MirthAcknowledgeItem[] = CODES.map((identifier, i) => ({
  sampleID: 'LB2609190759', identifier, labServiceId: 414, parameterId: 90 + i, labResultId: 93452411,
  equipmentId: 225358334, ipAddress: '10.11.102.16', portNo: '2031', resultType: 'PARAMETER', isTransmitted: true,
})) as unknown as MirthAcknowledgeItem[];

function sent(values: Record<string, string>) {
  const upload = {
    barcode: 'LB2609190759', eqCode: 'EC022', equipmentId: null, isQc: false, messageId: 'm', raw: '',
    results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: 'N', status: 'F', completedAt: null })),
  } as unknown as HmisResultUpload;
  const joined = toLisResultRows(upload, orderRows, undefined, cfg.testCodeAliases, cfg.ignoreTestCodes, cfg.testCodeScale,
    cfg.allowTestCodes, cfg.excludeIdentifiers, cfg.excludeParameterIds, cfg.testValueMap, cfg.testCodeDecimals);
  assert.deepEqual(joined.unmatched, [], 'every code has a row');
  return { values: Object.fromEntries(joined.rows.map((r) => [r.identifier, r.resultValue])), rounded: joined.rounded };
}

check('the four epithelial counts file as whole numbers', () => {
  const { values, rounded } = sent({ EC: '1.0', 'Squa.EC': '0.9', 'Non SEC': '0.1', RTEC: '0.5' });
  assert.deepEqual(values, { EC: '1', 'Squa.EC': '1', 'Non SEC': '0', RTEC: '1' });
  assert.deepEqual(rounded.sort(), ['EC 1.0->1', 'Non SEC 0.1->0', 'RTEC 0.5->1', 'Squa.EC 0.9->1'].sort());
});
check('every other parameter keeps its decimal', () => {
  const { values, rounded } = sent({ RBC: '0.5', WBC: '0.2', BACT: '176.3' });
  assert.deepEqual(values, { RBC: '0.5', WBC: '0.2', BACT: '176.3' });
  assert.deepEqual(rounded, []);
});
check('the word map still applies to the strip after rounding is skipped', () => {
  const { values } = sent({ 'C-PRO': '-' });
  assert.equal(values['C-PRO'], 'Absent');
});
check('the site config carries the setting and the profile default is empty', () => {
  assert.deepEqual(cfg.testCodeDecimals, { EC: 0, 'Squa.EC': 0, 'Non SEC': 0, RTEC: 0 });
});

console.log(failures === 0 ? '\nuwam-decimals: all checks passed' : `\nuwam-decimals: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
