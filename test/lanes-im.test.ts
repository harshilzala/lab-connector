import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';
import { GenxHmisClient } from '../src/hmis/genx.js';

// =============================================================================
// HMIS lanes — the `im` block in single mode (scenarios 8 and 9).
//
//   0. GenxHmisClient.autoCertify on its own: GET + query string by default,
//      POST + JSON body when configured, bearer token / api key / 401 retry /
//      double-envelope check like every other GenX call, audited as "certify"
//   8. im block, single hinai: IM behaves exactly as today — orders pushed,
//      results from the result channel filed and acknowledged — and GenX is
//      never called
//   9. im block, single genx, genxAutoCertify: orders from the GenX worklist
//      pushed to IM; results posted to GenX; a line certified once all its
//      codes are filed, never twice; a partly filed line not certified; a
//      failed certify retried; POST / path / param overrides honoured; the
//      certify calls audited in hmis-<date>.log (GenX is the only lane)
//
// Run: npx tsx test/lanes-im.test.ts
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
const listen = (s: http.Server | net.Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
const close = (s: http.Server | net.Server) => new Promise<void>((r) => s.close(() => r()));

const dir = mkdtempSync(join(tmpdir(), 'lanes-im-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';

// ---- stand-ins, built per run ------------------------------------------------
const envelope = (data: unknown, innerSuccess = true) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: innerSuccess, message: innerSuccess ? 'ok' : 'line not ready', timestamp: 't', data } });

type Req = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string };
function makeHinai(rows: Array<Record<string, unknown>>) {
  const seen: Req[] = [];
  const posted: Array<{ sampleId: string; identifier: string; resultValue: string; labResultId: number }> = [];
  const acked: Array<{ sampleID: string; labResultId: number }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
        const sample = (url.searchParams.get('sampleId') ?? '').toUpperCase();
        const eq = url.searchParams.get('eqCode');
        return res.end(JSON.stringify({ status: 'success', data: rows.filter((r) => (!sample || r.SampleID === sample) && (!eq || r.equipmentCode === eq)) }));
      }
      if (req.method === 'POST' && url.pathname === '/portal/mirth/labresult') {
        const got = JSON.parse(body);
        posted.push(...got);
        return res.end(JSON.stringify({ status: 'success', message: 'saved', successData: got }));
      }
      if (req.method === 'POST' && url.pathname === '/portal/mirth/acknowledge') {
        const got = JSON.parse(body);
        acked.push(...got);
        return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: got }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return { server, seen, posted, acked };
}

