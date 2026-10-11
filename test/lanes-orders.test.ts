import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';
import { HmisUnavailableError } from '../src/hmis/client.js';
import { groupPendingByBarcode, mergePending, normalizePending } from '../src/hmis/pending.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HostQuery } from '../src/types.js';

// =============================================================================
// HMIS lanes — orders in both mode (spec 2 / 3, scenarios 3 and 11).
//
// Part A, one AnalyzerRuntime against two gateway doubles (deterministic):
//   • rows are tagged with their lane; mergePending keeps a row per lane even
//     when identifier and labResultId coincide
//   • the poll asks HINAI per code x site x day and GenX ONCE per tick
//   • a lane that throws does not stop the other; status shows per-lane state
//   • a host query asks every lane and answers with the union
//
// Part B, a real Connector from a config file with an `im` block in both mode,
// a stand-in HINAI, a stand-in GenX and a stand-in IM:
//   • one tube in both lanes, overlapping and different codes => ONE order,
//     the union; a tube in one lane only is still sent
//   • the next poll sends nothing; a new code in either lane => delta only
//   • GenX worklist fetched once per tick
//   • GenX down: HINAI orders still go; status lanes report the GenX error
//   • the console Re-send asks both lanes and sends the whole union
//
// Run: npx tsx test/lanes-orders.test.ts
// =============================================================================

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' } as any;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await wait(50);
  }
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
const sorted = (l: readonly string[]) => [...l].sort();
type Lane = 'hinai' | 'genx';
type LaneStatus = { lane: Lane; ok: boolean; lastError: string | null; lastPollAt: string | null };
const laneOf = (status: unknown, lane: Lane): LaneStatus | undefined =>
  ((status as { lanes?: LaneStatus[] }).lanes ?? []).find((l) => l.lane === lane);

