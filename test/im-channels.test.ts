import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { renderAutoCertify } from '../src/admin/auto-certify.js';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';

// =============================================================================
// IM, both channels, through the whole connector.
//
// Nothing is stubbed inside the connector here: it is started from a config
// file, against a stand-in HMIS (HTTP) and a stand-in IM (two TCP sockets),
// and asked about itself through the admin console's own API.
//
//   HMIS  ──pending rows──►  connector  ──ORM^O01──►  IM     ORDER channel
//   HMIS  ◄──result rows───  connector  ◄──ORU^R01──  IM     RESULT channel
//
// What is pinned:
//   1. orders HMIS lists are sent to IM on the order channel and acknowledged
//   2. IM's results, arriving on the OTHER channel, are joined to those orders
//      and filed in HMIS against the right labResultId — words included
//   3. the rows are acknowledged to HMIS only then
//   4. the console reports both channels: where, link state, counts, last tube
//   5. the Auto Certify page shows the two channels and does NOT show the
//      certify URL or the database, and the API does not send them
//
// Run: npx tsx test/im-channels.test.ts   (npm run im:channels)
// =============================================================================

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' } as any;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 15000): Promise<void> {
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

const dir = mkdtempSync(join(tmpdir(), 'im-channels-'));
const [hmisPort, orderPort, resultPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort()];

// ---- stand-in HMIS ---------------------------------------------------------
const row = (sampleId: string, code: string, labResultId: number, specimen = 'Serum') => ({
  SampleID: sampleId,
  eqIdntifier: code,
  equipmentCode: 'EQ0022',
  equipmentId: 46150218,
  labResultId,
  labServiceId: 7000 + (labResultId % 100),
  parameterId: labResultId % 1000,
  resultType: 'Numeric',
  ipAddress: '10.11.111.129',
  portNo: '10011',
  specimenName: specimen,
  FName: 'ASHA',
  LName: 'PATEL',
  Gender: 2,
  DOB: '03-12-1987',
  mrn: '10032026040311',
  siteId: 2,
});
const pendingRows = [
  row('LB2609270123', 'TSH3', 93000001),
  row('LB2609270123', 'B12', 93000002),
  row('LB2609270124', 'HIVC', 93000003),
  row('HE2609270249', 'A1C1', 93000004, 'EDTA'),
];
const posted: Array<Record<string, unknown>> = [];
const acked: Array<Record<string, unknown>> = [];
const hmis = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
      const sample = (url.searchParams.get('sampleId') ?? '').toUpperCase();
      const eq = url.searchParams.get('eqCode');
      const rows = pendingRows.filter((r) => (!sample || r.SampleID === sample) && (!eq || r.equipmentCode === eq));
      return res.end(JSON.stringify({ status: 'success', data: rows }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/labresult') {
      const rows = JSON.parse(body) as Array<Record<string, unknown>>;
      posted.push(...rows);
      return res.end(JSON.stringify({ status: 'success', message: 'saved', successData: rows }));
    }
    if (req.method === 'POST' && url.pathname === '/portal/mirth/acknowledge') {
      const rows = JSON.parse(body) as Array<Record<string, unknown>>;
      acked.push(...rows);
      return res.end(JSON.stringify({ status: 'success', message: 'ok', successData: rows }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => hmis.listen(hmisPort, '127.0.0.1', () => r()));

// ---- stand-in IM: the order listener ---------------------------------------
const orders: string[] = [];
const im = net.createServer((sock) => {
  const dec = new MllpDecoder('utf8');
  sock.on('data', (chunk) => {
    for (const text of dec.push(chunk)) {
      orders.push(text);
      const id = parseHl7(text).controlId;
      sock.write(wrapMllp(`MSH|^~\\&|IM||HMIS-LIS||20260927200000||ACK|A${id}|P|2.3.1\rMSA|AA|${id}\r`, 'utf8'));
    }
  });
  sock.on('error', () => {});
});
await new Promise<void>((r) => im.listen(orderPort, '127.0.0.1', () => r()));

// ---- the connector, from a config file -------------------------------------
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Channel@2026';
delete process.env.HMIS_BASE_URL;
const cfgFile = join(dir, 'config.json');
writeFileSync(
  cfgFile,
  JSON.stringify({
    logLevel: 'error',
    spoolDir: join(dir, 'spool'),
    hmis: {
      baseUrl: `http://127.0.0.1:${hmisPort}/portal`,
      siteIds: ['2'],
      resultsPath: '/mirth/labresult',
      auditLog: null,
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
    analyzers: [
      {
        id: 'im',
        profile: 'im',
        equipmentCode: 'EQ0022',
        equipmentId: 46150218,
        transport: { host: '127.0.0.1', port: orderPort },
        resultTransport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: resultPort },
        filing: { mode: 'staged', passIntervalMs: 5000 },
        hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } },
      },
    ],
  }),
);
const cfg = loadConfig(cfgFile);
assert.deepEqual(cfg.analyzers[0]!.resultTransport, { type: 'tcp', mode: 'server', host: '127.0.0.1', port: resultPort });
assert.deepEqual(cfg.analyzers[0]!.hl7.valueTypes, [], 'the profile accepts every OBX value type');

// The profile on its own gives the result channel its default port.
writeFileSync(
  join(dir, 'bare.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://127.0.0.1:1/x', auditLog: null },
    analyzers: [{ id: 'im', profile: 'im', equipmentCode: 'EQ0022', transport: { host: '10.11.4.231' } }],
  }),
);
const bare = loadConfig(join(dir, 'bare.json')).analyzers[0]!;
assert.deepEqual(bare.transport, { type: 'tcp', mode: 'client', host: '10.11.4.231', port: 10011 });
assert.deepEqual(bare.resultTransport, { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 10012 });
console.log('✓ profile "im": orders dialled out on 10011, results listened for on 10012');

