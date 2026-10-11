import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';

// =============================================================================
// HMIS lanes — the `im` block in BOTH mode, end to end (scenarios 10 and 13).
//
//   10. orders: one ORM per tube with the union of both lanes
//       results: filed to HINAI and to GenX, acknowledged in each
//       GenX auto-certify (im.autoCertify.genx): every GenX line certified
//       once, at the default GET <autoCertifyPath>?labresultid=<line>; HINAI
//       never sees a certify call (its certification stays the Oracle job)
//       a tube only HINAI lists is held
//   13. the Auto Certify API: the IM card carries the HMIS mode, the lanes,
//       per-lane filed counts, the held count and the GenX certify counts —
//       and still no certify URL, no Oracle values, no GenX secret
//
// Run: npx tsx test/lanes-im-both.test.ts
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
/** Every value under a key matching `re`, anywhere in `o` — the API shape of
 *  the new per-lane / certify fields is not fixed by the spec, so the checks
 *  look for the facts rather than for one exact path. */
function deepFind(o: unknown, re: RegExp, path = '$'): Array<{ path: string; value: unknown }> {
  if (o === null || typeof o !== 'object') return [];
  const out: Array<{ path: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    if (re.test(k)) out.push({ path: p, value: v });
    out.push(...deepFind(v, re, p));
  }
  return out;
}
const countOf = (v: unknown) => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : NaN);

const dir = mkdtempSync(join(tmpdir(), 'lanes-im-both-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY', 'AUTOCERTIFY_ORACLE_PASSWORD']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';
const [hinaiPort, genxPort, orderPort, resultPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];

const K1 = 'LB2610110501'; // HINAI TSH3 FT4 B12 | GenX line 310001 THY (TSH3 FT4), line 310002 VITB12 (B12)
const K2 = 'LB2610110502'; // HINAI only: HIVC — held
const K3 = 'GX2610110503'; // GenX only: line 310003 HBA (A1C1)

// ---- stand-in HINAI ----------------------------------------------------------
const hrow = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: 'EQ0022', equipmentId: 46150218, labResultId,
  labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric',
  specimenName: 'Serum', FName: 'ASHA', LName: 'PATEL', Gender: 2, DOB: '03-12-1987', mrn: '10032026040311', siteId: 2,
});
const hinaiRows = [hrow(K1, 'TSH3', 93200001), hrow(K1, 'FT4', 93200002), hrow(K1, 'B12', 93200003), hrow(K2, 'HIVC', 93200004)];
const hinaiPosted: Array<{ sampleId: string; identifier: string; resultValue: string; labResultId: number }> = [];
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
      return res.end(JSON.stringify({ status: 'success', data: hinaiRows.filter((r) => (!sample || r.SampleID === sample) && (!eq || r.equipmentCode === eq)) }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/labresult') {
      const got = JSON.parse(body);
      hinaiPosted.push(...got);
      return res.end(JSON.stringify({ status: 'success', message: 'saved', successData: got }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/acknowledge') {
      const got = JSON.parse(body);
      hinaiAcked.push(...got);
      return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: got }));
    }
    hinaiOther.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));

