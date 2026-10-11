import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';
import { HmisUnavailableError } from '../src/hmis/client.js';
import { GenxHmisClient } from '../src/hmis/genx.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisResultUpload } from '../src/types.js';

// =============================================================================
// HMIS lanes — review findings (addendum D1-D9), both mode.
//
// GenX is the REAL GenxHmisClient against a 127.0.0.1 stand-in (so service
// expansion, unmatched handling and certify are the client's own); HINAI is
// an in-memory gateway whose post can be held open on a promise the test
// controls (D6). Each check gets its own temp spool and runtime; the filing
// pass is driven directly.
//
//   D1 certify readiness from the FULL line code list
//   D2 GenX partial success (filed > 0 with unmatched)
//   D3 File now never skips withheld / ambiguous values
//   D4 a GenX outage never stops HINAI filing for later samples
//   D5 a rerun into a certified GenX line waits for staff
//   D6 rerun / Force / File now while a pass is in flight
//   D7 a never-certifiable sample is not revisited for certify
//   D8 the patient check runs again after a mid-pass refresh
//   D9 hmis.patientCheck false
//
// Live-system rule: 127.0.0.1 only, temp dirs only, LAB_CONNECTOR_ENV points
// at a file that does not exist.
//
// Run: npx tsx test/lanes-edge-review.test.ts
// =============================================================================

