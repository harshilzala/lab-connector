import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { lanesFor, loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';
import { HmisClient } from '../src/hmis/client.js';
import { GenxLimsClient } from '../src/hmis/genx-lims.js';

// =============================================================================
// HMIS lanes — both mode with HINAI + GenX on the lims-node profile
// (hmis.genx.profile "lims-node", src/hmis/genx-lims.ts), end to end, OFFLINE.
//
// A real Connector from a config file: the `im` block in both mode, a
// stand-in HINAI (/portal/mirth/*), a stand-in lims-node (login, connector
// orders / acknowledge / results) and a stand-in IM on both channels.
// Everything binds 127.0.0.1 on ephemeral ports; a fetch guard fails the run
// if any request is aimed at a non-loopback host.
//
//   1. config: both + ["hinai","genx"] + profile lims-node + auth login loads,
//      lanesFor gives [hinai, genx] for every analyzer, the genx lane is a
//      GenxLimsClient and the hinai lane an HmisClient
//   2. happy path: filed to BOTH; lims-node gets Bearer (from login) +
//      module-code DS, values named by parameterId (analyte lines) or
//      parameterCode (serviceTests expansion); acknowledged in each lane
//   3. hold: tube only in HINAI -> nothing filed anywhere, "order only in
//      HINAI — waiting for GenX"; lims-node lists it -> files to both
//   4. GenX outage: (a) tube already cached from GenX -> HINAI files, GenX
//      retried; (b) tube NOT cached from GenX (GenX down since before it was
//      listed) -> HINAI is BLOCKED too, every pass, until GenX answers or staff
//      press "File now" (which files HINAI only, GenX still retried)
//   5. patient mismatch: patientCheck true -> held, nothing posted;
//      patientCheck false (second Connector) -> filed to both
//   6. GenX partial: lims-node answers one value unmatched -> that value stays
//      pending in the GenX lane only; HINAI lane filed
//
// Run: npx tsx test/lanes-genx-lims.test.ts
// =============================================================================

// ---- safety: loopback only ---------------------------------------------------
const escaped: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') {
    escaped.push(url.href);
    throw new TypeError(`test guard: refused non-loopback request to ${url.host}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const warns: string[] = [];
const quiet: any = {
  child: () => quiet,
  info() {},
  warn(...args: unknown[]) {
    warns.push(JSON.stringify(args));
  },
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  level: 'silent',
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 25000): Promise<void> {
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
const LIVE_PORTS = new Set([2030, 2031, 2032, 2033, 2034, 7071]);
async function testPort(): Promise<number> {
  for (;;) {
    const p = await freePort();
    if (!LIVE_PORTS.has(p)) return p;
  }
}
const sorted = (l: readonly string[]) => [...l].sort();

const dir = mkdtempSync(join(tmpdir(), 'lanes-genx-lims-'));
process.env.LAB_CONNECTOR_ENV = '/nonexistent.env';
for (const k of Object.keys(process.env)) {
  if (k === 'HMIS_BASE_URL' || k.startsWith('GENX_') || k.startsWith('TATVA_') || k === 'AUTOCERTIFY_ORACLE_PASSWORD') delete process.env[k];
}
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';

const EQ = 'EQ0022';
const UHID = '10032026040311';
const A = 'LB2611170301'; // both lanes: HINAI TSH3 FT4 B12 | lims THY line (TSH3 5001, FT4 5002), VITB12 line (no analytes -> serviceTests B12)
const B = 'LB2611170302'; // HINAI only at first; lims lists it later
const P = 'LB2611170303'; // both lanes, GenX names another patient
const Q = 'LB2611170304'; // both lanes: lims answers FT4 (5002) unmatched
const C = 'LB2611170305'; // both lanes, cached; then lims goes 500 for everything
const D = 'LB2611170306'; // listed in both, but lims is down from before it was listed: never cached from GenX

// ---- stand-in HINAI ----------------------------------------------------------
const hrow = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: EQ, equipmentId: 46150218, labResultId,
  labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric',
  specimenName: 'Serum', FName: 'ASHA', LName: 'PATEL', Gender: 2, DOB: '03-12-1987', mrn: UHID, siteId: 2,
});
const hinaiRows = [
  hrow(A, 'TSH3', 94100001), hrow(A, 'FT4', 94100002), hrow(A, 'B12', 94100003),
  hrow(B, 'B12', 94100011),
  hrow(P, 'B12', 94100021),
  hrow(Q, 'TSH3', 94100031), hrow(Q, 'FT4', 94100032),
  hrow(C, 'B12', 94100041),
];
type Posted = { sampleId: string; identifier: string; resultValue: string; labResultId: number };
const hinaiPosted: Posted[] = [];
const hinaiAcked: Array<{ sampleID: string; labResultId: number }> = [];
const hinaiOther: string[] = [];
const hinai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
      const sample = (url.searchParams.get('sampleId') ?? '').toUpperCase();
      const eq = url.searchParams.get('eqCode');
      const rows = hinaiRows.filter((r) => (!sample || r.SampleID === sample) && (!eq || r.equipmentCode === eq));
      return res.end(JSON.stringify({ status: 'success', data: rows }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/labresult') {
      const rows = JSON.parse(body) as Posted[];
      hinaiPosted.push(...rows);
      return res.end(JSON.stringify({ status: 'success', message: 'saved', successData: rows }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/acknowledge') {
      const rows = JSON.parse(body) as Array<{ sampleID: string; labResultId: number }>;
      hinaiAcked.push(...rows);
      return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: rows }));
    }
    hinaiOther.push(`${req.method} ${url.pathname}`);
    res.statusCode = 404;
    res.end('{}');
  });
});

// ---- stand-in lims-node --------------------------------------------------------
const TOKEN = 'lims-test-token-1';
const LIMS_USER = 'lab.connector';
const LIMS_PASS = 'pw-offline-test';
type LimsTube = { barcode: string; priority: string; specimenName: string; patient: Record<string, string>; tests: unknown[] };
const ltube = (barcode: string, lines: Array<{ id: number; svc: string; params?: Array<[number, string]> }>, uhid = UHID): LimsTube => ({
  barcode,
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid, name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: lines.map((l) => ({
    sampleLineId: l.id,
    serviceId: 10,
    serviceCode: l.svc,
    lineStatus: 'PENDING',
    ...(l.params ? { parameters: l.params.map(([pid, code]) => ({ parameterId: pid, parameterCode: code, machineTestCode: code })) } : {}),
  })),
});
const THY = (id: number) => ({ id, svc: 'THY', params: [[5001, 'TSH3'], [5002, 'FT4']] as Array<[number, string]> });
const limsTubes: LimsTube[] = [
  ltube(A, [THY(8001), { id: 8002, svc: 'VITB12' }]),
  ltube(P, [{ id: 8021, svc: 'VITB12' }], 'UH-OTHER-77'),
  ltube(Q, [THY(8031)]),
  ltube(C, [{ id: 8041, svc: 'VITB12' }]),
];
type LimsCall = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any };
const limsCalls: LimsCall[] = [];
const limsLogins: any[] = [];
const limsOther: string[] = [];
let limsDown = false; // every connector route answers 500 (login stays up)
/** barcode -> parameterIds lims answers "unmatched" for. */
const limsUnmatched = new Map<string, number[]>();
const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const limsEnvelope = (data: unknown, message = 'ok') => JSON.stringify({ success: true, message, data, timestamp: new Date().toISOString() });
const lims = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      limsLogins.push(body);
      if (body?.userName !== LIMS_USER || body?.password !== LIMS_PASS) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ success: false, message: 'bad credentials' }));
      }
      return res.end(JSON.stringify({ token: TOKEN }));
    }
    const call: LimsCall = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body };
    if (!url.pathname.startsWith('/api/v1/lab/connector/')) {
      limsOther.push(`${req.method} ${url.pathname}`);
      res.statusCode = 404;
      return res.end('{}');
    }
    limsCalls.push(call);
    if (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers['module-code'] !== 'DS') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ success: false, message: 'unauthorised' }));
    }
    if (limsDown) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ success: false, message: 'internal error' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/lab/connector/orders') {
      if (url.searchParams.get('equipmentCode') !== EQ) return res.end(limsEnvelope([]));
      const barcode = url.searchParams.get('barcode');
      const date = url.searchParams.get('date');
      const list = barcode ? limsTubes.filter((t) => t.barcode === barcode.toUpperCase()) : date === today() ? limsTubes : [];
      return res.end(limsEnvelope(list));
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/lab/connector/acknowledge') {
      return res.end(limsEnvelope({ results: (body.barcodes as string[]).map((b) => ({ barcode: b, acknowledged: true })) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/lab/connector/results') {
      const bad = new Set(limsUnmatched.get(body.barcode) ?? []);
      const values = body.values as Array<{ parameterId?: number; parameterCode?: string }>;
      const unmatched = values.filter((v) => v.parameterId != null && bad.has(v.parameterId)).map((v) => ({ parameterId: v.parameterId, reason: 'parameter not mapped for equipment' }));
      return res.end(limsEnvelope({ filed: values.length - unmatched.length, unmatched }, 'results saved'));
    }
    limsOther.push(`${req.method} ${url.pathname}`);
    res.statusCode = 404;
    res.end('{}');
  });
});

// ---- stand-in IM: order listener + result sender ------------------------------
const orders: string[] = [];
const im = net.createServer((sock) => {
  const dec = new MllpDecoder('utf8');
  sock.on('data', (chunk) => {
    for (const text of dec.push(chunk)) {
      const msg = parseHl7(text);
      orders.push(msg.segments.find((s) => s.name === 'OBR')?.fields[2] ?? '');
      sock.write(wrapMllp(`MSH|^~\\&|IM||HMIS-LIS||20261117120000||ACK|A${msg.controlId}|P|2.3.1\rMSA|AA|${msg.controlId}\r`, 'utf8'));
    }
  });
  sock.on('error', () => {});
});

let oruSeq = 0;
const resultAcks: string[] = [];
let resultSock: net.Socket | null = null;
let resultPort = 0;
async function sendResult(barcode: string, values: Record<string, string>): Promise<void> {
  if (!resultSock) {
    resultSock = net.connect({ host: '127.0.0.1', port: resultPort });
    await new Promise<void>((r, j) => {
      resultSock!.once('connect', () => r());
      resultSock!.once('error', j);
    });
    const dec = new MllpDecoder('utf8');
    resultSock.on('data', (c) => resultAcks.push(...dec.push(c)));
    resultSock.on('error', () => {});
  }
  const id = `R${String(++oruSeq).padStart(4, '0')}`;
  const obx = Object.entries(values).map(([code, v], i) => `OBX|${i + 1}|NM|${code}^${code}||${v}|||N|||F`);
  const text = [`MSH|^~\\&|IM|LAB|HMIS-LIS||20261117120000||ORU^R01|${id}|P|2.3.1`, `PID|1||${UHID}||PATEL^ASHA`, `OBR|1|${barcode}|${barcode}|X`, ...obx].join('\r') + '\r';
  const before = resultAcks.length;
  resultSock.write(wrapMllp(text, 'utf8'));
  await until(`IM's ${id} (${barcode}) to be acknowledged`, () => resultAcks.length > before);
}

// ---- config ------------------------------------------------------------------
const [hinaiPort, limsPort] = [await testPort(), await testPort()];
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));
await new Promise<void>((r) => lims.listen(limsPort, '127.0.0.1', () => r()));

