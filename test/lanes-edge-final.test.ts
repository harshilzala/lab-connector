import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { GenxHmisClient } from '../src/hmis/genx.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisResultUpload } from '../src/types.js';

// =============================================================================
// HMIS lanes — last gaps (C1, D4, D2 via Force).
//
//   1. C1: a migrated GenX row is replaced when GenX itself sends the same
//      row, and the line then certifies
//   2. D4: a live lookup that fails while the tube is already cached in both
//      lanes still files HINAI (this sample and the next) and leaves GenX pending
//   3. D2 via Force: GenX reporting a code unplaced marks only the placed
//      codes filed in GenX
//
// GenX is the real GenxHmisClient against a 127.0.0.1 stand-in; HINAI is in
// memory. Temp dirs only; LAB_CONNECTOR_ENV points at a file that does not exist.
//
// Run: npx tsx test/lanes-edge-final.test.ts
// =============================================================================

const rec: any = { child: () => rec, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await wait(20);
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

const root = mkdtempSync(join(tmpdir(), 'lanes-edge-final-'));
process.env.LAB_CONNECTOR_ENV = join(root, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}\n    ${(err instanceof Error ? err.message : String(err)).split('\n').join('\n    ')}`);
  }
}

// ---- GenX stand-in ---------------------------------------------------------------
const SERVICE_TESTS: Record<string, string[]> = { THY: ['TSH3', 'FT4'], TSHONLY: ['TSH3'] };
type Tube = ReturnType<typeof gtube>;
const gtube = (barcode: string, tests: Array<[number, string]>) => ({
  accessionNumber: 'ACC' + barcode,
  sampleNumber: barcode,
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid: 'UH1', name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const gx = {
  tubes: [] as Tube[],
  down: false,
  unmatchedOnce: new Map<string, string[]>(),
  posts: [] as Array<{ barcode: string; codes: string[] }>,
  certifyIds: [] as string[],
};
const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const genxServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth-service/api/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (gx.down) {
      res.statusCode = 503;
      return res.end('{"error":"down"}');
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      const b = url.searchParams.get('barcode');
      const content = b === null ? gx.tubes : gx.tubes.filter((t) => t.sampleNumber === b.toUpperCase());
      return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
      const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string }> };
      gx.posts.push({ barcode: sent.accessionNumber.replace(/^ACC/, ''), codes: sent.results.map((r) => r.machineTestCode) });
      const unmatched = gx.unmatchedOnce.get(sent.accessionNumber) ?? [];
      gx.unmatchedOnce.delete(sent.accessionNumber);
      return res.end(envelope({ filed: sent.results.filter((r) => !unmatched.includes(r.machineTestCode)).length, unmatched }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') return res.end(envelope({ acknowledgements: [] }));
    if (url.pathname === '/integration-service/external/v1/lab/equipment/autocertify') {
      gx.certifyIds.push(url.searchParams.get('labresultid') ?? '');
      return res.end(envelope({ certified: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
const genxPort = await freePort();
await new Promise<void>((r) => genxServer.listen(genxPort, '127.0.0.1', () => r()));
const genxPostsFor = (b: string) => gx.posts.filter((p) => p.barcode === b);

// ---- HINAI in memory -------------------------------------------------------------
type Posted = { sampleId: string; identifier: string; resultValue: string; labResultId: number | null };
class FakeHinai {
  rows: Array<Record<string, unknown>> = [];
  posted: Posted[] = [];
  add(barcode: string, code: string, id: number) {
    this.rows.push({ SampleID: barcode, eqIdntifier: code, equipmentCode: 'EQC', labResultId: id, labServiceId: 10, parameterId: id });
  }
  postedFor(b: string) {
    return this.posted.filter((r) => r.sampleId === b);
  }
  gateway() {
    const self = this;
    return {
      siteId: null,
      defaultSiteIds: [undefined],
      async getPending(q: { sampleId?: string }) {
        return { status: 'success', data: q.sampleId ? self.rows.filter((r) => r.SampleID === q.sampleId) : self.rows };
      },
      async acknowledge() {},
      async postResults(rows: Posted[]) {
        self.posted.push(...rows);
        return { status: 'success', message: 'ok', successData: rows.map((r) => ({ sampleId: r.sampleId, labResultId: r.labResultId })), filed: rows.length };
      },
    };
  }
}

type Value = { value: string; filedAt: string | null; lanes?: Record<string, { filedAt: string | null; labResultId: number | null }> };
type Sample = { lastError: string | null; values: Record<string, Value>; certified?: { genx: number[] } };
type Inner = {
  filer: { run(reason: string, only?: string): Promise<unknown>; running: boolean };
  staged: { upsert(u: HmisResultUpload): unknown; get(b: string): Sample | null };
  pollOrders(): Promise<void>;
};
function build(name: string, mode: 'both' | 'genx', extra: Record<string, unknown> = {}, port = 1) {
  const spool = join(root, name);
  mkdirSync(spool, { recursive: true });
  const file = join(root, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      logLevel: 'error',
      spoolDir: join(root, name, 'unused'),
      retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(root, name, 'logs'), includeSpoolPending: true },
      admin: { host: '127.0.0.1', port: 1, authFile: join(root, name, 'auth.json') },
      autoCertify: { enabled: false, logFile: null },
      Force_Hmis: { password: 'x' },
      hmis: {
        auditLog: null,
        ...(mode === 'both' ? { mode: 'both' } : { mode: 'single', use: 'genx' }),
        hinai: { baseUrl: 'http://127.0.0.1:1/portal' },
        genx: { baseUrl: `http://127.0.0.1:${genxPort}`, clientId: 'c', clientSecret: 's', auditLog: join(root, name, 'g.log'), accessionCacheFile: join(spool, 'acc.json'), serviceTests: SERVICE_TESTS },
      },
      analyzers: [{ id: 'chem', equipmentCode: 'EQC', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port }, filing: { mode: 'staged' }, ...extra }],
    }),
  );
  const cfg = loadConfig(file).analyzers[0]!;
  const H = new FakeHinai();
  const genx = new GenxHmisClient({
    baseUrl: `http://127.0.0.1:${genxPort}`,
    tokenPath: '/auth-service/api/oauth/token',
    worklistPath: '/integration-service/external/v1/lab/equipment/worklist',
    acknowledgePath: '/integration-service/external/v1/lab/equipment/acknowledge',
    resultsPath: '/integration-service/external/v1/lab/equipment/results',
    clientId: 'c',
    clientSecret: 's',
    scope: '',
    clientAuth: 'basic',
    apiKeyHeader: 'X-API-Key',
    barcodeField: 'sampleNumber',
    serviceTests: SERVICE_TESTS,
    equipmentServices: {},
    pendingLineStatuses: ['PENDING'],
    batchDays: 1,
    batchPageSize: 200,
    accessionCacheFile: join(spool, 'acc.json'),
    timeoutMs: 3000,
    tlsRejectUnauthorized: true,
    logger: rec,
  });
  const gateways = mode === 'both' ? { hinai: H.gateway(), genx } : { genx };
  const rt = new AnalyzerRuntime(cfg, gateways as any, spool, rec);
  return { rt, inner: rt as unknown as Inner, H, spool };
}
let n = 0;
const stage = (inner: Inner, barcode: string, values: Record<string, string>) =>
  inner.staged.upsert({
    equipmentId: 1,
    eqCode: 'EQC',
    barcode,
    isQc: false,
    results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
    messageId: `${barcode}-${++n}`,
  });