const warns: string[] = [];
const rec: any = {
  child: () => rec,
  info() {},
  warn(...a: unknown[]) {
    warns.push(JSON.stringify(a));
  },
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  level: 'silent',
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await wait(10);
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

const root = mkdtempSync(join(tmpdir(), 'lanes-edge-review-'));
process.env.LAB_CONNECTOR_ENV = join(root, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';

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

// ---- GenX stand-in (127.0.0.1) --------------------------------------------------
const SERVICE_TESTS: Record<string, string[]> = {
  THY: ['TSH3', 'FT4'],
  TFT: ['FT4', 'T3'], // shares FT4 with THY
  MIX: ['B12', 'XYZ'], // XYZ is not interfaced (allowTestCodes)
  TSHONLY: ['TSH3'],
  FT4ONLY: ['FT4'],
  VITB12: ['B12'],
  PCTS: ['PCT'],
  WBCS: ['WBC'],
};
type Tube = ReturnType<typeof gtube>;
const gtube = (barcode: string, tests: Array<[number, string]>, uhid = 'UH1') => ({
  accessionNumber: 'ACC' + barcode,
  sampleNumber: barcode,
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid, name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const gx = {
  tubes: [] as Tube[],
  down: false,
  /** accession -> codes to answer as unmatched, once */
  unmatchedOnce: new Map<string, string[]>(),
  posts: [] as Array<{ barcode: string; codes: string[]; values: Record<string, string> }>,
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
      const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string; value: string }> };
      const barcode = sent.accessionNumber.replace(/^ACC/, '');
      gx.posts.push({ barcode, codes: sent.results.map((r) => r.machineTestCode), values: Object.fromEntries(sent.results.map((r) => [r.machineTestCode, r.value])) });
      const unmatched = gx.unmatchedOnce.get(sent.accessionNumber) ?? [];
      gx.unmatchedOnce.delete(sent.accessionNumber);
      const filed = sent.results.filter((r) => !unmatched.includes(r.machineTestCode)).length;
      return res.end(envelope({ filed, unmatched, outOfRange: [], panics: [] }));
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
const certifiedCount = (line: number) => gx.certifyIds.filter((id) => id === String(line)).length;

// ---- HINAI in memory, with a post that can be held open ---------------------------
type Posted = { sampleId: string; identifier: string; resultValue: string; labResultId: number | null };
class FakeHinai {
  rows: Array<Record<string, unknown>> = [];
  posted: Posted[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failPost = false;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  add(barcode: string, code: string, id: number, parameterId: number = id, extra: Record<string, unknown> = {}) {
    this.rows.push({ SampleID: barcode, eqIdntifier: code, equipmentCode: 'EQC', labResultId: id, labServiceId: 10, parameterId, ...extra });
  }
  hold() {
    this.gate = new Promise<void>((r) => (this.openGate = r));
  }
  release() {
    const open = this.openGate;
    this.gate = null;
    this.openGate = null;
    open?.();
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
        const rows = q.sampleId ? self.rows.filter((r) => r.SampleID === q.sampleId) : self.rows;
        return { status: 'success', data: rows };
      },
      async acknowledge() {},
      async postResults(rows: Posted[]) {
        self.inFlight++;
        self.maxInFlight = Math.max(self.maxInFlight, self.inFlight);
        try {
          if (self.gate) await self.gate;
          if (self.failPost) throw new HmisUnavailableError('HINAI 503');
          self.posted.push(...rows);
          return { status: 'success', message: 'ok', successData: rows.map((r) => ({ sampleId: r.sampleId, labResultId: r.labResultId })), filed: rows.length };
        } finally {
          self.inFlight--;
        }
      },
    };
  }
}

// ---- a runtime per check -------------------------------------------------------------
const GENX_PATHS = {
  tokenPath: '/auth-service/api/oauth/token',
  worklistPath: '/integration-service/external/v1/lab/equipment/worklist',
  acknowledgePath: '/integration-service/external/v1/lab/equipment/acknowledge',
  resultsPath: '/integration-service/external/v1/lab/equipment/results',
};
const ALLOW = ['TSH3', 'FT4', 'T3', 'B12', 'PCT', 'WBC'];
type Value = { value: string; filedAt: string | null; lanes?: Record<string, { filedAt: string | null; labResultId: number | null; skipped?: string }> };
type Sample = { barcode: string; lastError: string | null; values: Record<string, Value>; certified?: { genx: number[] } };
type Inner = {
  filer: { run(reason: string, only?: string): Promise<unknown>; running: boolean };
  staged: { upsert(u: HmisResultUpload): unknown; get(b: string): Sample | null; waiting(opts?: { certifyGenx?: boolean }): Sample[] };
  pollOrders(): Promise<void>;
};
let n = 0;
function build(name: string, extra: Record<string, unknown> = {}) {
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
      hmis: {
        auditLog: null,
        mode: 'both',
        hinai: { baseUrl: 'http://127.0.0.1:1/portal' },
        genx: { baseUrl: `http://127.0.0.1:${genxPort}`, clientId: 'c', clientSecret: 's', auditLog: join(root, name, 'g.log'), accessionCacheFile: join(spool, 'acc.json'), serviceTests: SERVICE_TESTS },
      },
      analyzers: [
        { id: 'chem', equipmentCode: 'EQC', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: 1 }, filing: { mode: 'staged' }, allowTestCodes: ALLOW, ...extra },
      ],
    }),
  );
  const cfg = loadConfig(file).analyzers[0]!;
  const H = new FakeHinai();
  const genx = new GenxHmisClient({
    baseUrl: `http://127.0.0.1:${genxPort}`,
    ...GENX_PATHS,
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
  const rt = new AnalyzerRuntime(cfg, { hinai: H.gateway(), genx } as any, spool, rec);
  return { rt, inner: rt as unknown as Inner, H };
}
const upload = (barcode: string, values: Record<string, string>): HmisResultUpload => ({
  equipmentId: 1,
  eqCode: 'EQC',
  barcode,
  isQc: false,
  results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
  messageId: `${barcode}-${++n}`,
});
const stage = (inner: Inner, b: string, values: Record<string, string>) => inner.staged.upsert(upload(b, values));
const pass = (inner: Inner) => inner.filer.run('timer');
const complete = (s: Sample | null) => !!s && Object.values(s.values).every((v) => v.filedAt);

// =============================================================================
console.log('\n— D1 / D7: certify readiness from the full line code list');

await check('D1 a line sharing a code with another line, and a line with a non-interfaced code, are never certified', async () => {
  const B = 'D1A';
  gx.tubes.push(gtube(B, [[401, 'THY'], [402, 'TFT'], [403, 'MIX']]));
  const { inner, H } = build('d1', { genxAutoCertify: true });
  for (const [c, id] of [['TSH3', 1], ['FT4', 2], ['T3', 3], ['B12', 4]] as const) H.add(B, c, 41000 + id);
  stage(inner, B, { TSH3: '1.0', FT4: '1.1', T3: '1.2', B12: '300' });
  await pass(inner);
  await pass(inner);
  assert.deepEqual(sorted(genxPostsFor(B).flatMap((p) => p.codes)), ['B12', 'FT4', 'T3', 'TSH3'], 'every value filed in GenX');
  assert.equal(certifiedCount(401), 1, 'line 401 (TSH3 + FT4, both filed against it) is certified');
  assert.equal(certifiedCount(402), 0, 'line 402 shares FT4 with 401 — never certified');
  assert.equal(certifiedCount(403), 0, 'line 403 carries XYZ, which this interface does not — never certified');

  // D7: such a sample is not on the certify-revisit list.
  const revisit = inner.staged.waiting({ certifyGenx: true }).map((s) => s.barcode);
  assert.ok(!revisit.includes(B), `D7: a sample whose remaining lines can never certify is not revisited (${JSON.stringify(revisit)})`);
});

// =============================================================================
console.log('\n— D2: GenX partial success');

await check('D2 filed > 0 with unmatched: only matched codes marked, line not certified, unmatched retried', async () => {
  const B = 'D2A';
  gx.tubes.push(gtube(B, [[501, 'THY']]));
  const { inner, H } = build('d2', { genxAutoCertify: true });
  H.add(B, 'TSH3', 51001);
  H.add(B, 'FT4', 51002);
  gx.unmatchedOnce.set('ACC' + B, ['FT4']);
  stage(inner, B, { TSH3: '2.0', FT4: '1.0' });
  await pass(inner);
  const s = inner.staged.get(B)!;
  assert.ok(s.values.TSH3!.lanes?.genx?.filedAt, 'TSH3 filed in GenX');
  assert.ok(!s.values.FT4!.lanes?.genx?.filedAt, `FT4 (unmatched) stays pending in GenX (${JSON.stringify(s.values.FT4!.lanes)})`);
  assert.equal(certifiedCount(501), 0, 'a line with an unmatched code is not certified');
  assert.equal(H.postedFor(B).length, 2, 'HINAI filed both, as before');
  await pass(inner);
  const last = genxPostsFor(B).at(-1)!;
  assert.deepEqual(last.codes, ['FT4'], 'the unmatched code is retried, alone');
  assert.ok(complete(inner.staged.get(B)));
  assert.equal(certifiedCount(501), 1, 'certified once the whole line is filed');
  assert.equal(H.postedFor(B).length, 2, 'HINAI not re-posted');
});

// =============================================================================
console.log('\n— D3: File now and withheld / ambiguous values');

await check('D3 File now never skips a withheld or ambiguous value; it stays waiting', async () => {
  const B = 'D3A';
  gx.tubes.push(gtube(B, [[701, 'TSHONLY'], [702, 'PCTS'], [703, 'WBCS']]));
  const { rt, inner, H } = build('d3', { excludeParameterIds: [2162] });
  H.add(B, 'TSH3', 71001, 31);
  H.add(B, 'PCT', 71002, 2162); // excluded => withheld
  H.add(B, 'WBC', 71003, 2123); // two parameters under one name => ambiguous
  H.add(B, 'WBC', 71003, 2166);
  stage(inner, B, { TSH3: '1.0', PCT: '0.2', WBC: '7.1' });
  await pass(inner);
  assert.deepEqual(H.postedFor(B).map((r) => r.identifier), ['TSH3'], 'HINAI: only TSH3 is filable');
  await rt.stagedFileNow(B);
  const s = inner.staged.get(B)!;
  for (const code of ['PCT', 'WBC']) {
    assert.ok(!s.values[code]!.lanes?.hinai?.skipped, `${code} not skipped in HINAI (${JSON.stringify(s.values[code]!.lanes)})`);
    assert.equal(s.values[code]!.filedAt, null, `${code} still waiting`);
  }
  assert.ok(s.values.TSH3!.filedAt, 'TSH3 done');
  assert.equal(H.postedFor(B).length, 1, 'nothing else posted to HINAI');
});

// =============================================================================
console.log('\n— D4: a GenX outage and HINAI');

await check('D4 GenX failing for 7 samples in one pass: HINAI still files every one; GenX catches up later', async () => {
  const { inner, H } = build('d4');
  const tubes = [1, 2, 3, 4, 5, 6, 7].map((i) => `D4S${i}`);
  for (const [i, b] of tubes.entries()) {
    gx.tubes.push(gtube(b, [[800 + i, 'TSHONLY']]));
    H.add(b, 'TSH3', 81000 + i);
  }
  await inner.pollOrders(); // both lanes cached
  gx.down = true;
  try {
    for (const b of tubes) stage(inner, b, { TSH3: '3.0' });
    await pass(inner);
    assert.deepEqual(
      tubes.filter((b) => H.postedFor(b).length !== 1),
      [],
      'every sample filed in HINAI in the same pass, though GenX failed throughout',
    );
    assert.ok(tubes.every((b) => !inner.staged.get(b)!.values.TSH3!.lanes?.genx?.filedAt), 'GenX pending for all');
  } finally {
    gx.down = false;
  }
  await pass(inner);
  assert.deepEqual(tubes.filter((b) => genxPostsFor(b).length !== 1), [], 'GenX files every one on the next pass');
  assert.ok(tubes.every((b) => H.postedFor(b).length === 1), 'HINAI not re-posted');
});

// =============================================================================
console.log('\n— D5: a rerun into a certified GenX line');

await check('D5 rerun after certify: HINAI refiled, GenX held for staff; File now posts to GenX without a second certify', async () => {
  const B = 'D5A';
  gx.tubes.push(gtube(B, [[601, 'TSHONLY']]));
  const { rt, inner, H } = build('d5', { genxAutoCertify: true });
  H.add(B, 'TSH3', 61001);
  stage(inner, B, { TSH3: '2.0' });
  await pass(inner);
  assert.equal(certifiedCount(601), 1);
  stage(inner, B, { TSH3: '2.5' });
  const w0 = warns.length;
  await pass(inner);
  await pass(inner);
  assert.deepEqual(H.postedFor(B).map((r) => r.resultValue), ['2.0', '2.5'], 'HINAI files the correction as usual');
  assert.deepEqual(genxPostsFor(B).map((p) => p.values.TSH3), ['2.0'], 'the correction is NOT posted to GenX automatically');
  const s = inner.staged.get(B)!;
  assert.match(s.lastError ?? '', /GenX result line 601 is already certified — the corrected value needs staff; 'File now' sends it/);
  assert.ok(!s.values.TSH3!.lanes?.genx?.filedAt, 'pending in the GenX lane');
  assert.ok(warns.slice(w0).some((w) => w.includes('601')), 'a warning names the line');
  await rt.stagedFileNow(B);
  assert.deepEqual(genxPostsFor(B).map((p) => p.values.TSH3), ['2.0', '2.5'], 'File now sends the correction to GenX');
  assert.equal(certifiedCount(601), 1, 'and does not certify the line again');
  assert.ok(complete(inner.staged.get(B)));
});

// =============================================================================
console.log('\n— D6: concurrency');

await check('D6 a rerun arriving while the HINAI post is in flight stays pending and goes next pass', async () => {
  const B = 'D6A';
  gx.tubes.push(gtube(B, [[901, 'TSHONLY']]));
  const { inner, H } = build('d6a');
  H.add(B, 'TSH3', 91001);
  stage(inner, B, { TSH3: '1.0' });
  H.hold();
  const running = pass(inner);
  await until('the HINAI post to be in flight', () => H.inFlight === 1);
  stage(inner, B, { TSH3: '1.5' }); // the rerun lands mid-post
  H.release();
  await running;
  await pass(inner);
  assert.deepEqual(H.postedFor(B).map((r) => r.resultValue), ['1.0', '1.5'], 'HINAI was sent the rerun on the next pass');
  assert.equal(genxPostsFor(B).at(-1)?.values.TSH3, '1.5', 'GenX ends with the rerun value');
  const v = inner.staged.get(B)!.values.TSH3!;
  assert.equal(v.value, '1.5');
  assert.ok(v.filedAt && v.lanes?.hinai?.filedAt && v.lanes?.genx?.filedAt, 'the rerun value is filed in both lanes');
});

await check('D6 Force during a pass waits for it: never two posts in flight', async () => {
  const B = 'D6F';
  gx.tubes.push(gtube(B, [[902, 'TSHONLY']]));
  const { rt, inner, H } = build('d6f');
  H.add(B, 'TSH3', 92001);
  stage(inner, B, { TSH3: '4.0' });
  H.hold();
  const running = pass(inner);
  await until('the HINAI post to be in flight', () => H.inFlight === 1);
  const forced = rt.stagedForce(B);
  await wait(200);
  assert.equal(H.maxInFlight, 1, 'Force did not post while the pass was posting');
  H.release();
  await running;
  await forced;
  assert.equal(H.maxInFlight, 1);
  assert.equal(H.postedFor(B).length, 2, 'the pass once, then the Force once — no third post');
});

await check('D6 File now during a running pass still runs as the operator', async () => {
  const B = 'D6N'; // only in HINAI: held unless the operator pushes it
  const X = 'D6X'; // keeps the pass busy
  gx.tubes.push(gtube(X, [[903, 'TSHONLY']]));
  const { rt, inner, H } = build('d6n');
  H.add(B, 'TSH3', 93001);
  H.add(X, 'TSH3', 93002);
  stage(inner, B, { TSH3: '5.0' });
  await pass(inner);
  assert.match(inner.staged.get(B)!.lastError ?? '', /only in HINAI/);
  stage(inner, X, { TSH3: '6.0' });
  H.hold();
  const running = pass(inner);
  await until('the pass to be posting', () => H.inFlight === 1);
  const fileNow = rt.stagedFileNow(B);
  await wait(100);
  H.release();
  await running;
  const ok = await fileNow;
  const s = inner.staged.get(B)!;
  assert.equal(s.values.TSH3!.lanes?.genx?.skipped, 'operator', `by the time File now answers, it has run as operator (${JSON.stringify(s.values.TSH3!.lanes)})`);
  assert.equal(ok, true);
  assert.equal(H.postedFor(B).length, 1);
  assert.equal(genxPostsFor(B).length, 0);
});

// =============================================================================
console.log('\n— D8: patient check after a mid-pass refresh');

await check('D8 a refresh bringing a different patient right before the post blocks it', async () => {
  const B = 'D8A';
  gx.tubes.push(gtube(B, [[1001, 'THY']], 'MRN-A'));
  const { inner, H } = build('d8');
  H.add(B, 'TSH3', 10001, 10001, { mrn: 'MRN-A' });
  await inner.pollOrders(); // cache: HINAI TSH3 for MRN-A, GenX TSH3 + FT4 for MRN-A
  // HINAI now lists FT4 too — under another patient.
  H.rows = [];
  H.add(B, 'TSH3', 10001, 10001, { mrn: 'MRN-Z' });
  H.add(B, 'FT4', 10002, 10002, { mrn: 'MRN-Z' });
  stage(inner, B, { TSH3: '1.0', FT4: '1.1' }); // FT4 misses the HINAI cache => live refresh
  await pass(inner);
  assert.equal(H.postedFor(B).length, 0, 'nothing posted to HINAI after the refresh changed the patient');
  assert.equal(genxPostsFor(B).length, 0, 'nor to GenX');
  assert.match(inner.staged.get(B)!.lastError ?? '', /patient differs/);
});

// =============================================================================
console.log('\n— D9: hmis.patientCheck');

await check('D9 hmis.patientCheck defaults to true', async () => {
  const f = join(root, 'd9-default.json');
  writeFileSync(f, JSON.stringify({ hmis: { auditLog: null, baseUrl: 'http://127.0.0.1:1/x' }, analyzers: [{ id: 'a', equipmentCode: 'E', transport: { type: 'tcp', port: 1 } }] }));
  assert.equal((loadConfig(f).hmis as Record<string, unknown>).patientCheck, true);
});

await check('D9 hmis.patientCheck false: different patient ids still file to both lanes', async () => {
  // Built through a real Connector, so the top-level switch reaches the runtime
  // however it is plumbed. The Connector is never started: nothing listens.
  const B = 'D9A';
  gx.tubes.push(gtube(B, [[1101, 'TSHONLY']], 'UH-B'));
  const hinaiPosted: Posted[] = [];
  const hinai = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/portal/mirth/pending') {
        return res.end(JSON.stringify({ status: 'success', data: [{ SampleID: B, eqIdntifier: 'TSH3', equipmentCode: 'EQC', labResultId: 11001, labServiceId: 1, parameterId: 1, mrn: 'MRN-A' }] }));
      }
      const rows = body ? (JSON.parse(body) as Posted[]) : [];
      if (url.pathname === '/portal/mirth/results') hinaiPosted.push(...rows);
      res.end(JSON.stringify({ status: 'success', message: 'ok', successData: rows }));
    });
  });
  const hp = await freePort();
  await new Promise<void>((r) => hinai.listen(hp, '127.0.0.1', () => r()));
  try {
    const name = 'd9';
    const f = join(root, `${name}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        logLevel: 'error',
        spoolDir: join(root, name, 'spool'),
        retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(root, name, 'logs'), includeSpoolPending: true },
        admin: { host: '127.0.0.1', port: await freePort(), authFile: join(root, name, 'auth.json') },
        autoCertify: { enabled: false, logFile: null },
        hmis: {
          mode: 'both',
          patientCheck: false,
          auditLog: join(root, name, 'logs', 'hmis.log'),
          hinai: { baseUrl: `http://127.0.0.1:${hp}/portal` },
          genx: { baseUrl: `http://127.0.0.1:${genxPort}`, clientId: 'c', clientSecret: 's', auditLog: join(root, name, 'logs', 'hmis-genx.log'), accessionCacheFile: join(root, name, 'acc.json'), serviceTests: SERVICE_TESTS },
        },
        analyzers: [{ id: 'chem', equipmentCode: 'EQC', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() }, filing: { mode: 'staged' } }],
      }),
    );
    const connector = new Connector(loadConfig(f), rec);
    const inner = (connector as unknown as { runtimes: Map<string, Inner> }).runtimes.get('chem')!;
    stage(inner, B, { TSH3: '7.0' });
    await pass(inner);
    assert.deepEqual(hinaiPosted.map((r) => r.labResultId), [11001], 'filed to HINAI despite MRN-A vs UH-B');
    assert.equal(genxPostsFor(B).length, 1, 'and to GenX');
    assert.doesNotMatch(inner.staged.get(B)!.lastError ?? '', /patient differs/);
  } finally {
    await new Promise<void>((r) => hinai.close(() => r()));
  }
});

await new Promise<void>((r) => genxServer.close(() => r()));
rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`\nlanes-edge-review: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nlanes-edge-review: all checks passed');
process.exit(0);