type Tube = ReturnType<typeof gtube>;
const gtube = (barcode: string, tests: Array<[number, string]>) => ({
  accessionNumber: 'ACC' + barcode,
  sampleNumber: barcode,
  sampleId: barcode.slice(-4),
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid: 'UH10032026', name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
function makeGenx(tubes: Tube[], certifyPath: string) {
  const seen: Req[] = [];
  const filed: Array<{ accessionNumber: string; code: string; value: string }> = [];
  const acked: string[] = [];
  /** line id => answers still to fail with (status code, or "refused" for an inner success:false). */
  const certifyFailures = new Map<string, Array<number | 'refused'>>();
  const certifyCalls: Array<{ method: string; lineId: string; headers: http.IncomingHttpHeaders; ok: boolean }> = [];
  let tokens = 0;
  let expireNext = false;
  /** The parameter name the certify call carries the line id in. */
  let currentParam = 'labresultid';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/auth-service/api/oauth/token') {
        tokens++;
        return res.end(JSON.stringify({ access_token: `tok${tokens}`, token_type: 'Bearer', expires_in: 3600 }));
      }
      if (expireNext) {
        expireNext = false;
        res.statusCode = 401;
        return res.end('{"error":"invalid_token"}');
      }
      if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
        const barcode = url.searchParams.get('barcode');
        const content = barcode === null ? tubes : tubes.filter((t) => t.sampleNumber === barcode.toUpperCase());
        return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
      }
      if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
        const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string; value: string }> };
        for (const r of sent.results) filed.push({ accessionNumber: sent.accessionNumber, code: r.machineTestCode, value: r.value });
        return res.end(envelope({ filed: sent.results.length, unmatched: [] }));
      }
      if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') {
        const sent = JSON.parse(body) as { acknowledgements: Array<{ accessionNumber: string }> };
        acked.push(...sent.acknowledgements.map((a) => a.accessionNumber));
        return res.end(envelope({ acknowledgements: sent.acknowledgements.map((a) => ({ ...a, acknowledged: true })) }));
      }
      if (url.pathname === certifyPath) {
        const param = currentParam;
        let lineId = url.searchParams.get(param) ?? '';
        if (req.method === 'POST' && body) lineId = String((JSON.parse(body) as Record<string, unknown>)[param] ?? '');
        const queue = certifyFailures.get(lineId) ?? [];
        const failure = queue.shift();
        certifyCalls.push({ method: req.method!, lineId, headers: req.headers, ok: failure === undefined });
        if (failure === 'refused') return res.end(envelope(null, false));
        if (typeof failure === 'number') {
          res.statusCode = failure;
          return res.end('{"error":"certify backend down"}');
        }
        return res.end(envelope({ certified: true, labResultId: lineId }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return {
    server,
    seen,
    filed,
    acked,
    certifyFailures,
    certifyCalls,
    setParam: (p: string) => (currentParam = p),
    expireNextCall: () => (expireNext = true),
    tokens: () => tokens,
  };
}

function makeIm() {
  const orders: Array<{ barcode: string; codes: string[] }> = [];
  const server = net.createServer((sock) => {
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
  return { server, orders };
}

/** IM dialling the connector's result channel. */
function resultSender(port: number) {
  let sock: net.Socket | null = null;
  const acks: string[] = [];
  let seq = 0;
  return {
    async send(barcode: string, values: Record<string, string>) {
      if (!sock) {
        sock = net.connect({ host: '127.0.0.1', port });
        await new Promise<void>((r, j) => {
          sock!.once('connect', () => r());
          sock!.once('error', j);
        });
        const dec = new MllpDecoder('utf8');
        sock.on('data', (c) => acks.push(...dec.push(c)));
        sock.on('error', () => {});
      }
      const id = `R${String(++seq).padStart(4, '0')}`;
      const obx = Object.entries(values).map(([code, v], i) => `OBX|${i + 1}|NM|${code}^${code}||${v}|||N|||F`);
      const text = [`MSH|^~\\&|IM|LAB|HMIS-LIS||20261011120000||ORU^R01|${id}|P|2.3.1`, `OBR|1|${barcode}|${barcode}|X`, ...obx].join('\r') + '\r';
      const before = acks.length;
      sock.write(wrapMllp(text, 'utf8'));
      await until(`IM's ${id} to be acknowledged`, () => acks.length > before);
    },
    close() {
      sock?.destroy();
    },
  };
}

async function writeConfig(name: string, body: Record<string, unknown>): Promise<string> {
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      logLevel: 'error',
      spoolDir: join(dir, name, 'spool'),
      retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(dir, name, 'logs'), includeSpoolPending: true },
      admin: { host: '127.0.0.1', port: await freePort(), authFile: join(dir, name, 'admin-auth.json') },
      autoCertify: { enabled: false, logFile: null },
      ...body,
    }),
  );
  return file;
}
type StoredSample = {
  lastError: string | null;
  certified?: { genx?: number[] };
  values: Record<string, { value: string; filedAt: string | null; lanes?: Record<string, { filedAt: string | null; labResultId: number | null }> }>;
};
const stored = (name: string, barcode: string): StoredSample | null => {
  const p = join(dir, name, 'spool', 'im', 'results', `${barcode}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as StoredSample) : null;
};

let failed = false;
const fail = (err: unknown) => {
  failed = true;
  console.error('✗ ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
};

// =============================================================================
// 0) GenxHmisClient.autoCertify on its own
// =============================================================================
console.log('\n— GenxHmisClient.autoCertify');
{
  const DEFAULT_PATH = '/integration-service/external/v1/lab/equipment/autocertify';
  const g = makeGenx([], DEFAULT_PATH);
  const port = await freePort();
  await listen(g.server, port);
  const audit: Array<{ kind: string; url: string; outcome: string }> = [];
  const opts = {
    baseUrl: `http://127.0.0.1:${port}`,
    tokenPath: '/auth-service/api/oauth/token',
    worklistPath: '/integration-service/external/v1/lab/equipment/worklist',
    acknowledgePath: '/integration-service/external/v1/lab/equipment/acknowledge',
    resultsPath: '/integration-service/external/v1/lab/equipment/results',
    clientId: 'cid',
    clientSecret: 'secret',
    scope: '',
    clientAuth: 'basic' as const,
    apiKey: 'k123',
    apiKeyHeader: 'X-API-Key',
    barcodeField: 'sampleNumber' as const,
    serviceTests: {},
    equipmentServices: {},
    pendingLineStatuses: ['PENDING'],
    batchDays: 1,
    batchPageSize: 200,
    timeoutMs: 5000,
    tlsRejectUnauthorized: true,
    logger: quiet,
    audit: { record: (e: { kind: string; url: string; outcome: string }) => audit.push(e) } as any,
  };
  try {
    // Defaults: GET <path>?labresultid=<id>
    const client = new GenxHmisClient(opts);
    await client.autoCertify(190233, 'EQ0022');
    const c1 = g.certifyCalls.at(-1)!;
    assert.deepEqual([c1.method, c1.lineId], ['GET', '190233'], 'GET with labresultid in the query string');
    assert.equal(c1.headers.authorization, 'Bearer tok1', 'bearer token');
    assert.equal(c1.headers['x-api-key'], 'k123', 'api key');
    assert.ok(audit.some((e) => e.kind === 'certify' && e.url.includes(DEFAULT_PATH)), `audited as kind "certify" (${JSON.stringify(audit)})`);
    console.log('✓ default: GET <autoCertifyPath>?labresultid=<line>, bearer + api key, audited as certify');

    // 401 => one new token, retried.
    const tokens = g.tokens();
    g.expireNextCall();
    await client.autoCertify(190234, 'EQ0022');
    assert.equal(g.tokens(), tokens + 1, 'a 401 fetches one new token');
    assert.equal(g.certifyCalls.at(-1)!.lineId, '190234', 'and the certify is retried');
    console.log('✓ 401: new token, call retried');

    // The inner success flag is checked; an HTTP error throws.
    g.certifyFailures.set('190235', ['refused']);
    await assert.rejects(client.autoCertify(190235, 'EQ0022'), 'inner success:false is a failure');
    g.certifyFailures.set('190236', [500]);
    await assert.rejects(client.autoCertify(190236, 'EQ0022'), 'HTTP 500 is a failure');
    assert.ok(audit.some((e) => e.kind === 'certify' && e.outcome === 'error'), 'the failure is audited');
    console.log('✓ double envelope success:false and HTTP 500 both throw, and are audited');

    // POST + JSON body + custom param and path.
    const g2 = makeGenx([], '/lab/certify-line');
    const port2 = await freePort();
    await listen(g2.server, port2);
    g2.setParam('sampleLineId');
    const post = new GenxHmisClient({ ...opts, baseUrl: `http://127.0.0.1:${port2}`, autoCertifyPath: '/lab/certify-line', autoCertifyMethod: 'POST', autoCertifyParam: 'sampleLineId' });
    await post.autoCertify(190240, 'EQ0022');
    const req = g2.seen.find((r) => r.path === '/lab/certify-line')!;
    assert.ok(req, 'the configured path was called');
    assert.equal(req.method, 'POST');
    assert.equal(String(JSON.parse(req.body).sampleLineId), '190240', `JSON body { sampleLineId: <line> } (got ${req.body})`);
    assert.match(String(req.headers['content-type']), /application\/json/);
    assert.equal(req.query.toString(), '', 'nothing in the query string on POST');
    await close(g2.server);
    console.log('✓ POST: JSON body { <param>: <line> } at the configured path');
  } catch (err) {
    fail(err);
  } finally {
    await close(g.server);
  }
}

