import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { mergePending, normalizePending } from '../src/hmis/pending.js';
import { HmisClient } from '../src/hmis/client.js';

// Multi-site order fetching: a lab that runs its neighbours' tubes asks the
// gateway once per site and merges. Equipment codes are shared group-wide,
// so one siteId hides the other site's rows.
//   Run:  npx tsx test/multi-site.test.ts

const dir = mkdtempSync(join(tmpdir(), 'lab-connector-sites-'));
function cfgWith(hmis: Record<string, unknown>, analyzer: Record<string, unknown>) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      hmis: { baseUrl: 'https://hmis.example.test/portal', ...hmis },
      analyzers: [{ id: 'a', equipmentCode: 'EC014', transport: { type: 'tcp', port: 2031 }, ...analyzer }],
    }),
    'utf8',
  );
  return loadConfig(path);
}

const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silent; } } as any;
const client = (hmis: Record<string, unknown>) =>
  new HmisClient({
    baseUrl: 'https://hmis.example.test',
    pendingPath: '/p',
    acknowledgePath: '/a',
    resultsPath: '/r',
    timeoutMs: 1000,
    tlsRejectUnauthorized: true,
    logger: silent,
    ...hmis,
  });

// ---- 1) schema: numbers become strings, lists default empty ----------------
{
  const c = cfgWith({ siteIds: [2, '3562087'] }, { siteIds: [9246332] });
  assert.deepEqual(c.hmis.siteIds, ['2', '3562087']);
  assert.deepEqual(c.analyzers[0]!.siteIds, ['9246332']);
  const d = cfgWith({}, {});
  assert.deepEqual(d.hmis.siteIds, []);
  assert.deepEqual(d.analyzers[0]!.siteIds, []);
  console.log('✓ schema: siteIds lists, ids coerced to strings');
}

// ---- 2) client default: the list wins over the single id, else one unfiltered call
{
  assert.deepEqual(client({ siteIds: ['2', '3562087'], siteId: '9' }).defaultSiteIds, ['2', '3562087']);
  assert.deepEqual(client({ siteId: '2' }).defaultSiteIds, ['2']);
  assert.deepEqual(client({}).defaultSiteIds, [undefined]);
  console.log('✓ client: hmis.siteIds > hmis.siteId > no filter');
}

// ---- 3) mergePending: the same row seen under two sites is kept once -------
{
  const row = (siteId: number, sample: string, labResultId: number, parameterId: number, code: string) => ({
    SampleID: sample, siteId, labResultId, parameterId, labServiceId: 3141, eqIdntifier: code, resultType: 'PARAMETER',
    equipmentCode: 'EC014', equipmentId: 7,
  });
  const opts = { sampleId: 'LB2609180001', eqCode: 'EC014', equipmentId: null, ipAddress: '', portNo: '', includeTransmitted: false };
  // Gateway ignored the site filter and returned the same two rows for both calls.
  const siteA = normalizePending({ data: [row(2, 'LB2609180001', 501, 11, 'GLU'), row(2, 'LB2609180001', 501, 12, 'PRO')] }, opts);
  const siteB = normalizePending({ data: [row(2, 'LB2609180001', 501, 11, 'GLU'), row(2, 'LB2609180001', 501, 12, 'PRO')] }, opts);
  const merged = mergePending([siteA, siteB]);
  assert.deepEqual(merged.testCodes, ['GLU', 'PRO']);
  assert.equal(merged.ackItems.length, 2, 'one ack row per (sample, labResultId, parameterId, identifier)');
  assert.equal(merged.found, true);

  // Genuinely different rows from two sites both survive.
  const cancer = normalizePending({ data: [row(3562087, 'ZC2609180007', 902, 11, 'GLU')] }, { ...opts, sampleId: 'ZC2609180007' });
  const both = mergePending([siteA, cancer]);
  assert.equal(both.ackItems.length, 3);
  console.log('✓ mergePending: duplicate rows across sites collapse, distinct rows survive');
}

console.log('multi-site: all checks passed');