function writeConfig(name: string, o: { orderPort: number; resultPort: number; adminPort: number; patientCheck: boolean; extraAnalyzers?: unknown[] }): string {
  const sub = join(dir, name);
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      logLevel: 'error',
      spoolDir: join(sub, 'spool'),
      hmis: {
        mode: 'both',
        both: ['hinai', 'genx'],
        patientCheck: o.patientCheck,
        auditLog: join(sub, 'logs', 'hmis.log'),
        hinai: { baseUrl: `http://127.0.0.1:${hinaiPort}/portal`, siteIds: ['2'], resultsPath: '/mirth/labresult' },
        genx: {
          profile: 'lims-node',
          baseUrl: `http://127.0.0.1:${limsPort}`,
          auditLog: join(sub, 'logs', 'hmis-genx.log'),
          accessionCacheFile: join(sub, 'genx-acc.json'),
          serviceTests: { VITB12: ['B12'] },
          pendingLineStatuses: [],
          lims: {
            authBaseUrl: `http://127.0.0.1:${limsPort}`,
            auth: 'login',
            username: LIMS_USER,
            password: LIMS_PASS,
          },
        },
      },
      retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(sub, 'logs'), includeSpoolPending: true },
      admin: { host: '127.0.0.1', port: o.adminPort, authFile: join(sub, 'admin-auth.json') },
      autoCertify: { enabled: false, logFile: null },
      im: {
        enabled: true,
        equipmentCode: EQ,
        equipmentId: 46150218,
        siteIds: ['2'],
        orders: { host: '127.0.0.1', port: o.orderPort },
        results: { host: '127.0.0.1', port: o.resultPort },
        autoCertify: { hinai: false, genx: false },
        analyzer: {
          orderPoll: { intervalMs: 5000, lookbackDays: 0 },
          filing: { passIntervalMs: 5000 },
          hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } },
        },
      },
      ...(o.extraAnalyzers ? { analyzers: o.extraAnalyzers } : {}),
    }),
  );
  return file;
}