// =============================================================================
// 8) im block, single hinai — exactly today's IM
// =============================================================================
console.log('\n— im block, single hinai');
{
  const S1 = 'LB2610110301';
  const S2 = 'LB2610110302';
  const hrow = (sampleId: string, code: string, labResultId: number) => ({
    SampleID: sampleId, eqIdntifier: code, equipmentCode: 'EQ0022', equipmentId: 46150218, labResultId,
    labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric',
    specimenName: 'Serum', FName: 'ASHA', LName: 'PATEL', Gender: 2, DOB: '03-12-1987', mrn: '10032026040311', siteId: 2,
  });
  const h = makeHinai([hrow(S1, 'TSH3', 93300001), hrow(S1, 'B12', 93300002), hrow(S2, 'HIVC', 93300003)]);
  const g = makeGenx([gtube(S1, [[1, 'THY']])], '/never');
  const im = makeIm();
  const [hp, gp, op, rp] = [await freePort(), await freePort(), await freePort(), await freePort()];
  await listen(h.server, hp);
  await listen(g.server, gp);
  await listen(im.server, op);
  const file = await writeConfig('single-hinai', {
    hmis: {
      // The top level says GenX; the im block's own setting must win.
      mode: 'single',
      use: 'genx',
      auditLog: join(dir, 'single-hinai', 'logs', 'hmis.log'),
      hinai: { baseUrl: `http://127.0.0.1:${hp}/portal`, siteIds: ['2'], resultsPath: '/mirth/labresult' },
      genx: {
        baseUrl: `http://127.0.0.1:${gp}`,
        clientId: 'cid',
        clientSecret: 'secret',
        auditLog: join(dir, 'single-hinai', 'logs', 'hmis-genx.log'),
        accessionCacheFile: join(dir, 'single-hinai', 'acc.json'),
        equipmentServices: { EQ0022: ['THY'] },
      },
    },
    im: {
      enabled: true,
      equipmentCode: 'EQ0022',
      equipmentId: 46150218,
      siteIds: ['2'],
      hmis: { mode: 'single', use: 'hinai' },
      orders: { host: '127.0.0.1', port: op },
      results: { host: '127.0.0.1', port: rp },
      autoCertify: { hinai: false, genx: false },
      analyzer: { orderPoll: { intervalMs: 5000, lookbackDays: 0 }, filing: { passIntervalMs: 5000 }, hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } } },
    },
  });
  const sender = resultSender(rp);
  let connector: Connector | null = null;
  try {
    connector = new Connector(loadConfig(file), quiet);
    await connector.start();
    await until('both tubes to reach IM', () => im.orders.length >= 2);
    await wait(500);
    assert.deepEqual(
      Object.fromEntries(im.orders.map((o) => [o.barcode, o.codes])),
      { [S1]: ['B12', 'TSH3'], [S2]: ['HIVC'] },
      'one ORM^O01 per tube from the HINAI rows',
    );
    assert.equal(h.posted.length + h.acked.length, 0, 'sending an order files and acknowledges nothing');
    console.log('✓ orders: HINAI pending rows pushed to IM, one order per tube');

    await sender.send(S1, { TSH3: '2.14', B12: '412' });
    await until('S1 filed in HINAI', () => h.posted.length >= 2);
    assert.deepEqual(Object.fromEntries(h.posted.map((r) => [r.identifier, [r.sampleId, r.resultValue, r.labResultId]])), {
      TSH3: [S1, '2.14', 93300001],
      B12: [S1, '412', 93300002],
    });
    await until('S1 acknowledged in HINAI', () => h.acked.length >= 2);
    assert.deepEqual(sorted(h.acked.map((r) => String(r.labResultId))), ['93300001', '93300002']);
    await until('S1 done in the store', () => Object.values(stored('single-hinai', S1)?.values ?? {}).every((v) => v.filedAt));
    const v = stored('single-hinai', S1)!.values.TSH3!;
    assert.ok(v.lanes?.hinai?.filedAt, 'single mode: lanes.hinai set alongside filedAt');
    assert.equal(v.lanes?.genx, undefined, 'and no genx lane');
    console.log('✓ results: filed in HINAI against the right labResultIds and acknowledged, as today');

    const st = connector.statuses()[0]! as unknown as { channels: unknown; lanes?: Array<{ lane: string }> };
    assert.ok(st.channels, 'the two channels are reported');
    assert.deepEqual((st.lanes ?? []).map((l) => l.lane), ['hinai'], 'status lanes: hinai only');
    await wait(5500);
    assert.equal(h.posted.length, 2, 'nothing re-posted by the next pass');
    assert.equal(g.seen.length, 0, `GenX never called (got ${g.seen.map((r) => r.path).join(', ')})`);
    console.log('✓ single hinai: GenX untouched, status lanes [hinai], nothing posted twice');
  } catch (err) {
    fail(err);
  } finally {
    sender.close();
    await connector?.stop().catch(() => {});
    await close(im.server);
    await close(h.server);
    await close(g.server);
  }
}

