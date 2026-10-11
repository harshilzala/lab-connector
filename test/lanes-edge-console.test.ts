import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { renderAutoCertify } from '../src/admin/auto-certify.js';
import { renderDashboard } from '../src/admin/dashboard.js';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';

// =============================================================================
// HMIS lanes, round 2 — the admin console in both mode (cases 4, 12, 13).
//
// A real Connector (im block, both mode, GenX auto-certify on, Force enabled)
// against stand-in HINAI / GenX / IM, driven through the console's own API:
//
//   4.  B2 through the real "File now" endpoint: a code with a row in HINAI
//       only files to HINAI and waits for GenX; File now closes it with GenX
//       skipped by the operator
//   13. Force in both mode: one report entry per lane, wrong password refused,
//       nothing re-posted by later passes; the dashboard page script (cards,
//       Results tab) and the Auto Certify page script run in node:vm against
//       the live both-mode API without falling into their error branch
//   12. im.enabled false: no IM analyzer in a running connector
//
// Run: npx tsx test/lanes-edge-console.test.ts
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

const dir = mkdtempSync(join(tmpdir(), 'lanes-edge-console-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';
const [hinaiPort, genxPort, orderPort, resultPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];

const T4 = 'LB2610110601'; // HINAI TSH3 + B12 | GenX line 400002 VITB12 (B12) — TSH3 has no GenX row
const F13 = 'LB2610110602'; // both lanes, TSH3 — Force
const H14 = 'LB2610110603'; // HINAI only — held
const M13 = 'LB2610110604'; // both lanes, but HINAI says MRN-A and GenX says UH-B (C2)

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

// ---- stand-ins ------------------------------------------------------------------
const hrow = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: 'EQ0022', equipmentId: 46150218, labResultId,
  labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric', specimenName: 'Serum', siteId: 2,
});
const hinaiRows: Array<Record<string, unknown>> = [
  hrow(T4, 'TSH3', 93400001),
  hrow(T4, 'B12', 93400002),
  hrow(F13, 'TSH3', 93400011),
  hrow(H14, 'TSH3', 93400021),
  { ...hrow(M13, 'TSH3', 93400031), mrn: 'MRN-A' },
];
const hinaiPosted: Array<{ sampleId: string; identifier: string; resultValue: string; labResultId: number }> = [];
const hinai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
      const sample = (url.searchParams.get('sampleId') ?? '').toUpperCase();
      return res.end(JSON.stringify({ status: 'success', data: hinaiRows.filter((r) => !sample || r.SampleID === sample) }));
    }
    if (req.method === 'POST' && (url.pathname === '/portal/mirth/labresult' || url.pathname === '/portal/mirth/acknowledge')) {
      const got = JSON.parse(body);
      if (url.pathname.endsWith('labresult')) hinaiPosted.push(...got);
      return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: got }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));