type LaneState = { filedAt: string | null; identifier: string | null; labResultId: number | null; skipped?: 'operator' };
type StoredValue = { value: string; filedAt: string | null; lanes?: Partial<Record<'hinai' | 'genx', LaneState>> };
type StoredSample = { lastError: string | null; values: Record<string, StoredValue> };
let spoolOf = '';
const stored = (barcode: string): StoredSample | null => {
  const p = join(spoolOf, 'im', 'results', `${barcode}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as StoredSample) : null;
};
const hinaiFor = (b: string) => hinaiPosted.filter((r) => r.sampleId === b);
const limsResults = (b: string) => limsCalls.filter((c) => c.path.endsWith('/connector/results') && c.body?.barcode === b);
const limsAcks = (b: string) => limsCalls.filter((c) => c.path.endsWith('/connector/acknowledge') && (c.body?.barcodes ?? []).includes(b));
/** Values lims-node accepted (answered 200, not unmatched) for a barcode, as "name=value". */
const limsFiled = (b: string) =>
  limsResults(b).flatMap((c) => (c.body.values as Array<{ parameterId?: number; parameterCode?: string; value: string }>).map((v) => `${v.parameterId ?? v.parameterCode}=${v.value}`));
const rt = (c: Connector) => (c as unknown as { runtimes: Map<string, { gateways: Record<string, unknown> }> }).runtimes;

const results: Array<[string, boolean, string]> = [];
async function scenario(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const note = (await fn()) ?? '';
    results.push([name, true, note]);
    console.log(`✓ ${name}${note ? `\n    ${note}` : ''}`);
  } catch (err) {
    results.push([name, false, err instanceof Error ? err.message : String(err)]);
    console.log(`✗ ${name}\n    ${(err instanceof Error ? err.stack ?? err.message : String(err)).split('\n').join('\n    ')}`);
  }
}

let connector: Connector | null = null;
let connector2: Connector | null = null;
try {
  // ---- 1) config --------------------------------------------------------------
  await scenario('1. config: both [hinai, genx], genx profile lims-node, auth login', async () => {
    const file = writeConfig('cfg-check', {
      orderPort: await testPort(),
      resultPort: await testPort(),
      adminPort: await testPort(),
      patientCheck: true,
      extraAnalyzers: [{ id: 'chem', equipmentCode: 'EQC', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await testPort() }, filing: { mode: 'staged' } }],
    });
    const cfg = loadConfig(file);
    assert.equal(cfg.hmis.mode, 'both');
    assert.deepEqual(cfg.hmis.both, ['hinai', 'genx']);
    assert.equal(cfg.hmis.genx.profile, 'lims-node');
    assert.equal(cfg.hmis.genx.lims.auth, 'login');
    assert.equal(cfg.hmis.genx.lims.moduleCode, 'DS');
    assert.equal(cfg.hmis.genx.lims.apiPrefix, '/api/v1/lab');
    for (const url of [cfg.hmis.baseUrl, cfg.hmis.genx.baseUrl, cfg.hmis.genx.lims.authBaseUrl, cfg.hmis.tatva.baseUrl].filter(Boolean)) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+(\/|$)/, `loopback only: ${url}`);
    }
    assert.ok(cfg.analyzers.length >= 2, 'im + chem');
    for (const a of cfg.analyzers) assert.deepEqual(lanesFor(a, cfg), ['hinai', 'genx'], `lanes of ${a.id}`);
    const c = new Connector(cfg, quiet); // constructed only — nothing is started or bound
    for (const [id, r] of rt(c)) {
      assert.ok(r.gateways.genx instanceof GenxLimsClient, `${id}: genx lane is GenxLimsClient`);
      assert.ok(r.gateways.hinai instanceof HmisClient, `${id}: hinai lane is HmisClient`);
      assert.equal((r.gateways.genx as GenxLimsClient).rowStyle, 'genx');
    }
    return `analyzers ${cfg.analyzers.map((a) => a.id).join(', ')} -> [hinai, genx]; genx gateway = GenxLimsClient`;
  });

  // ---- the running connector ---------------------------------------------------
  const [orderPort, rPort, adminPort] = [await testPort(), await testPort(), await testPort()];
  resultPort = rPort;
  await new Promise<void>((r) => im.listen(orderPort, '127.0.0.1', () => r()));
  const cfgFile = writeConfig('run1', { orderPort, resultPort, adminPort, patientCheck: true });
  const cfg1 = loadConfig(cfgFile);
  spoolOf = cfg1.spoolDir;
  connector = new Connector(cfg1, quiet);
  assert.ok(rt(connector).get('im')?.gateways.genx instanceof GenxLimsClient, 'running IM: GenxLimsClient');
  await connector.start();
  const summaryOf = (b: string) => (connector!.staged('im') ?? []).find((s) => s.barcode === b);
  await until('the first poll to send A, B, P, Q, C to IM', () => [A, B, P, Q, C].every((b) => orders.includes(b)));

  // ---- 2) happy path -----------------------------------------------------------
  await scenario('2. happy path: filed to HINAI and lims-node, acknowledged in each', async () => {
    await sendResult(A, { TSH3: '2.14', FT4: '1.10', B12: '412' });
    await until('A filed in HINAI', () => hinaiFor(A).length >= 3);
    await until('A posted to lims-node', () => limsResults(A).length >= 1);
    await until('A acknowledged in HINAI', () => hinaiAcked.filter((r) => r.sampleID === A).length >= 3);
    await until('A acknowledged in lims-node', () => limsAcks(A).length >= 1);
    await until('A complete in the store', () => Object.values(stored(A)?.values ?? {}).every((v) => v.filedAt));
    const h = Object.fromEntries(hinaiFor(A).map((r) => [r.identifier, [r.resultValue, r.labResultId]]));
    assert.deepEqual(h, { TSH3: ['2.14', 94100001], FT4: ['1.10', 94100002], B12: ['412', 94100003] }, 'HINAI rows with its own labResultIds');
    assert.equal(limsResults(A).length, 1, 'one results POST for the tube');
    const call = limsResults(A)[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['module-code'], 'DS');
    assert.match(String(call.headers['content-type']), /application\/json/);
    assert.ok(call.headers['idempotency-key'], 'idempotency-key header');
    assert.equal(call.body.barcode, A);
    assert.equal(call.body.equipmentCode, EQ);
    assert.match(call.body.messageId, new RegExp(`^${EQ}-[0-9a-f]{16}$`));
    const named = (call.body.values as Array<Record<string, unknown>>).map((v) => ({ id: v.parameterId, code: v.parameterCode, value: v.value }));
    assert.deepEqual(
      named.sort((x, y) => String(x.value).localeCompare(String(y.value))),
      [
        { id: 5002, code: undefined, value: '1.10' },
        { id: 5001, code: undefined, value: '2.14' },
        { id: undefined, code: 'B12', value: '412' },
      ],
      'analyte lines by parameterId; the serviceTests-expanded line by parameterCode',
    );
    const ack = limsAcks(A)[0]!;
    assert.deepEqual(ack.body, { equipmentCode: EQ, barcodes: [A] });
    assert.equal(ack.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(ack.headers['module-code'], 'DS');
    // Every lims-node call carried the login token and module-code.
    for (const c of limsCalls) {
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`, `${c.method} ${c.path}`);
      assert.equal(c.headers['module-code'], 'DS', `${c.method} ${c.path}`);
    }
    assert.ok(limsLogins.length >= 1);
    assert.deepEqual({ u: limsLogins[0].userName, p: limsLogins[0].password }, { u: LIMS_USER, p: LIMS_PASS });
    const polls = limsCalls.filter((c) => c.path.endsWith('/connector/orders'));
    assert.ok(polls.every((c) => c.query.get('equipmentCode') === EQ), 'orders always filtered by equipmentCode');
    assert.ok(polls.some((c) => c.query.get('date') === today()), 'batch poll by date');
    const s = stored(A)!;
    for (const [code, hl, gl] of [['TSH3', 94100001, 8001], ['FT4', 94100002, 8001], ['B12', 94100003, 8002]] as const) {
      const v = s.values[code]!;
      assert.ok(v.lanes?.hinai?.filedAt && v.lanes?.genx?.filedAt, `${code} filed in both lanes`);
      assert.equal(v.lanes!.hinai!.labResultId, hl);
      assert.equal(v.lanes!.genx!.labResultId, gl, `${code}: GenX labResultId = sampleLineId`);
    }
    assert.ok(summaryOf(A)?.complete);
    return `logins so far: ${limsLogins.length}; results body values: ${JSON.stringify(call.body.values)}`;
  });

  // ---- 3) hold rule ------------------------------------------------------------
  await scenario('3. no hold: tube only in HINAI -> HINAI files now; lims-node lists it later -> GenX files too', async () => {
    await sendResult(B, { B12: '500' });
    await until('B filed in HINAI straight away', () => hinaiFor(B).length >= 1);
    await until('B says GenX has no order', () => /GenX has no order/i.test(stored(B)?.lastError ?? ''));
    const why = stored(B)!.lastError ?? '';
    assert.equal(limsResults(B).length, 0, 'nothing to lims-node — it has no order');
    assert.ok(limsCalls.some((c) => c.path.endsWith('/connector/orders') && c.query.get('barcode') === B), 'a live by-barcode lookup was made in lims-node');
    const since = Date.now();
    limsTubes.push(ltube(B, [{ id: 8011, svc: 'VITB12' }]));
    await until('B filed in lims-node once it lists it', () => limsResults(B).length >= 1, 20000);
    await until('B done', () => !!stored(B)?.values.B12?.filedAt);
    const took = Date.now() - since;
    const v = stored(B)!.values.B12!;
    assert.equal(v.lanes?.hinai?.labResultId, 94100011);
    assert.equal(v.lanes?.genx?.labResultId, 8011);
    assert.equal(hinaiFor(B).length, 1, 'HINAI not re-posted');
    await until('waiting reason cleared', () => !stored(B)?.lastError);
    return `while GenX had no order: "${why}"; GenX filed ${Math.round(took / 1000)} s after lims-node started listing it`;
  });

  // ---- 5a) patient mismatch, patientCheck on -----------------------------------
  let mismatchWhy = '';
  await scenario('5a. patient mismatch, patientCheck true -> held, nothing posted', async () => {
    await sendResult(P, { B12: '333' });
    await until('P held on the patient check', () => /patient differs/i.test(stored(P)?.lastError ?? ''));
    mismatchWhy = stored(P)!.lastError!;
    assert.match(mismatchWhy, /HINAI \(10032026040311\)/);
    assert.match(mismatchWhy, /GenX \(UH-OTHER-77\)/);
    await wait(6000);
    assert.equal(hinaiFor(P).length, 0, 'nothing to HINAI');
    assert.equal(limsResults(P).length, 0, 'nothing to lims-node');
    // Not even File now: it is refused with the mismatch message.
    let refused = '';
    await connector!.fileNow('im', P).then(
      () => assert.fail('File now should be refused while the patients differ'),
      (err: unknown) => (refused = err instanceof Error ? err.message : String(err)),
    );
    assert.match(refused, /patient differs/);
    await wait(1000);
    assert.equal(hinaiFor(P).length + limsResults(P).length, 0, 'File now does not override the patient hold');
    return `held message: "${mismatchWhy}"; File now rejects with the same message`;
  });

  // ---- 6) GenX partial ------------------------------------------------------------
  await scenario('6. lims-node answers one value unmatched -> pending in GenX lane only', async () => {
    limsUnmatched.set(Q, [5002]);
    await sendResult(Q, { TSH3: '3.30', FT4: '0.90' });
    await until('Q filed in HINAI', () => hinaiFor(Q).length >= 2);
    await until('Q posted to lims-node', () => limsResults(Q).length >= 1);
    await until('Q TSH3 filed in GenX lane', () => !!stored(Q)?.values.TSH3?.lanes?.genx?.filedAt);
    const s = stored(Q)!;
    assert.ok(s.values.TSH3!.filedAt, 'TSH3 done (both lanes)');
    assert.ok(s.values.FT4!.lanes?.hinai?.filedAt, 'FT4 filed in HINAI');
    assert.ok(!s.values.FT4!.lanes?.genx?.filedAt, 'FT4 NOT filed in GenX');
    assert.equal(s.values.FT4!.filedAt, null, 'FT4 not done');
    assert.equal(summaryOf(Q)?.complete, false);
    const first = limsResults(Q)[0]!;
    assert.deepEqual(sorted((first.body.values as Array<{ parameterId: number }>).map((v) => String(v.parameterId))), ['5001', '5002']);
    // What happens over the next passes.
    const postsBefore = limsResults(Q).length;
    await wait(11000);
    const later = limsResults(Q).slice(postsBefore);
    const s2 = stored(Q)!;
    assert.equal(hinaiFor(Q).length, 2, 'HINAI never re-posted');
    assert.ok(!s2.values.FT4!.lanes?.genx?.filedAt, 'FT4 still pending in GenX');
    const resent = later.map((c) => (c.body.values as Array<{ parameterId: number }>).map((v) => v.parameterId).join('+'));
    // 2026-11-17: a refused value is no longer re-posted on every pass — it
    // waits filing.recheckMs (5 min here) after the refusal, like HINAI's
    // recheck cadence, so nothing more reaches lims-node within 11 s.
    assert.equal(later.length, 0, `FT4 not re-sent within the retry window: ${resent.join(', ')}`);
    assert.equal(s2.values.FT4!.lanes?.genx?.refusals, 1, 'FT4 recorded as refused once by GenX');
    assert.match(s2.lastError ?? '', /GenX did not accept FT4 — retried every 5 min/, 'the sample says GenX refused FT4 and when it is retried');
    const acked = limsAcks(Q).length;
    return `lims-node acknowledged Q ${acked}x (whole tube, though FT4 unplaced); in 11 s after the partial: ${later.length} more results POST(s) [${resent.join(', ')}]; lastError="${s2.lastError}"`;
  });
  limsUnmatched.delete(Q);

  // ---- 4a) GenX outage, tube already cached from GenX --------------------------------
  await scenario('4a. lims-node 500, tube already cached from GenX -> HINAI files, GenX retried', async () => {
    limsDown = true;
    const n0 = limsResults(C).length;
    await sendResult(C, { B12: '250' });
    await until('C filed in HINAI', () => hinaiFor(C).length >= 1);
    await until('lims-node tried C', () => limsResults(C).length > n0);
    await wait(500);
    const v = stored(C)!.values.B12!;
    assert.ok(v.lanes?.hinai?.filedAt, 'HINAI lane filed');
    assert.ok(!v.lanes?.genx?.filedAt, 'GenX lane not filed');
    const why = stored(C)!.lastError ?? '';
    limsDown = false;
    await until('GenX files C once lims-node is back', () => !!stored(C)?.values.B12?.lanes?.genx?.filedAt, 20000);
    await until('C done', () => !!stored(C)?.values.B12?.filedAt);
    assert.equal(hinaiFor(C).length, 1, 'HINAI not re-posted');
    await until('C acknowledged in lims-node', () => limsAcks(C).length >= 1);
    return `during the outage lastError="${why}"`;
  });

  // ---- 4b) GenX outage, tube never cached from GenX -----------------------------------
  await scenario('4b. lims-node 500 BEFORE the tube was ever listed -> HINAI files anyway; GenX after recovery', async () => {
    limsDown = true;
    try {
      hinaiRows.push(hrow(D, 'B12', 94100051));
      limsTubes.push(ltube(D, [{ id: 8051, svc: 'VITB12' }]));
      await until('HINAI order for D pushed to IM (GenX poll failing)', () => orders.includes(D), 20000);
      await sendResult(D, { B12: '199' });
      await until('D filed in HINAI although GenX cannot be asked', () => hinaiFor(D).length >= 1);
      await until('D in the store with a GenX error', () => /GenX/i.test(stored(D)?.lastError ?? ''));
      const why = stored(D)!.lastError!;
      const v = stored(D)!.values.B12!;
      assert.ok(v.lanes?.hinai?.filedAt, 'HINAI lane filed');
      assert.ok(!v.lanes?.genx?.filedAt && !v.lanes?.genx?.skipped, 'GenX lane neither filed nor skipped — retried');
      limsDown = false;
      await until('GenX files D once lims-node is back', () => !!stored(D)?.values.B12?.lanes?.genx?.filedAt, 20000);
      await until('D done', () => !!stored(D)?.values.B12?.filedAt);
      assert.equal(hinaiFor(D).length, 1, 'HINAI not re-posted');
      return `during outage lastError="${why}"; HINAI filed straight away, GenX filed automatically after recovery`;
    } finally {
      limsDown = false;
    }
  });

  // ---- 5b) patient mismatch, patientCheck off (second connector) ---------------------
  await connector.stop().catch(() => {});
  connector = null;
  (resultSock as net.Socket | null)?.destroy();
  resultSock = null;
  await scenario('5b. patient mismatch, patientCheck false -> filed to both', async () => {
    const [orderPort2, rPort2, adminPort2] = [await testPort(), await testPort(), await testPort()];
    await new Promise<void>((r) => im.close(() => r()));
    await new Promise<void>((r) => im.listen(orderPort2, '127.0.0.1', () => r()));
    resultPort = rPort2;
    const cfg2 = loadConfig(writeConfig('run2', { orderPort: orderPort2, resultPort: rPort2, adminPort: adminPort2, patientCheck: false }));
    assert.equal(cfg2.hmis.patientCheck, false);
    spoolOf = cfg2.spoolDir;
    const o0 = orders.length;
    connector2 = new Connector(cfg2, quiet);
    await connector2.start();
    await until('run2 first poll pushes P', () => orders.slice(o0).includes(P));
    await sendResult(P, { B12: '333' });
    await until('P filed in HINAI', () => hinaiFor(P).length >= 1);
    await until('P filed in lims-node', () => limsResults(P).length >= 1);
    await until('P done', () => !!stored(P)?.values.B12?.filedAt);
    assert.deepEqual(limsFiled(P), ['B12=333']);
    return 'P (HINAI 10032026040311 vs GenX UH-OTHER-77) filed to both';
  });

  // ---- global checks -----------------------------------------------------------------
  await scenario('no stray calls; loopback only', async () => {
    assert.deepEqual(escaped, [], 'no non-loopback request');
    assert.deepEqual(hinaiOther, [], 'HINAI: only pending / labresult / acknowledge');
    assert.deepEqual(limsOther, [], 'lims-node: only login and connector routes');
    assert.ok(!limsCalls.some((c) => /certify/.test(c.path)), 'no certify call (genx auto-certify off)');
  });
} catch (err) {
  results.push(['harness', false, err instanceof Error ? err.stack ?? err.message : String(err)]);
  console.error('✗ harness: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
} finally {
  (resultSock as net.Socket | null)?.destroy();
  await connector?.stop().catch(() => {});
  await (connector2 as Connector | null)?.stop().catch(() => {});
  await new Promise<void>((r) => (im.listening ? im.close(() => r()) : r()));
  await new Promise<void>((r) => hinai.close(() => r()));
  await new Promise<void>((r) => lims.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

const failedN = results.filter(([, ok]) => !ok).length;
if (failedN) {
  console.error(`\nlanes-genx-lims: ${failedN} FAILED`);
  process.exit(1);
}
console.log('\nlanes-genx-lims: all checks passed');
process.exit(0);