// =============================================================================
// 9) im block, single genx, genxAutoCertify with POST / path / param overrides
// =============================================================================
console.log('\n— im block, single genx, GenX auto-certify');
{
  const G1 = 'GX2610110401'; // line 300001 THY (TSH3, FT4), line 300002 VITB12 (B12)
  const H1 = 'GX2610110402'; // line 300003 VITB12 (B12) — certify fails once
  const CERTIFY = '/integration-service/external/v1/lab/equipment/certify-line';
  const g = makeGenx([gtube(G1, [[300001, 'THY'], [300002, 'VITB12']]), gtube(H1, [[300003, 'VITB12']])], CERTIFY);
  g.setParam('sampleLineId');
  g.certifyFailures.set('300003', [500]);
  const h = makeHinai([]);
  const im = makeIm();
  const [hp, gp, op, rp] = [await freePort(), await freePort(), await freePort(), await freePort()];
  await listen(h.server, hp);
  await listen(g.server, gp);
  await listen(im.server, op);
  const logs = join(dir, 'single-genx', 'logs');
  const file = await writeConfig('single-genx', {
    hmis: {
      mode: 'single',
      use: 'hinai',
      auditLog: join(logs, 'hmis.log'),
      hinai: { baseUrl: `http://127.0.0.1:${hp}/portal`, siteIds: ['2'] },
      genx: {
        baseUrl: `http://127.0.0.1:${gp}`,
        clientId: 'cid',
        clientSecret: 'secret',
        apiKey: 'k123',
        auditLog: join(logs, 'hmis-genx.log'),
        accessionCacheFile: join(dir, 'single-genx', 'acc.json'),
        serviceTests: { THY: ['TSH3', 'FT4'], VITB12: ['B12'] },
        equipmentServices: { EQ0022: ['THY', 'VITB12'] },
        autoCertifyPath: CERTIFY,
        autoCertifyMethod: 'POST',
        autoCertifyParam: 'sampleLineId',
      },
    },
    im: {
      enabled: true,
      equipmentCode: 'EQ0022',
      equipmentId: 46150218,
      hmis: { mode: 'single', use: 'genx' },
      orders: { host: '127.0.0.1', port: op },
      results: { host: '127.0.0.1', port: rp },
      autoCertify: { hinai: false, genx: true },
      analyzer: { orderPoll: { intervalMs: 5000, lookbackDays: 0 }, filing: { passIntervalMs: 5000 }, hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } } },
    },
  });
  const sender = resultSender(rp);
  const certified = (line: string) => g.certifyCalls.filter((c) => c.lineId === line && c.ok).length;
  const attempts = (line: string) => g.certifyCalls.filter((c) => c.lineId === line).length;
  let connector: Connector | null = null;
  try {
    connector = new Connector(loadConfig(file), quiet);
    await connector.start();

    await until('both GenX tubes to reach IM', () => im.orders.length >= 2);
    await wait(500);
    assert.deepEqual(Object.fromEntries(im.orders.map((o) => [o.barcode, o.codes])), { [G1]: ['B12', 'FT4', 'TSH3'], [H1]: ['B12'] });
    console.log('✓ orders: the GenX worklist pushed to IM');

    // Part of line 300001 and all of line 300002.
    await sender.send(G1, { TSH3: '2.14', B12: '412' });
    await until('G1 TSH3 + B12 posted to GenX', () => g.filed.filter((f) => f.accessionNumber === 'ACC' + G1).length >= 2);
    await until('line 300002 certified', () => certified('300002') === 1);
    await wait(1000);
    assert.equal(attempts('300001'), 0, 'line 300001 is only partly filed (FT4 missing): not certified');
    {
      const c = g.certifyCalls.find((x) => x.lineId === '300002')!;
      assert.equal(c.method, 'POST', 'autoCertifyMethod POST honoured');
      assert.match(String(c.headers.authorization), /^Bearer tok\d+$/);
      assert.equal(c.headers['x-api-key'], 'k123');
    }
    console.log('✓ certify: a line goes once every one of its codes is filed; a part-filed line waits');

    await sender.send(G1, { FT4: '1.10' });
    await until('line 300001 certified once FT4 is filed', () => certified('300001') === 1);
    await until('G1 records both certified lines', () => sorted((stored('single-genx', G1)?.certified?.genx ?? []).map(String)).join() === '300001,300002');
    console.log('✓ certify: the rest of the line filed => certified; certified ids kept on the staged sample');

    // Certify fails once, is retried on the next pass.
    await sender.send(H1, { B12: '300' });
    await until('H1 posted to GenX', () => g.filed.some((f) => f.accessionNumber === 'ACC' + H1));
    await until('the first certify of 300003 to fail', () => attempts('300003') >= 1);
    await until('300003 certified on a later pass', () => certified('300003') === 1, 15000);
    assert.equal(attempts('300003'), 2, 'one failure, one success');
    await until('H1 records the line', () => (stored('single-genx', H1)?.certified?.genx ?? []).map(String).includes('300003'));
    assert.ok(stored('single-genx', H1)!.values.B12!.filedAt, 'a failed certify never un-files anything');
    console.log('✓ certify failure: retried on the next pass, the value stays filed');

    // Never twice.
    const snapshot = JSON.stringify(g.certifyCalls.map((c) => c.lineId));
    const posts = g.filed.length;
    await wait(11000);
    assert.equal(JSON.stringify(g.certifyCalls.map((c) => c.lineId)), snapshot, 'no line certified twice over later passes');
    assert.equal(g.filed.length, posts, 'nothing re-posted');
    assert.equal(certified('300001') + certified('300002') + certified('300003'), 3);
    console.log('✓ two more passes: no certify repeated, nothing re-posted');

    // Auditing: GenX is the only lane in this process => hmis-<date>.log.
    const files = readdirSync(logs);
    const hmisLog = files.filter((f) => /^hmis-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f));
    const lines = hmisLog.flatMap((f) => readFileSync(join(logs, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; url: string }));
    assert.ok(lines.some((e) => e.kind === 'certify' && e.url.includes(CERTIFY)), 'certify calls audited as kind "certify" in hmis-<date>.log');
    assert.ok(!files.some((f) => f.startsWith('hmis-genx-')), 'no hmis-genx file: GenX is the only lane');
    assert.equal(h.seen.length, 0, 'HINAI is never called by a genx-only IM');
    console.log('✓ certify calls audited in hmis-<date>.log; HINAI untouched');
  } catch (err) {
    fail(err);
  } finally {
    sender.close();
    await connector?.stop().catch(() => {});
    await close(im.server);
    await close(h.server);
    await close(g.server);
  }
}

rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error('\nlanes-im: FAILED');
  process.exit(1);
}
console.log('\nlanes-im: all checks passed');
process.exit(0);