// ---- stand-in GenX -----------------------------------------------------------
const CERTIFY = '/integration-service/external/v1/lab/equipment/autocertify';
const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const gtube = (barcode: string, tests: Array<[number, string]>) => ({
  accessionNumber: 'ACC' + barcode,
  sampleNumber: barcode,
  sampleId: barcode.slice(-4),
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid: '10032026040311', name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const genxTubes = [gtube(K1, [[310001, 'THY'], [310002, 'VITB12']]), gtube(K3, [[310003, 'HBA']])];
const genxFiled: Array<{ accessionNumber: string; code: string; value: string }> = [];
const genxAcked: string[] = [];
const certifyCalls: Array<{ method: string; lineId: string | null }> = [];
const genx = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth-service/api/oauth/token') {
      return res.end(JSON.stringify({ access_token: 'tok1', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      const barcode = url.searchParams.get('barcode');
      const content = barcode === null ? genxTubes : genxTubes.filter((t) => t.sampleNumber === barcode.toUpperCase());
      return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
      const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string; value: string }> };
      for (const r of sent.results) genxFiled.push({ accessionNumber: sent.accessionNumber, code: r.machineTestCode, value: r.value });
      return res.end(envelope({ filed: sent.results.length, unmatched: [] }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') {
      const sent = JSON.parse(body) as { acknowledgements: Array<{ accessionNumber: string }> };
      genxAcked.push(...sent.acknowledgements.map((a) => a.accessionNumber));
      return res.end(envelope({ acknowledgements: sent.acknowledgements.map((a) => ({ ...a, acknowledged: true })) }));
    }
    if (url.pathname === CERTIFY) {
      certifyCalls.push({ method: req.method!, lineId: url.searchParams.get('labresultid') });
      return res.end(envelope({ certified: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => genx.listen(genxPort, '127.0.0.1', () => r()));

// ---- stand-in IM -------------------------------------------------------------
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
let resultSock: net.Socket | null = null;
const resultAcks: string[] = [];
let seq = 0;
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
  const id = `R${String(++seq).padStart(4, '0')}`;
  const obx = Object.entries(values).map(([code, v], i) => `OBX|${i + 1}|NM|${code}^${code}||${v}|||N|||F`);
  const text = [`MSH|^~\\&|IM|LAB|HMIS-LIS||20261011120000||ORU^R01|${id}|P|2.3.1`, `OBR|1|${barcode}|${barcode}|X`, ...obx].join('\r') + '\r';
  const before = resultAcks.length;
  resultSock.write(wrapMllp(text, 'utf8'));
  await until(`IM's ${id} to be acknowledged`, () => resultAcks.length > before);
}

// ---- the connector -----------------------------------------------------------
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
        clientSecret: 'genx-secret-xyz',
        auditLog: join(dir, 'logs', 'hmis-genx.log'),
        accessionCacheFile: join(dir, 'genx-acc.json'),
        serviceTests: { THY: ['TSH3', 'FT4'], VITB12: ['B12'], HBA: ['A1C1'] },
        equipmentServices: { EQ0022: ['THY', 'VITB12', 'HBA'] },
      },
    },
    retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(dir, 'logs'), includeSpoolPending: true },
    admin: { host: '127.0.0.1', port: adminPort, authFile: join(dir, 'admin-auth.json') },
    // Disabled, but filled in: what must not reach the page is here to leak.
    autoCertify: {
      enabled: false,
      baseUrl: 'http://his-portal.secret.example:8050',
      siteId: '2',
      oracle: { user: 'HISUSER', password: 'hunter2', connectString: 'dbhost.secret.example:1521/HISPROD' },
      logFile: null,
    },
    im: {
      enabled: true,
      equipmentCode: 'EQ0022',
      equipmentId: 46150218,
      siteIds: ['2'],
      hmis: { mode: 'both' },
      orders: { host: '127.0.0.1', port: orderPort },
      results: { host: '127.0.0.1', port: resultPort },
      autoCertify: { hinai: false, genx: true },
      analyzer: { orderPoll: { intervalMs: 5000, lookbackDays: 0 }, filing: { passIntervalMs: 5000 }, hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } } },
    },
  }),
);
const stored = (barcode: string) => {
  const p = join(dir, 'spool', 'im', 'results', `${barcode}.json`);
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf8')) as {
        lastError: string | null;
        certified?: { genx?: number[] };
        values: Record<string, { filedAt: string | null; lanes?: Record<string, { filedAt: string | null; labResultId: number | null }> }>;
      })
    : null;
};
const certifiedLines = () => sorted(certifyCalls.map((c) => String(c.lineId)));

