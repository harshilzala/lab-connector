import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

// Pins the two named HMIS blocks in config.json:
//
//   "hmis": {
//     "api": "hinai" | "genx",      ← the one switch: which gateway gets results
//     "timeoutMs": …,               ← shared
//     "hinai": { baseUrl, siteIds, pendingPath, acknowledgePath, resultsPath },
//     "genx": { baseUrl, clientId, … }
//   }
//
// The loader lifts the `hinai` block to the top of `hmis`, where the HIMS client
// reads it, so nothing downstream changes. A config written before the blocks
// existed (flat hmis, api "mirth" or absent) is read exactly as before.
//   Run:  npx tsx test/hmis-blocks.test.ts

const dir = mkdtempSync(join(tmpdir(), 'lab-hmis-blocks-'));
const analyzer = { id: 'a1', equipmentCode: 'EQ1', transport: { type: 'tcp', port: 15301 } };
const load = (hmis: unknown) => {
  const p = join(dir, `c${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ hmis, analyzers: [analyzer] }));
  return loadConfig(p).hmis;
};
const HIMS = {
  baseUrl: 'http://98.70.1.180:8050/live/portal',
  siteIds: ['2', '3562087'],
  pendingPath: '/mirth/pending',
  acknowledgePath: '/mirth/acknowledge',
  resultsPath: '/mirth/labresult',
};
const GENX = { baseUrl: 'https://uat.genx.example', serviceTests: { CBC: ['WBC', 'HGB', 'PLT'] } };

// 1) hinai enabled: its block is what the HIMS client reads.
const h1 = load({ api: 'hinai', timeoutMs: 9000, hinai: HIMS, genx: GENX });
assert.equal(h1.api, 'hinai');
assert.equal(h1.baseUrl, HIMS.baseUrl);
assert.deepEqual(h1.siteIds, ['2', '3562087']);
assert.equal(h1.resultsPath, '/mirth/labresult');
assert.equal(h1.timeoutMs, 9000, 'shared setting stays at the top');
assert.equal(h1.genx.baseUrl, GENX.baseUrl, 'the idle genx block is kept');
console.log('✓ api "hinai": the hinai block is lifted to where the HIMS client reads it; genx kept idle');

// 2) genx enabled: same file, one word changed — hinai settings remain for switching back.
const h2 = load({ api: 'genx', hinai: HIMS, genx: GENX });
assert.equal(h2.api, 'genx');
assert.equal(h2.genx.baseUrl, GENX.baseUrl);
assert.equal(h2.baseUrl, HIMS.baseUrl, 'hinai stays configured while genx is active');
console.log('✓ api "genx": genx active, hinai still configured');

// 3) genx enabled without a host is refused at load, not half-run.
assert.throws(() => load({ api: 'genx', hinai: HIMS, genx: { baseUrl: '' } }), /genx\.baseUrl: required when hmis\.api is "genx"/);
console.log('✓ api "genx" with no genx.baseUrl is refused');

// 4) a flat config written before the blocks existed reads as it always did.
const h4 = load({ ...HIMS, api: 'mirth' });
assert.equal(h4.api, 'mirth');
assert.equal(h4.baseUrl, HIMS.baseUrl);
assert.deepEqual(h4.siteIds, ['2', '3562087']);
const h4b = load({ ...HIMS });
assert.equal(h4b.api, 'mirth', 'no api = the HIMS gateway, as before');
console.log('✓ old flat hmis block (api "mirth" or absent) unchanged');

// 5) a key inside the hinai block wins over a stale copy left at the top.
const h5 = load({ api: 'hinai', baseUrl: 'http://old.example/live/portal', hinai: HIMS });
assert.equal(h5.baseUrl, HIMS.baseUrl);
console.log('✓ the hinai block wins over a leftover top-level key');

// 6) an unknown gateway name is refused with the valid choices.
assert.throws(() => load({ api: 'genex', hinai: HIMS }), /hmis\.api/);
console.log('✓ an unknown api name is refused');

rmSync(dir, { recursive: true, force: true });
console.log('hmis-blocks: all checks passed');