const connector = new Connector(cfg, quiet);
await connector.start();

// ---- the console, signed in ------------------------------------------------
const base = `http://127.0.0.1:${adminPort}`;
const login = await fetch(`${base}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
  body: new URLSearchParams({ username: 'tester', password: 'Channel@2026' }).toString(),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
assert.ok(cookie.startsWith('lc_session='), `signed in to the console (HTTP ${login.status})`);
const api = async () => (await (await fetch(`${base}/api/auto-certify`, { headers: { cookie } })).json()) as any;

try {
  // ---- 1) before anything has moved ----------------------------------------
  {
    await until('the order channel to connect', () => connector.statuses()[0]!.channels?.orders?.link === 'connected');
    const ch = (await api()).channels;
    assert.equal(ch.length, 1);
    assert.equal(ch[0].id, 'im');
    assert.equal(ch[0].equipmentCode, 'EQ0022');
    assert.equal(ch[0].orders.endpoint, `tcp://127.0.0.1:${orderPort} (client)`);
    assert.equal(ch[0].orders.link, 'connected');
    assert.equal(ch[0].orders.sending, true);
    assert.equal(ch[0].orders.messageType, 'ORM^O01');
    assert.equal(ch[0].results.endpoint, `tcp://127.0.0.1:${resultPort} (server)`);
    assert.equal(ch[0].results.link, 'listening', 'IM has not dialled in yet');
    assert.equal(ch[0].results.messages, 0);
    console.log('✓ the console reports both channels: order link connected, result link listening');
  }

  // ---- 2) orders out --------------------------------------------------------
  await until('three tubes to reach IM', () => orders.length >= 3);
  {
    const sent = orders.map((t) => parseHl7(t));
    const barcodes = sent.map((m) => m.segments.find((s) => s.name === 'OBR')!.fields[2]);
    assert.deepEqual([...barcodes].sort(), ['HE2609270249', 'LB2609270123', 'LB2609270124']);
    const first = sent[barcodes.indexOf('LB2609270123')]!;
    assert.deepEqual(first.segments.filter((s) => s.name === 'OBR').map((s) => s.fields[4]), ['TSH3', 'B12']);
    assert.equal(first.messageType, 'ORM^O01');
    assert.equal(posted.length, 0, 'nothing is filed by sending an order');
    assert.equal(acked.length, 0, 'and nothing is acknowledged to HMIS');
    await until('the counters to catch up', () => connector.statuses()[0]!.channels!.orders!.sent === 3);
    const o = (await api()).channels[0].orders;
    assert.deepEqual([o.sent, o.refused, o.failed], [3, 0, 0]);
    assert.ok(o.lastSentAt && o.lastSentBarcode, 'the last tube sent is named');
    console.log('✓ order channel: three tubes sent to IM and acknowledged, nothing acknowledged to HMIS');
  }

  // ---- 3) results back, on the other channel --------------------------------
  {
    const sock = net.connect({ host: '127.0.0.1', port: resultPort });
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const dec = new MllpDecoder('utf8');
    const acks: string[] = [];
    sock.on('data', (c) => acks.push(...dec.push(c)));
    await until('the result link to show connected', () => connector.statuses()[0]!.channels!.results!.link === 'connected');

    sock.write(
      wrapMllp(
        [
          'MSH|^~\\&|IM|LAB|HMIS-LIS||20260927203000||ORU^R01|R0001|P|2.3.1',
          'PID|1||10032026040311||PATEL^ASHA',
          'OBR|1|LB2609270123|LB2609270123|TSH3|||20260927202900',
          'OBX|1|NM|TSH3^TSH3||2.14|uIU/mL|0.4-4.0|N|||F',
          'OBX|2|NM|B12^B12||412|pg/mL|200-900|N|||F',
        ].join('\r') + '\r',
        'utf8',
      ),
    );
    sock.write(
      wrapMllp(
        [
          'MSH|^~\\&|IM|LAB|HMIS-LIS||20260927203100||ORU^R01|R0002|P|2.3.1',
          'OBR|1|LB2609270124|LB2609270124|HIVC',
          'OBX|1|ST|HIVC^HIVC||Non Reactive||||||F',
        ].join('\r') + '\r',
        'utf8',
      ),
    );

    await until('both results to be acknowledged to IM', () => acks.length >= 2);
    assert.deepEqual(acks.map((a) => parseHl7(a).segments.find((s) => s.name === 'MSA')!.fields.slice(1, 3)), [
      ['AA', 'R0001'],
      ['AA', 'R0002'],
    ]);
    await until('three values to be filed in HMIS', () => posted.length >= 3);
    const filed = Object.fromEntries(posted.map((r) => [`${r.sampleId}/${r.identifier}`, [r.resultValue, r.labResultId]]));
    assert.deepEqual(filed, {
      'LB2609270123/TSH3': ['2.14', 93000001],
      'LB2609270123/B12': ['412', 93000002],
      'LB2609270124/HIVC': ['Non Reactive', 93000003],
    });
    await until('those rows to be acknowledged to HMIS', () => acked.length >= 3);
    assert.deepEqual(acked.map((r) => r.labResultId).sort(), [93000001, 93000002, 93000003]);
    assert.ok(!acked.some((r) => r.labResultId === 93000004), 'the tube with no result yet stays pending');
    console.log('✓ result channel: values joined to the orders that went out, filed and acknowledged — a word value too');

    const r = (await api()).channels[0].results;
    assert.deepEqual([r.link, r.messages, r.values, r.lastReceivedBarcode], ['connected', 2, 3, 'LB2609270124']);
    console.log('✓ the console counts what came in: 2 messages, 3 values, last tube named');

    // Nothing but acknowledgements ever goes out on the result channel.
    assert.ok(acks.every((a) => parseHl7(a).messageType.startsWith('ACK')));
    sock.destroy();
    await until('the result link to go back to listening', () => connector.statuses()[0]!.channels!.results!.link === 'listening');
    console.log('✓ IM hanging up leaves the result channel listening for it');
  }

  // ---- 4) what the page shows, and what it does not --------------------------
  {
    const data = await api();
    const text = JSON.stringify(data);
    for (const secret of ['his-portal.secret.example', 'dbhost.secret.example', 'HISPROD', 'HISUSER', 'hunter2']) {
      assert.ok(!text.includes(secret), `"${secret}" is not sent to the browser`);
    }
    assert.equal(data.status.config.certifyUrl, undefined);
    assert.equal(data.status.config.oracle, undefined);
    assert.equal(data.status.config.siteId, '2', 'the settings that are shown still arrive');
    assert.equal(data.status.enabled, false);
    console.log('✓ API: no certify URL, no database user, host or service name leaves the connector');

    const page = await (await fetch(`${base}/auto-certify`, { headers: { cookie } })).text();
    assert.equal(page, renderAutoCertify({ username: 'tester' }));
    assert.ok(page.includes('Order channel') && page.includes('Result channel'), 'both channels are on the page');
    assert.ok(page.includes('id="channels"'));
    for (const gone of ['Certify endpoint', "kv('Oracle'", 'connectString', 'certifyUrl', 'passwordSet']) {
      assert.ok(!page.includes(gone), `the page no longer mentions ${gone}`);
    }
    // The page script must still be one valid program.
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const src of scripts) new Function(src);
    console.log('✓ page: shows the order and result channels, shows neither the URL nor the database');

    // Which half of the page shows. The page's own script is run against a
    // stub DOM with each answer the API can give.
    const show = async (enabled: boolean, channels: unknown[]) => {
      const els: Record<string, any> = {};
      const el = (id: string) =>
        (els[id] ??= { innerHTML: '', textContent: '', style: { display: id === 'imArea' ? 'none' : '' }, dataset: {}, classList: { toggle() {} } });
      const payload = { status: { ...data.status, enabled }, history: [], channels };
      const ctx: any = {
        document: { getElementById: el, querySelectorAll: () => [] },
        location: { href: '' },
        fetch: async () => ({ status: 200, ok: true, json: async () => payload }),
        setInterval: () => 0,
        console,
      };
      vm.createContext(ctx);
      vm.runInContext(scripts[0]!, ctx);
      await wait(30);
      return { im: els.imArea.style.display !== 'none', certify: els.certifyArea.style.display !== 'none', alert: els.alert.innerHTML as string };
    };
    const im = data.channels;
    const offWithIm = await show(false, im);
    assert.deepEqual([offWithIm.im, offWithIm.certify], [true, false], 'job off + IM: only the IM cards');
    assert.ok(!/enabled/.test(offWithIm.alert), 'and no invitation to switch the certify job on');
    const onWithIm = await show(true, im);
    assert.deepEqual([onWithIm.im, onWithIm.certify], [true, true], 'job on + IM: both');
    const onNoIm = await show(true, []);
    assert.deepEqual([onNoIm.im, onNoIm.certify], [false, true], 'job on, no IM: no empty IM cards');
    console.log('✓ page: IM cards only where IM is configured; certify section hidden when the job is off and IM is there');
  }

  // ---- 5) a machine with one connection reports no channels -----------------
  {
    writeFileSync(
      join(dir, 'single.json'),
      JSON.stringify({
        hmis: { baseUrl: 'http://127.0.0.1:1/x', auditLog: null },
        spoolDir: join(dir, 'spool-single'),
        retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(dir, 'logs'), includeSpoolPending: true },
        admin: { host: '127.0.0.1', port: await freePort(), authFile: join(dir, 'admin-auth-2.json') },
        analyzers: [{ id: 'plain', equipmentCode: 'MGAPI1000', protocol: 'astm', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() } }],
      }),
    );
    const single = new Connector(loadConfig(join(dir, 'single.json')), quiet);
    assert.equal(single.statuses()[0]!.channels, null);
    console.log('✓ every other machine is unchanged: no channels reported');
  }
} finally {
  await connector.stop();
  await new Promise<void>((r) => im.close(() => r()));
  await new Promise<void>((r) => hmis.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nIM channels: all checks passed');
process.exit(0);