const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const gtube = (barcode: string, tests: Array<[number, string]>, uhid = 'UH1') => ({
  accessionNumber: 'ACC' + barcode,
  sampleNumber: barcode,
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid, name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const genxTubes = [gtube(T4, [[400002, 'VITB12']]), gtube(F13, [[400011, 'TSHONLY']]), gtube(M13, [[400031, 'TSHONLY']], 'UH-B')];
const genxFiled: Array<{ accessionNumber: string; code: string; value: string }> = [];
const certified: string[] = [];
const genx = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth-service/api/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      const b = url.searchParams.get('barcode');
      const content = b === null ? genxTubes : genxTubes.filter((t) => t.sampleNumber === b.toUpperCase());
      return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
      const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string; value: string }> };
      for (const r of sent.results) genxFiled.push({ accessionNumber: sent.accessionNumber, code: r.machineTestCode, value: r.value });
      return res.end(envelope({ filed: sent.results.length, unmatched: [] }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') return res.end(envelope({ acknowledgements: [] }));
    if (url.pathname === '/integration-service/external/v1/lab/equipment/autocertify') {
      certified.push(url.searchParams.get('labresultid') ?? '');
      return res.end(envelope({ certified: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => genx.listen(genxPort, '127.0.0.1', () => r()));

const orders: string[] = [];
const im = net.createServer((sock) => {
  const dec = new MllpDecoder('utf8');
  sock.on('data', (chunk) => {
    for (const text of dec.push(chunk)) {
      const msg = parseHl7(text);
      orders.push(msg.segments.find((s) => s.name === 'OBR')?.fields[2] ?? '');
      sock.write(wrapMllp(`MSH|^~\\&|IM||HMIS-LIS||20261011120000||ACK|A${msg.controlId}|P|2.3.1\rMSA|AA|${msg.controlId}\r`, 'utf8'));
    }
  });
  sock.on('error', () => {});
});
await new Promise<void>((r) => im.listen(orderPort, '127.0.0.1', () => r()));
let resultSock: net.Socket | null = null;
const acks: string[] = [];
let seq = 0;
async function sendResult(barcode: string, values: Record<string, string>) {
  if (!resultSock) {
    resultSock = net.connect({ host: '127.0.0.1', port: resultPort });
    await new Promise<void>((r, j) => {
      resultSock!.once('connect', () => r());
      resultSock!.once('error', j);
    });
    const dec = new MllpDecoder('utf8');
    resultSock.on('data', (c) => acks.push(...dec.push(c)));
    resultSock.on('error', () => {});
  }
  const id = `R${++seq}`;
  const obx = Object.entries(values).map(([c, v], i) => `OBX|${i + 1}|NM|${c}^${c}||${v}|||N|||F`);
  const before = acks.length;
  resultSock.write(wrapMllp([`MSH|^~\\&|IM|LAB|HMIS-LIS||20261011120000||ORU^R01|${id}|P|2.3.1`, `OBR|1|${barcode}|${barcode}|X`, ...obx].join('\r') + '\r', 'utf8'));
  await until(`ACK for ${id}`, () => acks.length > before);
}

// ---- connector ------------------------------------------------------------------------
const cfgFile = join(dir, 'config.json');
writeFileSync(
  cfgFile,
  JSON.stringify({
    logLevel: 'error',
    spoolDir: join(dir, 'spool'),
    Force_Hmis: { password: 'force-me' },
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
        accessionCacheFile: join(dir, 'acc.json'),
        serviceTests: { VITB12: ['B12'], TSHONLY: ['TSH3'] },
        equipmentServices: { EQ0022: ['VITB12', 'TSHONLY'] },
      },
    },
    retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(dir, 'logs'), includeSpoolPending: true },
    admin: { host: '127.0.0.1', port: adminPort, authFile: join(dir, 'admin-auth.json') },
    autoCertify: { enabled: false, logFile: null },
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
type Stored = { lastError: string | null; values: Record<string, { filedAt: string | null; lanes?: Record<string, { filedAt: string | null; skipped?: string }> }> };
const stored = (b: string): Stored | null => {
  const p = join(dir, 'spool', 'im', 'results', `${b}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Stored) : null;
};
const hinaiFor = (b: string) => hinaiPosted.filter((r) => r.sampleId === b);
const genxFor = (b: string) => genxFiled.filter((r) => r.accessionNumber === 'ACC' + b);

/** A DOM element as far as the two page scripts use one. */
const element = (id: string) => {
  const classes = new Set<string>();
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: { display: '' } as Record<string, string>,
    dataset: {} as Record<string, string>,
    classList: {
      toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [] as unknown[],
    scrollTop: 0,
    scrollHeight: 0,
  };
};

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
  assert.ok(cookie.startsWith('lc_session='), 'signed in');
  const post = (path: string, body?: unknown) =>
    fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  await until('the first poll to send the tubes to IM', () => new Set(orders).size >= 4);

  // ---- 4) B2 through the console's File now ----------------------------------
  await check('B2 via the admin API: TSH3 (HINAI row only) files to HINAI, waits for GenX; File now closes it', async () => {
    await sendResult(T4, { TSH3: '2.0', B12: '300' });
    await until('T4 B12 in GenX', () => genxFor(T4).length >= 1);
    await until('T4 in HINAI', () => hinaiFor(T4).length >= 2);
    await until('B12 line certified', () => certified.includes('400002'));
    await wait(500);
    assert.deepEqual(genxFor(T4).map((r) => r.code), ['B12'], 'GenX has no TSH3 row: only B12 went there');
    assert.ok(!stored(T4)!.values.TSH3!.filedAt, 'TSH3 waits for GenX');
    const res = await post(`/api/analyzers/im/staged/${T4}/file`);
    assert.equal(res.status, 200, await res.text());
    const after = stored(T4)!;
    assert.equal(after.values.TSH3!.lanes?.genx?.skipped, 'operator', `TSH3 skipped in GenX (got ${JSON.stringify(after.values.TSH3!.lanes)})`);
    assert.ok(Object.values(after.values).every((v) => v.filedAt), 'sample complete');
    assert.equal(hinaiFor(T4).length, 2, 'nothing re-posted to HINAI');
    assert.equal(genxFor(T4).length, 1, 'nothing posted to GenX');
  });

  // ---- 13) Force in both mode ------------------------------------------------------
  await check('Force in both mode: wrong password refused; one report entry per lane; later passes post nothing', async () => {
    await sendResult(F13, { TSH3: '4.4' });
    await until('F13 filed in both lanes', () => hinaiFor(F13).length >= 1 && genxFor(F13).length >= 1);
    const denied = await post(`/api/analyzers/im/staged/${F13}/force`, { password: 'nope' });
    assert.equal(denied.status, 403);
    const res = await post(`/api/analyzers/im/staged/${F13}/force`, { password: 'force-me' });
    const report = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(report));
    const text = JSON.stringify(report);
    assert.ok(/"hinai"/.test(text) && /"genx"/.test(text), `the report names both lanes (${text.slice(0, 400)})`);
    assert.equal(hinaiFor(F13).length, 2, 'Force re-sent TSH3 to HINAI once');
    assert.equal(genxFor(F13).length, 2, 'and to GenX once');
    const h = hinaiFor(F13).length;
    const g = genxFor(F13).length;
    await wait(6000);
    assert.equal(hinaiFor(F13).length, h, 'no pass re-posts after a Force');
    assert.equal(genxFor(F13).length, g);
  });

  await check('Force on a sample held (tube only in HINAI) sends nothing to GenX', async () => {
    await sendResult(H14, { TSH3: '9.9' });
    await until('H14 held', () => /only in HINAI/.test(stored(H14)?.lastError ?? ''));
    const res = await post(`/api/analyzers/im/staged/${H14}/force`, { password: 'force-me' });
    assert.equal(res.status, 200, await res.text());
    assert.equal(genxFor(H14).length, 0, 'GenX has no row for it: nothing sent');
  });

  // ---- C2) patient mismatch through the console ----------------------------------
  await check('C2 via the admin API: patient ids differ => order still sent, held, File now and Force refused; files once they agree', async () => {
    assert.ok(orders.includes(M13), 'the machine order (union) still went to IM');
    await sendResult(M13, { TSH3: '6.6' });
    await until('M13 held for the mismatch', () => /patient differs/.test(stored(M13)?.lastError ?? ''));
    assert.match(stored(M13)!.lastError!, /patient differs between HINAI \(MRN-A\) and GenX \(UH-B\) for this barcode/);
    const file = await post(`/api/analyzers/im/staged/${M13}/file`);
    const fileText = await file.text();
    assert.match(fileText, /patient differs/, `File now refuses with the mismatch message (HTTP ${file.status}: ${fileText})`);
    const force = await post(`/api/analyzers/im/staged/${M13}/force`, { password: 'force-me' });
    const forceText = await force.text();
    assert.match(forceText, /patient differs/, `Force refuses with the mismatch message (HTTP ${force.status}: ${forceText})`);
    const summary = (await (await fetch(`${base}/api/analyzers/im/staged`, { headers: { cookie } })).json()) as {
      samples: Array<{ barcode: string; held?: { mismatch?: unknown } }>;
    };
    assert.deepEqual(summary.samples.find((s) => s.barcode === M13)?.held?.mismatch, { hinai: 'MRN-A', genx: 'UH-B' });
    await wait(1000);
    assert.equal(hinaiFor(M13).length + genxFor(M13).length, 0, 'nothing posted anywhere');
    // GenX is corrected; the next poll and pass file it.
    genxTubes[2]!.patient.uhid = 'MRN-A';
    await until('M13 filed in both lanes once the ids agree', () => hinaiFor(M13).length >= 1 && genxFor(M13).length >= 1, 15000);
  });

  // ---- 13) the page scripts against the live both-mode API ----------------------
  await check('dashboard script: cards say "HINAI + GenX (both)", Results tab shows lane counts and the hold', async () => {
    const html = renderDashboard({ username: 'tester' } as never);
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    const nodes: Record<string, ReturnType<typeof element>> = {};
    const sandbox = {
      document: { getElementById: (id: string) => (nodes[id] ??= element(id)), querySelectorAll: () => [], addEventListener() {} },
      window: { scrollTo() {}, scrollY: 0 },
      fetch: (url: string, opts: RequestInit = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers as object), cookie } }),
      setInterval: () => 0,
      setTimeout: (f: () => void) => setTimeout(f, 0),
      location: { href: '', hash: '', pathname: '/' },
      console,
    };
    const ctx = vm.runInNewContext(script + '\n;({ renderCards, renderStaged, refresh });', sandbox) as {
      refresh(): Promise<void>;
      renderStaged(id: string, el: unknown): Promise<void>;
    };
    await ctx.refresh();
    assert.ok(!/Lost contact/.test(nodes.alert?.innerHTML ?? ''), `refresh ran without an error: ${nodes.alert?.innerHTML}`);
    assert.ok(nodes.cards!.innerHTML.includes('HINAI + GenX (both)'), 'the card names both lanes');
    const el = element('staged');
    await ctx.renderStaged('im', el);
    assert.ok(el.innerHTML.includes('held: only in HINAI'), 'the Results tab shows the hold');
    assert.ok(/HINAI \d+\/\d+/.test(el.innerHTML) && /GenX \d+\/\d+/.test(el.innerHTML), 'and per-lane counts');
  });

  await check('Auto Certify page script: IM card shows the lanes and the GenX certify count, no error branch', async () => {
    const page = renderAutoCertify({ username: 'tester' });
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const nodes: Record<string, ReturnType<typeof element>> = {};
    const sandbox = {
      document: { getElementById: (id: string) => (nodes[id] ??= element(id)), querySelectorAll: () => [] },
      location: { href: '' },
      fetch: (url: string, opts: RequestInit = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers as object), cookie } }),
      setInterval: () => 0,
      console,
    };
    const ctx = vm.runInNewContext(scripts[0]! + '\n;({ refresh });', sandbox) as { refresh(): Promise<void> };
    await ctx.refresh();
    assert.ok(!/Lost contact/.test(nodes.alert?.innerHTML ?? ''), `refresh ran without an error: ${nodes.alert?.innerHTML}`);
    const ch = nodes.channels!.innerHTML;
    assert.ok(ch.includes('HINAI + GenX (both)'), 'the IM card names both lanes');
    assert.ok(ch.includes('GenX lines auto-certified'), 'and the certify count');
    assert.ok(!/secret|hunter2/.test(ch));
  });

  // ---- 12) im.enabled false --------------------------------------------------------
  await check('im.enabled false: a running connector has no IM analyzer', async () => {
    const raw = JSON.parse(readFileSync(cfgFile, 'utf8'));
    raw.im.enabled = false;
    raw.admin.port = await freePort();
    raw.admin.authFile = join(dir, 'admin-auth-2.json');
    raw.spoolDir = join(dir, 'spool-2');
    raw.analyzers = [{ id: 'plain', equipmentCode: 'EQP', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() } }];
    const f = join(dir, 'off.json');
    writeFileSync(f, JSON.stringify(raw));
    const c = new Connector(loadConfig(f), quiet);
    assert.deepEqual(c.statuses().map((s) => s.id), ['plain']);
  });
} catch (err) {
  failures++;
  console.error('✗ ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
} finally {
  (resultSock as net.Socket | null)?.destroy();
  await connector?.stop().catch(() => {});
  await new Promise<void>((r) => im.close(() => r()));
  await new Promise<void>((r) => hinai.close(() => r()));
  await new Promise<void>((r) => genx.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nlanes-edge-console: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nlanes-edge-console: all checks passed');
process.exit(0);