const dir = mkdtempSync(join(tmpdir(), 'lanes-orders-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];

let failed = false;
const fail = (err: unknown) => {
  failed = true;
  console.error('✗ ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
};

// =============================================================================
// Part A — pure functions and one AnalyzerRuntime
// =============================================================================
console.log('\n— rows tagged by lane');
try {
  // ASSUMPTION: the optional lane tag rides in the options object.
  const body = [
    { SampleID: 'M1', eqIdntifier: 'GLU', equipmentCode: 'EQC', labResultId: 700, labServiceId: 1, parameterId: 1 },
    { SampleID: 'M2', eqIdntifier: 'NA', equipmentCode: 'EQC', labResultId: 701, labServiceId: 1, parameterId: 2 },
  ];
  const one = normalizePending(body, { sampleId: 'M1', eqCode: 'EQC', source: 'genx' } as any);
  assert.ok(one.ackItems.length === 1 && one.ackItems.every((r) => (r as any).source === 'genx'), 'normalizePending sets source');
  const groups = groupPendingByBarcode(body, { eqCode: 'EQC', source: 'hinai' } as any);
  assert.ok([...groups.values()].every((g) => g.ackItems.every((r) => (r as any).source === 'hinai')), 'groupPendingByBarcode sets source');
  const untagged = normalizePending(body, { sampleId: 'M1', eqCode: 'EQC' });
  assert.ok(untagged.ackItems.every((r) => (r as any).source === undefined), 'no source given => none set (single mode unchanged)');

  const part = (source: Lane) => ({
    found: true,
    sampleId: 'M1',
    testCodes: ['GLU'],
    patient: null,
    priority: 'R' as const,
    specimenType: null,
    ackItems: [
      { sampleID: 'M1', equipmentId: 1, identifier: 'GLU', ipAddress: '', isTransmitted: true, labResultId: 700, labServiceId: 1, portNo: '', parameterId: 1, source } as any,
    ],
  });
  assert.equal(mergePending([part('hinai'), part('genx')]).ackItems.length, 2, 'same identifier + labResultId from two lanes: both rows kept');
  assert.equal(mergePending([part('hinai'), part('hinai')]).ackItems.length, 1, 'the same row twice from ONE lane: still one');
  console.log('✓ normalizePending / groupPendingByBarcode tag rows; mergePending dedupes per lane');
} catch (err) {
  fail(err);
}

console.log('\n— one runtime, two gateway doubles');
try {
  const cfgFile = join(dir, 'runtime.json');
  writeFileSync(
    cfgFile,
    JSON.stringify({
      logLevel: 'error',
      spoolDir: join(dir, 'spool-a'),
      hmis: {
        auditLog: null,
        mode: 'both',
        hinai: { baseUrl: 'http://127.0.0.1:1/portal' },
        genx: { baseUrl: 'http://127.0.0.1:2', clientId: 'c', clientSecret: 's', auditLog: join(dir, 'a-genx.log'), accessionCacheFile: join(dir, 'a-acc.json') },
      },
      analyzers: [
        {
          id: 'chem',
          equipmentCode: 'EQC',
          transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() },
          siteIds: ['2', '14'],
          orderPoll: { enabled: true, intervalMs: 60000, lookbackDays: 2, download: false },
        },
      ],
    }),
  );
  const cfg = loadConfig(cfgFile).analyzers[0]!;

  const hrow = (b: string, code: string, labResultId: number) => ({
    SampleID: b, eqIdntifier: code, equipmentCode: 'EQC', labResultId, labServiceId: 10, parameterId: labResultId,
  });
  // What the GenX client hands the connector: mirth-shaped rows.
  const grow = (b: string, code: string, labResultId: number) => ({
    sampleID: b, accessionNumber: 'ACC-' + b, identifier: code, serviceCode: code, labResultId, labServiceId: 20, isTransmitted: false, specimenName: 'Serum',
  });
  const hinaiRows = [hrow('QB1', 'GLU', 500), hrow('QB1', 'CREA', 501)];
  const genxRows = [grow('QB1', 'GLU', 500), grow('QB1', 'UREA', 600), grow('QG1', 'LIP', 601)];
  const hinaiLookupOnly = [hrow('QN1', 'GLU', 700)];
  const genxLookupOnly = [grow('QN1', 'GLU', 700), grow('QN1', 'NA', 701)];
  const calls = { hinaiBulk: 0, genxBulk: 0, hinaiLookups: [] as string[], genxLookups: [] as string[] };
  let genxDown = false;
  const fakeHinai = {
    siteId: null,
    defaultSiteIds: [undefined],
    async getPending(q: { sampleId?: string }) {
      if (q.sampleId) {
        calls.hinaiLookups.push(q.sampleId);
        return { status: 'success', data: [...hinaiRows, ...hinaiLookupOnly].filter((r) => r.SampleID === q.sampleId) };
      }
      calls.hinaiBulk++;
      return { status: 'success', data: hinaiRows };
    },
    async acknowledge() {},
    async postResults(rows: unknown[]) {
      return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
    },
  };
  const fakeGenx = {
    siteId: null,
    defaultSiteIds: [undefined],
    ignoresPollFilters: true,
    async getPending(q: { sampleId?: string }) {
      if (genxDown) throw new HmisUnavailableError('GenX GET /worklist -> HTTP 503: down for maintenance');
      if (q.sampleId) {
        calls.genxLookups.push(q.sampleId);
        return [...genxRows, ...genxLookupOnly].filter((r) => r.sampleID === q.sampleId);
      }
      calls.genxBulk++;
      return genxRows;
    },
    async acknowledge() {},
    async postResults(rows: unknown[]) {
      return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
    },
  };

  const rt = new AnalyzerRuntime(cfg, { hinai: fakeHinai, genx: fakeGenx } as any, join(dir, 'spool-a'), quiet);
  type Row = { identifier: string; labResultId: number | null; source?: Lane };
  const inner = rt as unknown as {
    pollOrders(): Promise<void>;
    answerQuery(q: HostQuery): Promise<void>;
    link: { sendOrders(o: unknown[]): Promise<void> };
    orders: { get(b: string): { rows: Row[]; testCodes: string[] } | null };
  };

  await inner.pollOrders();
  assert.equal(calls.hinaiBulk, 6, 'HINAI: 1 code x 2 sites x 3 days');
  assert.equal(calls.genxBulk, 1, 'GenX: once per tick, whatever the sites and the look-back');
  const qb1 = inner.orders.get('QB1')!;
  assert.ok(qb1, 'the tube both lanes list is stored');
  assert.deepEqual(sorted(qb1.testCodes), ['CREA', 'GLU', 'UREA'], 'testCodes = the de-duplicated union');
  assert.equal(qb1.rows.length, 4, 'one row per lane per code: GLU twice, once per lane');
  assert.deepEqual(sorted(qb1.rows.map((r) => `${r.source}:${r.identifier}`)), ['genx:GLU', 'genx:UREA', 'hinai:CREA', 'hinai:GLU']);
  assert.ok(inner.orders.get('QG1')?.rows.every((r) => r.source === 'genx'), 'a tube only GenX lists is stored, tagged genx');
  {
    const h = laneOf(rt.status(), 'hinai');
    const g = laneOf(rt.status(), 'genx');
    assert.ok(h && g, 'status().lanes lists both lanes');
    assert.deepEqual(sorted(((rt.status() as any).lanes as LaneStatus[]).map((l) => l.lane)), ['genx', 'hinai'], 'named exactly "hinai" / "genx" (A5)');
    assert.ok(h.ok && g.ok && h.lastPollAt && g.lastPollAt && h.lastError === null && g.lastError === null, JSON.stringify((rt.status() as any).lanes));
  }
  console.log('✓ poll: HINAI per code x site x day, GenX once; rows tagged by lane; union of codes');

  // GenX fails, HINAI gains a code: the HINAI half still lands.
  genxDown = true;
  hinaiRows.push(hrow('QB1', 'K', 502));
  await inner.pollOrders();
  assert.deepEqual(sorted(inner.orders.get('QB1')!.testCodes), ['CREA', 'GLU', 'K', 'UREA'], 'the HINAI lane is stored though GenX threw');
  {
    const h = laneOf(rt.status(), 'hinai')!;
    const g = laneOf(rt.status(), 'genx')!;
    assert.equal(h.ok, true);
    assert.equal(g.ok, false);
    assert.match(String(g.lastError), /503/);
  }
  genxDown = false;
  await inner.pollOrders();
  assert.equal(laneOf(rt.status(), 'genx')!.ok, true, 'GenX recovers on the next tick');
  assert.equal(laneOf(rt.status(), 'genx')!.lastError, null);
  console.log('✓ a lane that throws does not stop the other; status lanes carry the error and clear it');

  // Host query: every lane is asked; the answer is the union.
  const sent: unknown[][] = [];
  inner.link.sendOrders = async (o) => {
    sent.push(o);
  };
  calls.hinaiLookups.length = 0;
  calls.genxLookups.length = 0;
  await inner.answerQuery({ sampleId: 'QN1', testCodes: [], specimenIdField: 'QN1' } as HostQuery);
  assert.deepEqual(calls.hinaiLookups, ['QN1'], 'HINAI asked');
  assert.deepEqual(calls.genxLookups, ['QN1'], 'GenX asked');
  assert.equal(sent.length, 1);
  const reply = sent[0]![0] as { testCodes: string[] } | undefined;
  assert.ok(reply, 'answered with an order');
  assert.deepEqual(sorted(reply.testCodes), ['GLU', 'NA']);
  const qn1 = inner.orders.get('QN1')!;
  assert.deepEqual(sorted(qn1.rows.map((r) => `${r.source}:${r.identifier}:${r.labResultId}`)), ['genx:GLU:700', 'genx:NA:701', 'hinai:GLU:700'], 'both GLU 700 rows kept');
  console.log('✓ host query: both lanes asked, union answered, coinciding rows kept per lane');

  // Back-compat: one gateway object (single mode, lane hinai) that ignores
  // poll filters is still asked once per tick.
  const single = { ...fakeGenx, getPending: fakeGenx.getPending };
  const before = calls.genxBulk;
  const cfgSingleFile = join(dir, 'runtime-single.json');
  writeFileSync(
    cfgSingleFile,
    JSON.stringify({
      hmis: { auditLog: null, baseUrl: 'http://127.0.0.1:1/portal' },
      spoolDir: join(dir, 'spool-b'),
      analyzers: [
        {
          id: 'chem2',
          equipmentCode: 'EQC',
          transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() },
          siteIds: ['2', '14'],
          orderPoll: { enabled: true, intervalMs: 60000, lookbackDays: 2, download: false },
        },
      ],
    }),
  );
  const rt2 = new AnalyzerRuntime(loadConfig(cfgSingleFile).analyzers[0]!, single as any, join(dir, 'spool-b'), quiet);
  await (rt2 as unknown as { pollOrders(): Promise<void> }).pollOrders();
  assert.equal(calls.genxBulk - before, 1, 'a single gateway with ignoresPollFilters is asked once per tick');
  console.log('✓ single-gateway constructor still works; a filter-blind gateway is polled once per tick');
} catch (err) {
  fail(err);
}

// =============================================================================
// Part B — a real Connector, im block in both mode
// =============================================================================
console.log('\n— a real Connector, IM in both mode');
const P = 'LB2610110101'; // both lanes: HINAI TSH3 B12, GenX THY (TSH3 FT4)
const Q = 'GX2610110102'; // GenX only: VITB12 (B12)
const R = 'LB2610110103'; // HINAI only: HIVC

const [hinaiPort, genxPort, orderPort, resultPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];

// ---- stand-in HINAI ----------------------------------------------------------
const hrow = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: 'EQ0022', equipmentId: 46150218, labResultId,
  labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric',
  specimenName: 'Serum', FName: 'ASHA', LName: 'PATEL', Gender: 2, DOB: '03-12-1987', mrn: '10032026040311', siteId: 2,
});
const hinaiRows = [hrow(P, 'TSH3', 93000001), hrow(P, 'B12', 93000002), hrow(R, 'HIVC', 93000003)];
const hinaiSeen = { bulk: 0, lookups: [] as string[], bodies: [] as string[] };
const hinai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (body) hinaiSeen.bodies.push(body);
    if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
      const sample = (url.searchParams.get('sampleId') ?? '').toUpperCase();
      if (sample) hinaiSeen.lookups.push(sample);
      else hinaiSeen.bulk++;
      const eq = url.searchParams.get('eqCode');
      const rows = hinaiRows.filter((r) => (!sample || r.SampleID === sample) && (!eq || r.equipmentCode === eq));
      return res.end(JSON.stringify({ status: 'success', data: rows }));
    }
    if (req.method === 'POST' && (url.pathname === '/portal/mirth/labresult' || url.pathname === '/portal/mirth/acknowledge')) {
      const rows = JSON.parse(body) as unknown[];
      return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: rows }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));