const pass = (inner: Inner) => inner.filer.run('timer');

// =============================================================================
await check('C1: a migrated GenX row is replaced when GenX sends the same row, and the line then certifies', async () => {
  const B = 'FN1';
  // What the old code (api "genx") cached: one untagged row for GenX line 1201.
  const orders = join(root, 'c1', 'chem', 'orders'); // written BEFORE the runtime exists
  mkdirSync(orders, { recursive: true });
  const T0 = '2026-10-10T08:00:00.000Z';
  writeFileSync(
    join(orders, `${B}.json`),
    JSON.stringify({
      barcode: B, sampleId: B,
      rows: [{ sampleID: B, equipmentId: 1, identifier: 'TSH3', ipAddress: '', isTransmitted: true, labResultId: 1201, labServiceId: 10, portNo: '', parameterId: null, resultType: null }],
      testCodes: ['TSH3'], patient: null, specimenType: null, priority: 'R', downloaded: ['TSH3'], firstSeenAt: T0, updatedAt: T0, source: 'poll',
    }),
  );
  // ...and the barcode -> accession memory the old GenX client kept beside it.
  writeFileSync(join(root, 'c1', 'acc.json'), JSON.stringify({ [B]: 'ACC' + B }));
  const { rt, inner } = build('c1', 'genx', { genxAutoCertify: true, filing: { mode: 'staged', passIntervalMs: 5000 } }, await freePort());
  await rt.start();
  try {
    const rows0 = (JSON.parse(readFileSync(join(orders, `${B}.json`), 'utf8')) as { rows: Array<{ migrated?: boolean; source?: string }> }).rows;
    assert.ok(rows0.length === 1 && rows0[0]!.migrated === true && rows0[0]!.source === 'genx', `migrated at start (${JSON.stringify(rows0)})`);
    stage(inner, B, { TSH3: '2.0' });
    await until('idle', () => !inner.filer.running);
    await pass(inner);
    assert.equal(genxPostsFor(B).length, 1, 'filed in GenX from the migrated row');
    assert.ok(!gx.certifyIds.includes('1201'), 'a line backed only by a migrated row is not certified');
    // GenX itself now sends the same row.
    gx.tubes.push(gtube(B, [[1201, 'TSHONLY']]));
    await inner.pollOrders();
    await until('idle', () => !inner.filer.running);
    const rows1 = (JSON.parse(readFileSync(join(orders, `${B}.json`), 'utf8')) as { rows: Array<{ identifier: string; migrated?: boolean; source?: string }> }).rows;
    const tsh = rows1.filter((r) => r.identifier === 'TSH3');
    assert.ok(tsh.length === 1 && !tsh[0]!.migrated && tsh[0]!.source === 'genx', `the GenX-sent row replaced the migrated one (${JSON.stringify(rows1)})`);
    // Certify is owed on a fully filed sample: revisited at most every passIntervalMs.
    const end = Date.now() + 7000;
    while (!gx.certifyIds.includes('1201') && Date.now() < end) {
      await until('idle', () => !inner.filer.running);
      await pass(inner);
      await wait(250);
    }
    assert.deepEqual(gx.certifyIds.filter((x) => x === '1201'), ['1201'], 'the line certifies once GenX itself has sent the row');
    assert.equal(genxPostsFor(B).length, 1, 'nothing re-posted');
  } finally {
    await rt.stop();
  }
});