let failed = false;
let connector: Connector | null = null;
try {
  connector = new Connector(loadConfig(cfgFile), quiet);
  await connector.start();
  const base = `http://127.0.0.1:${adminPort}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'tester', password: 'Lanes@2026' }).toString(),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie.startsWith('lc_session='), `signed in to the console (HTTP ${login.status})`);
  const api = async () => (await (await fetch(`${base}/api/auto-certify`, { headers: { cookie } })).json()) as any;

  // ---- orders ----------------------------------------------------------------
  await until('three tubes to reach IM', () => orders.length >= 3);
  await wait(1000);
  assert.deepEqual(
    Object.fromEntries(orders.map((o) => [o.barcode, o.codes])),
    { [K1]: ['B12', 'FT4', 'TSH3'], [K2]: ['HIVC'], [K3]: ['A1C1'] },
    'one order per tube: K1 the union, K2 from HINAI, K3 from GenX',
  );
  assert.equal(orders.length, 3);
  console.log('✓ orders: one ORM per tube, the union of both lanes');

  // ---- results to both lanes, certify on the GenX lane only ------------------
  await sendResult(K1, { TSH3: '2.14', FT4: '1.10', B12: '412' });
  await until('K1 filed in HINAI', () => hinaiPosted.filter((r) => r.sampleId === K1).length >= 3);
  await until('K1 filed in GenX', () => genxFiled.filter((r) => r.accessionNumber === 'ACC' + K1).length >= 3);
  assert.deepEqual(
    Object.fromEntries(hinaiPosted.filter((r) => r.sampleId === K1).map((r) => [r.identifier, r.labResultId])),
    { TSH3: 93200001, FT4: 93200002, B12: 93200003 },
  );
  await until('K1 acknowledged in both lanes', () => hinaiAcked.filter((r) => r.sampleID === K1).length >= 3 && genxAcked.includes('ACC' + K1));
  await until('both GenX lines certified', () => certifiedLines().join() === '310001,310002');
  assert.ok(certifyCalls.every((c) => c.method === 'GET'), 'default method GET');
  await until('the lines recorded on the sample', () => sorted((stored(K1)?.certified?.genx ?? []).map(String)).join() === '310001,310002');
  console.log('✓ results: filed and acknowledged in both lanes; GenX lines 310001 and 310002 certified (GET ?labresultid=)');

  await sendResult(K2, { HIVC: 'Non Reactive' });
  await until('K2 to be held', () => /only in hinai/i.test(stored(K2)?.lastError ?? ''));
  assert.equal(hinaiPosted.filter((r) => r.sampleId === K2).length, 0, 'held: nothing posted to HINAI');
  console.log('✓ a tube only HINAI lists is held');

  await wait(6000); // a filing pass and a poll
  assert.equal(certifiedLines().join(), '310001,310002', 'no line certified twice');
  assert.deepEqual(hinaiOther, [], 'HINAI never received a certify (or any other) call');
  console.log('✓ certify happens on the GenX lane only, once per line');

  // ---- status ----------------------------------------------------------------
  {
    const st = connector.statuses().find((s) => s.id === 'im') as unknown as { lanes?: Array<{ lane: string; ok: boolean }> };
    assert.deepEqual(sorted((st.lanes ?? []).map((l) => l.lane)), ['genx', 'hinai'], 'status lanes: both');
    assert.ok((st.lanes ?? []).every((l) => l.ok));
    assert.ok(/"both"/.test(JSON.stringify(st)), 'the status names the mode "both"');
    console.log('✓ status: both lanes listed and ok, mode both');
  }

  // ---- 13) the Auto Certify API ---------------------------------------------
  {
    const data = await api();
    const ch = (data.channels ?? []).find((c: { id: string }) => c.id === 'im');
    assert.ok(ch, 'the IM card is in the API answer');
    const text = JSON.stringify(ch);
    assert.ok(/"both"/.test(text), `the IM card carries the HMIS mode (${text.slice(0, 400)})`);
    // Addendum A5: lane names in JSON are exactly "hinai" and "genx".
    assert.ok(/"hinai"/.test(text) && /"genx"/.test(text), 'and both lanes, named exactly "hinai" / "genx"');
    const laneNames = deepFind(ch, /^lane$/i).map((x) => x.value);
    assert.ok(laneNames.every((v) => v === 'hinai' || v === 'genx'), `every "lane" value is "hinai" or "genx" (${JSON.stringify(laneNames)})`);
    assert.ok(!/"(HINAI|GenX|GENX|Hinai)"/.test(text), 'no lane spelled as display text in the JSON');
    const certified = deepFind(ch, /certified/i).map((x) => ({ ...x, n: countOf(x.value) }));
    assert.ok(certified.some((x) => x.n === 2), `GenX certified count 2 (${JSON.stringify(certified)})`);
    // Either flat (genxCertifyFailed, lastCertifyError) or nested under a
    // certify-named object ({ certify: { genx: { failed, lastError } } }).
    const certTrees = deepFind(ch, /certif/i).map((x) => x.value).filter((v) => v && typeof v === 'object');
    const certFailed = [...deepFind(ch, /certif.*fail|fail.*certif/i), ...certTrees.flatMap((t) => deepFind(t, /fail/i))].map((x) => ({
      ...x,
      n: countOf(x.value),
    }));
    assert.ok(certFailed.some((x) => x.n === 0), `GenX certify failed count 0 (${JSON.stringify(certFailed)})`);
    const certError = [...deepFind(ch, /certif.*error|error.*certif/i), ...certTrees.flatMap((t) => deepFind(t, /error/i))];
    assert.ok(certError.length > 0, `a last certify error field is present (${text.slice(0, 600)})`);
    const held = deepFind(ch, /held/i).map((x) => ({ ...x, n: countOf(x.value) }));
    assert.ok(held.some((x) => x.n === 1), `held count 1 (${JSON.stringify(held)})`);
    const filed = deepFind(ch, /filed/i).map((x) => ({ ...x, n: countOf(x.value) }));
    assert.ok(filed.filter((x) => x.n === 3).length >= 2, `per-lane values filed: 3 in HINAI and 3 in GenX (${JSON.stringify(filed)})`);
    console.log('✓ Auto Certify API: mode, lanes, per-lane filed, held, GenX certified/failed counts present');

    const all = JSON.stringify(data);
    for (const secret of ['his-portal.secret.example', 'dbhost.secret.example', 'HISPROD', 'HISUSER', 'hunter2', 'genx-secret-xyz']) {
      assert.ok(!all.includes(secret), `"${secret}" is not sent to the browser`);
    }
    assert.equal(data.status.config.certifyUrl, undefined);
    assert.equal(data.status.config.oracle, undefined);
    console.log('✓ Auto Certify API: still no certify URL, no Oracle values, no GenX secret');

    const page = await (await fetch(`${base}/auto-certify`, { headers: { cookie } })).text();
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const src of scripts) new Function(src);
    assert.ok(!/Certify endpoint|connectString|certifyUrl/.test(page), 'the page does not name the certify URL or the database');
    console.log('✓ Auto Certify page: still one valid script, nothing secret named');
  }
} catch (err) {
  failed = true;
  console.error('✗ ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
} finally {
  (resultSock as net.Socket | null)?.destroy();
  await connector?.stop().catch(() => {});
  await new Promise<void>((r) => im.close(() => r()));
  await new Promise<void>((r) => hinai.close(() => r()));
  await new Promise<void>((r) => genx.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nlanes-im-both: FAILED');
  process.exit(1);
}
console.log('\nlanes-im-both: all checks passed');
process.exit(0);