// ---- stand-in GenX -----------------------------------------------------------
const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const gtube = (barcode: string, tests: Array<[number, string]>) => ({
  accessionNumber: 'ACC' + barcode.slice(-6),
  sampleNumber: barcode,
  sampleId: barcode.slice(-4),
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid: 'UH10032026', name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const genxTubes = [gtube(P, [[190001, 'THY']]), gtube(Q, [[190002, 'VITB12']])];
const genxSeen = { batch: 0, batchAt: [] as number[], lookups: [] as string[], bodies: [] as string[] };
let genxWorklistDown = false;
const genx = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth-service/api/oauth/token') {
      return res.end(JSON.stringify({ access_token: 'tok1', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (body) genxSeen.bodies.push(body);
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      if (genxWorklistDown) {
        res.statusCode = 503;
        return res.end('{"error":"maintenance"}');
      }
      const barcode = url.searchParams.get('barcode');
      if (barcode === null) {
        genxSeen.batch++;
        genxSeen.batchAt.push(Date.now());
      } else genxSeen.lookups.push(barcode.toUpperCase());
      const content = barcode === null ? genxTubes : genxTubes.filter((t) => t.sampleNumber === barcode.toUpperCase());
      return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') {
      return res.end(envelope({ acknowledgements: [] }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
      const n = (JSON.parse(body) as { results: unknown[] }).results.length;
      return res.end(envelope({ filed: n, unmatched: [] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => genx.listen(genxPort, '127.0.0.1', () => r()));

// ---- stand-in IM: the order listener ------------------------------------------
const orders: Array<{ barcode: string; codes: string[] }> = [];
const im = net.createServer((sock) => {
  const dec = new MllpDecoder('utf8');
  sock.on('data', (chunk) => {
    for (const text of dec.push(chunk)) {
      const msg = parseHl7(text);
      const obr = msg.segments.filter((s) => s.name === 'OBR');
      orders.push({ barcode: obr[0]?.fields[2] ?? '', codes: sorted(obr.map((s) => s.fields[4] ?? '')) });
      sock.write(wrapMllp(`MSH|^~\\&|IM||HMIS-LIS||20261011120000||ACK|A${msg.controlId}|P|2.3.1\rMSA|AA|${msg.controlId}\r`, 'utf8'));
    }
  });
  sock.on('error', () => {});
});
await new Promise<void>((r) => im.listen(orderPort, '127.0.0.1', () => r()));

// ---- the connector -----------------------------------------------------------
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';
const cfgFile = join(dir, 'config.json');
writeFileSync(
  cfgFile,
  JSON.stringify({
    logLevel: 'error',
    spoolDir: join(dir, 'spool'),
    hmis: {
      mode: 'single',
      use: 'hinai',
      auditLog: join(dir, 'logs', 'hmis.log'),
      hinai: { baseUrl: `http://127.0.0.1:${hinaiPort}/portal`, siteIds: ['2'], resultsPath: '/mirth/labresult' },
      genx: {
        baseUrl: `http://127.0.0.1:${genxPort}`,
        clientId: 'cid',
        clientSecret: 'secret',
        auditLog: join(dir, 'logs', 'hmis-genx.log'),
        accessionCacheFile: join(dir, 'genx-acc.json'),
        serviceTests: { THY: ['TSH3', 'FT4'], VITB12: ['B12'], HBA: ['A1C1'] },
        equipmentServices: { EQ0022: ['THY', 'VITB12', 'HBA'] },
      },
    },
    retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(dir, 'logs'), includeSpoolPending: true },
    admin: { host: '127.0.0.1', port: adminPort, authFile: join(dir, 'admin-auth.json') },
    autoCertify: { enabled: false, logFile: null },
    analyzers: [],
    im: {
      enabled: true,
      equipmentCode: 'EQ0022',
      equipmentId: 46150218,
      siteIds: ['2', '14'],
      hmis: { mode: 'both' },
      orders: { host: '127.0.0.1', port: orderPort },
      results: { host: '127.0.0.1', port: resultPort },
      autoCertify: { hinai: false, genx: false },
      analyzer: {
        orderPoll: { intervalMs: 5000, lookbackDays: 1 },
        filing: { passIntervalMs: 5000 },
        hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } },
      },
    },
  }),
);

let connector: Connector | null = null;
try {
  connector = new Connector(loadConfig(cfgFile), quiet);
  await connector.start();
  const status = () => connector!.statuses().find((s) => s.id === 'im')!;
  // HINAI bulk calls per tick: 1 code x 2 sites x 2 days.
  const PER_TICK = 4;

  // ---- one order per tube, the union ---------------------------------------
  await until('three tubes to reach IM', () => orders.length >= 3);
  await wait(1500);
  {
    const byTube = Object.fromEntries(orders.map((o) => [o.barcode, o.codes]));
    assert.equal(orders.length, 3, `exactly one order per tube (got ${JSON.stringify(orders)})`);
    assert.deepEqual(byTube[P], ['B12', 'FT4', 'TSH3'], 'P: ONE order carrying the union of both lanes');
    assert.deepEqual(byTube[Q], ['B12'], 'Q: known to GenX only, still sent');
    assert.deepEqual(byTube[R], ['HIVC'], 'R: known to HINAI only, still sent');
    console.log('✓ both lanes: one order per tube with the union; one-lane tubes still sent');
  }

  // ---- the next poll sends nothing; GenX once per tick ----------------------
  await until('a second poll tick', () => hinaiSeen.bulk >= 2 * PER_TICK && hinaiSeen.bulk % PER_TICK === 0);
  await wait(1500);
  {
    assert.equal(orders.length, 3, 'the same rows on the next poll send nothing');
    const ticks = hinaiSeen.bulk / PER_TICK;
    assert.equal(genxSeen.batch, ticks, `GenX worklist fetched once per tick (${genxSeen.batch} batch calls over ${ticks} ticks)`);
    console.log(`✓ next poll sends nothing; GenX fetched ${genxSeen.batch}x over ${ticks} ticks (HINAI ${hinaiSeen.bulk}x)`);
  }

  // ---- a new code in either lane: delta only --------------------------------
  genxTubes[0]!.tests.push({ sampleLineId: '190003', serviceId: '11', serviceCode: 'HBA', serviceName: 'HBA', lineStatus: 'PENDING' });
  hinaiRows.push(hrow(Q, 'CEA', 93000004));
  await until('two delta orders', () => orders.length >= 5);
  await wait(1500);
  {
    const deltas = orders.slice(3);
    assert.equal(deltas.length, 2, JSON.stringify(deltas));
    const byTube = Object.fromEntries(deltas.map((o) => [o.barcode, o.codes]));
    assert.deepEqual(byTube[P], ['A1C1'], 'a GenX-only addition to a both-lane tube: only it is sent');
    assert.deepEqual(byTube[Q], ['CEA'], 'a HINAI addition to a GenX-known tube: only it is sent');
    console.log('✓ a new code in one lane goes out as a delta');
  }

  // ---- status lanes, then GenX down -----------------------------------------
  {
    const h = laneOf(status(), 'hinai');
    const g = laneOf(status(), 'genx');
    assert.ok(h && g, `status lanes present: ${JSON.stringify((status() as any).lanes)}`);
    // Addendum A5: exactly these two names, nothing else.
    assert.deepEqual(sorted(((status() as any).lanes as LaneStatus[]).map((l) => l.lane)), ['genx', 'hinai']);
    assert.ok(h.ok && g.ok && h.lastPollAt && g.lastPollAt);
    assert.ok(/"both"/.test(JSON.stringify(status())), 'the status names the HMIS mode "both"');
  }
  genxWorklistDown = true;
  hinaiRows.push(hrow(R, 'HBSAG', 93000005));
  await until('the HINAI addition to go out while GenX is down', () => orders.length >= 6);
  await until('the GenX lane to report the failure', () => laneOf(status(), 'genx')?.ok === false);
  {
    assert.deepEqual(orders[5], { barcode: R, codes: ['HBSAG'] });
    const g = laneOf(status(), 'genx')!;
    assert.match(String(g.lastError), /503/);
    assert.equal(laneOf(status(), 'hinai')!.ok, true);
    console.log('✓ GenX down: HINAI orders still go out; status shows the GenX lane failing');
  }
  genxWorklistDown = false;
  await until('the GenX lane to recover', () => laneOf(status(), 'genx')?.ok === true);
  assert.equal(laneOf(status(), 'genx')!.lastError, null);
  console.log('✓ GenX back: the lane is ok again');

  // ---- console Re-send in both mode -----------------------------------------
  {
    const base = `http://127.0.0.1:${adminPort}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ username: 'tester', password: 'Lanes@2026' }).toString(),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert.ok(cookie.startsWith('lc_session='), `signed in (HTTP ${login.status})`);
    const sentBefore = orders.length;
    const hLook = hinaiSeen.lookups.length;
    const gLook = genxSeen.lookups.length;
    const res = await fetch(`${base}/api/analyzers/im/orders/${P}/resend`, { method: 'POST', headers: { cookie, origin: base } });
    const report = (await res.json()) as { tests?: string[]; error?: string };
    assert.equal(res.status, 200, JSON.stringify(report));
    assert.deepEqual(sorted(report.tests ?? []), ['A1C1', 'B12', 'FT4', 'TSH3'], 'the whole union is re-sent');
    await until('the re-sent order to reach IM', () => orders.length > sentBefore);
    assert.deepEqual(orders[sentBefore], { barcode: P, codes: ['A1C1', 'B12', 'FT4', 'TSH3'] });
    assert.ok(hinaiSeen.lookups.slice(hLook).includes(P), 'HINAI was asked for the tube');
    assert.ok(genxSeen.lookups.slice(gLook).includes(P), 'GenX was asked for the tube');
    console.log('✓ console Re-send: both lanes asked, the whole union sent to IM');
  }

  for (const b of [...hinaiSeen.bodies, ...genxSeen.bodies]) {
    assert.ok(!/"source"/.test(b), `no lane tag on the wire: ${b.slice(0, 200)}`);
  }
} catch (err) {
  fail(err);
} finally {
  await connector?.stop().catch(() => {});
  await new Promise<void>((r) => im.close(() => r()));
  await new Promise<void>((r) => hinai.close(() => r()));
  await new Promise<void>((r) => genx.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nlanes-orders: FAILED');
  process.exit(1);
}
console.log('\nlanes-orders: all checks passed');
process.exit(0);