await check('D4: a failing live GenX lookup with the tube cached in both lanes still files HINAI, GenX pending', async () => {
  const A = 'FN2A'; // FT4 has a HINAI row but no cached GenX row => GenX live refresh
  const B = 'FN2B';
  gx.tubes.push(gtube(A, [[1301, 'TSHONLY']]), gtube(B, [[1302, 'TSHONLY']]));
  const { inner, H } = build('d4', 'both');
  H.add(A, 'TSH3', 13001);
  H.add(A, 'FT4', 13002);
  H.add(B, 'TSH3', 13003);
  await inner.pollOrders(); // both lanes cached
  gx.down = true;
  try {
    stage(inner, A, { TSH3: '1.0', FT4: '1.1' });
    stage(inner, B, { TSH3: '2.0' });
    await pass(inner);
    assert.deepEqual(sorted(H.postedFor(A).map((r) => r.identifier)), ['FT4', 'TSH3'], 'HINAI filed A');
    assert.deepEqual(H.postedFor(B).map((r) => r.identifier), ['TSH3'], 'and B after it');
    for (const b of [A, B]) {
      const v = inner.staged.get(b)!.values.TSH3!;
      assert.ok(v.lanes?.hinai?.filedAt && !v.lanes?.genx?.filedAt, `${b}: filed in HINAI, pending in GenX`);
    }
  } finally {
    gx.down = false;
  }
  await pass(inner);
  assert.equal(genxPostsFor(A).length + genxPostsFor(B).length >= 2, true, 'GenX catches up once it answers');
  assert.equal(H.posted.length, 3, 'HINAI not re-posted');
});

await check('D2 via Force: GenX leaves FT4 unplaced — only TSH3 is marked filed in GenX', async () => {
  const B = 'FN3';
  gx.tubes.push(gtube(B, [[1401, 'THY']]));
  const { rt, inner, H } = build('d2f', 'both');
  H.add(B, 'TSH3', 14001);
  H.add(B, 'FT4', 14002);
  await inner.pollOrders(); // both lanes cached; Force reads the cache only
  stage(inner, B, { TSH3: '3.0', FT4: '1.2' });
  gx.unmatchedOnce.set('ACC' + B, ['FT4']);
  const report = await rt.stagedForce(B);
  assert.ok(report, 'Force answered');
  assert.deepEqual(sorted(genxPostsFor(B).at(-1)?.codes ?? []), ['FT4', 'TSH3'], 'both sent to GenX');
  const s = inner.staged.get(B)!;
  assert.ok(s.values.TSH3!.lanes?.genx?.filedAt, 'TSH3 (placed) filed in GenX');
  assert.ok(!s.values.FT4!.lanes?.genx?.filedAt, `FT4 (unplaced) not marked filed in GenX (${JSON.stringify(s.values.FT4!.lanes)})`);
  assert.ok(s.values.FT4!.lanes?.hinai?.filedAt, 'FT4 filed in HINAI');
});

await new Promise<void>((r) => genxServer.close(() => r()));
rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`\nlanes-edge-final: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nlanes-edge-final: all checks passed');
process.exit(0);
