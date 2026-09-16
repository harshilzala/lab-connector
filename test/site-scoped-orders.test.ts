import assert from 'node:assert';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { HmisClient } from '../src/hmis/client.js';
import { logger } from '../src/logger.js';

// Orders are fetched by BOTH the machine's equipment code and this site's id,
// and only those. HMIS lists each Prahlad Nagar machine's work from several
// sites (16-09-2026: ZHPN003 offered only AHMEDABAD "LB" rows, ZHPN001 offered
// PRAHLADNAGAR "PL" + AHMEDABAD "HE" + ANAND "ZN"). Without the site id the
// connector had tried to program CANCER "ZC" tubes onto the VITROS 250. An
// empty reply for eqCode+siteId means "no work here" — it is never widened.
//   Run:  npx tsx test/site-scoped-orders.test.ts

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));

// ---- 1) every analyzer block names its site --------------------------------
for (const a of cfg.analyzers) {
  const site = a.siteId ?? cfg.hmis.siteId ?? null;
  assert.equal(site, '14631720', `${a.id}: orders keyed on site 14631720`);
  assert.ok(a.equipmentCode.startsWith('ZHPN'), `${a.id}: its own equipment code`);
}
console.log(`✓ config: ${cfg.analyzers.map((a) => `${a.equipmentCode}@${a.siteId ?? cfg.hmis.siteId}`).join(', ')}`);

// ---- 2) the pending call carries both, and an empty reply stays empty -----
{
  const calls: string[] = [];
  const client = new HmisClient({
    baseUrl: 'https://hmis.example.test/portal',
    pendingPath: '/mirth/pending',
    acknowledgePath: '/mirth/acknowledge',
    resultsPath: '/mirth/labresult',
    timeoutMs: 1000,
    tlsRejectUnauthorized: true,
    siteId: '14631720',
    logger,
  } as any);
  // Stub the transport: record the path, answer "nothing pending".
  (client as any).send = async (_m: string, path: string) => {
    calls.push(path);
    return { status: 200, text: JSON.stringify({ data: [], status: 'success' }) };
  };

  const bulk = await client.getPending({ sampleId: '', eqCode: 'ZHPN003', date: '16-09-2026' });
  assert.deepEqual(bulk, { data: [], status: 'success' }, 'empty payload returned as-is');
  const q1 = new URL('http://x' + calls[0]!).searchParams;
  assert.equal(q1.get('eqCode'), 'ZHPN003');
  assert.equal(q1.get('siteId'), '14631720', 'siteId sent with the bulk poll');
  assert.equal(calls.length, 1, 'no second call without the site id');

  await client.getPending({ sampleId: 'PL2609160024', eqCode: 'ZHPN003' });
  const q2 = new URL('http://x' + calls[1]!).searchParams;
  assert.equal(q2.get('sampleId'), 'PL2609160024');
  assert.equal(q2.get('eqCode'), 'ZHPN003');
  assert.equal(q2.get('siteId'), '14631720', 'siteId sent with the per-sample lookup too');
  assert.equal(calls.length, 2, 'still no widening');

  // A block's own siteId overrides the site-wide one.
  calls.length = 0;
  await client.getPending({ sampleId: '', eqCode: 'ZHPN001', siteId: '9246332', date: '16-09-2026' });
  assert.equal(new URL('http://x' + calls[0]!).searchParams.get('siteId'), '9246332');
  console.log('✓ pending calls: eqCode + siteId on bulk and per-sample lookups; empty reply never widened');
}

console.log('site-scoped-orders: all checks passed');
