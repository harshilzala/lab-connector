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
// HMIS lanes — results in both mode (spec 4, scenarios 4, 5, 6, 7).
//
// A real Connector from a config file: the `im` block in both mode, a
// stand-in HINAI (/mirth/*), a stand-in GenX (token, worklist, results,
// acknowledge) and a stand-in IM on both channels.
//
//   4. a tube in both lanes files to BOTH, each lane with its own labResultId,
//      each acknowledged in its own lane; nothing is posted twice across passes
//   5. a tube in one lane only is HELD (nothing posted anywhere) and files to
//      both the moment the other lane lists it; "File now" on a held tube
//      posts to the lane that has it and marks the other lane skipped; a tube
//      in neither lane is held
//   6. GenX answers 503: HINAI files, GenX is retried on the next pass, HINAI
//      is not re-posted
//   7. a rerun after the tube filed in both lanes re-files to both
//
// GenX auto-certify is OFF here (genxAutoCertify false): no certify call may
// be made at all.
//
// Run: npx tsx test/lanes-filing.test.ts
// =============================================================================

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

const dir = mkdtempSync(join(tmpdir(), 'lanes-filing-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';
const [hinaiPort, genxPort, orderPort, resultPort, adminPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];

const A = 'LB2610110201'; // both lanes: HINAI TSH3 FT4 B12 | GenX THY(TSH3 FT4) line 191001, VITB12(B12) line 191002
const B = 'LB2610110202'; // HINAI only at first; GenX lists it later (VITB12 line 191021)
const D = 'LB2610110204'; // both lanes: HINAI B12 | GenX VITB12 line 191011 — GenX results answer 503 at first
const E = 'GX2610110205'; // GenX only: VITB12 line 191031 — "File now"
const F = 'LB2610110206'; // neither lane

// ---- stand-in HINAI ----------------------------------------------------------
const hrow = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId, eqIdntifier: code, equipmentCode: 'EQ0022', equipmentId: 46150218, labResultId,
  labServiceId: 7000 + (labResultId % 100), parameterId: labResultId % 1000, resultType: 'Numeric',
  specimenName: 'Serum', FName: 'ASHA', LName: 'PATEL', Gender: 2, DOB: '03-12-1987', mrn: '10032026040311', siteId: 2,
});
const hinaiRows = [
  hrow(A, 'TSH3', 93100001),
  hrow(A, 'FT4', 93100002),
  hrow(A, 'B12', 93100003),
  hrow(D, 'B12', 93100011),
  hrow(B, 'B12', 93100021),
];
type Posted = { sampleId: string; identifier: string; resultValue: string; labResultId: number };
const hinaiPosted: Posted[] = [];
const hinaiAcked: Array<{ sampleID: string; labResultId: number }> = [];
const hinaiBodies: string[] = [];
const hinaiOther: string[] = [];
const hinai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (body) hinaiBodies.push(body);
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
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));

// ---- stand-in GenX -----------------------------------------------------------
const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const acc = (barcode: string) => 'ACC' + barcode;
const gtube = (barcode: string, tests: Array<[number, string]>) => ({
  accessionNumber: acc(barcode),
  sampleNumber: barcode,
  sampleId: barcode.slice(-4),
  status: 'ACCEPTED',
  priority: 'ROUTINE',
  specimenName: 'Serum',
  patient: { uhid: '10032026040311', name: 'ASHA PATEL', genderCode: 'F', dateOfBirth: '1987-12-03' },
  tests: tests.map(([line, svc]) => ({ sampleLineId: String(line), serviceId: '10', serviceCode: svc, serviceName: svc, lineStatus: 'PENDING' })),
});
const genxTubes = [
  gtube(A, [[191001, 'THY'], [191002, 'VITB12']]),
  gtube(D, [[191011, 'VITB12']]),
  gtube(E, [[191031, 'VITB12']]),
];
type GenxFiled = { accessionNumber: string; code: string; value: string };
const genxFiled: GenxFiled[] = [];
const genxResultCalls: string[] = []; // accession per results POST, successful or not
const genxAcked: string[] = [];
const genxBodies: string[] = [];
const genxCertify: string[] = [];
let genxResultsDown = false;
const genx = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/auth-service/api/oauth/token') {
      return res.end(JSON.stringify({ access_token: 'tok1', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (body) genxBodies.push(body);
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      const barcode = url.searchParams.get('barcode');
      const content = barcode === null ? genxTubes : genxTubes.filter((t) => t.sampleNumber === barcode.toUpperCase());
      return res.end(envelope({ content, page: 0, size: 200, totalElements: content.length }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/results') {
      const sent = JSON.parse(body) as { accessionNumber: string; results: Array<{ machineTestCode: string; value: string }> };
      genxResultCalls.push(sent.accessionNumber);
      if (genxResultsDown && sent.accessionNumber === acc(D)) {
        res.statusCode = 503;
        return res.end('{"error":"temporarily unavailable"}');
      }
      for (const r of sent.results) genxFiled.push({ accessionNumber: sent.accessionNumber, code: r.machineTestCode, value: r.value });
      return res.end(envelope({ filed: sent.results.length, unmatched: [], outOfRange: [], panics: [], messageId: 'm1' }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/acknowledge') {
      const sent = JSON.parse(body) as { acknowledgements: Array<{ accessionNumber: string }> };
      genxAcked.push(...sent.acknowledgements.map((a) => a.accessionNumber));
      return res.end(
        envelope({ acknowledgements: sent.acknowledgements.map((a) => ({ accessionNumber: a.accessionNumber, acknowledged: true, status: 'IN_PROCESS' })) }),
      );
    }
    if (/certify/i.test(url.pathname)) genxCertify.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => genx.listen(genxPort, '127.0.0.1', () => r()));

// ---- stand-in IM: order listener + result sender ------------------------------
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

let oruSeq = 0;
const resultAcks: string[] = [];
let resultSock: net.Socket | null = null;
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
  const text = [`MSH|^~\\&|IM|LAB|HMIS-LIS||20261011120000||ORU^R01|${id}|P|2.3.1`, 'PID|1||10032026040311||PATEL^ASHA', `OBR|1|${barcode}|${barcode}|X`, ...obx].join('\r') + '\r';
  const before = resultAcks.length;
  resultSock.write(wrapMllp(text, 'utf8'));
  await until(`IM's ${id} (${barcode}) to be acknowledged`, () => resultAcks.length > before);
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
        clientSecret: 'secret',
        auditLog: join(dir, 'logs', 'hmis-genx.log'),
        accessionCacheFile: join(dir, 'genx-acc.json'),
        serviceTests: { THY: ['TSH3', 'FT4'], VITB12: ['B12'] },
        equipmentServices: { EQ0022: ['THY', 'VITB12'] },
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
      autoCertify: { hinai: false, genx: false },
      analyzer: {
        orderPoll: { intervalMs: 5000, lookbackDays: 0 },
        filing: { passIntervalMs: 5000 },
        hl7: { orderPush: { enabled: true, ackTimeoutMs: 3000 } },
      },
    },
  }),
);

type LaneState = { filedAt: string | null; identifier: string | null; labResultId: number | null; skipped?: 'operator' };
type StoredValue = { value: string; filedAt: string | null; lanes?: Partial<Record<'hinai' | 'genx', LaneState>> };
type StoredSample = { lastError: string | null; values: Record<string, StoredValue> };
const stored = (barcode: string): StoredSample | null => {
  const p = join(dir, 'spool', 'im', 'results', `${barcode}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as StoredSample) : null;
};
const hinaiFor = (b: string) => hinaiPosted.filter((r) => r.sampleId === b);
const genxFor = (b: string) => genxFiled.filter((r) => r.accessionNumber === acc(b));

let failed = false;
let connector: Connector | null = null;
try {
  connector = new Connector(loadConfig(cfgFile), quiet);
  await connector.start();
  const summaryOf = (b: string) => (connector!.staged('im') ?? []).find((s) => s.barcode === b);

  // Both lanes have been read once the first orders have gone out.
  await until('the first poll to send four tubes to IM', () => new Set(orders).size >= 4);

  // ---- 4) filed to both lanes ------------------------------------------------
  await sendResult(A, { TSH3: '2.14', FT4: '1.10', B12: '412' });
  await until('A filed in HINAI', () => hinaiFor(A).length >= 3);
  await until('A filed in GenX', () => genxFor(A).length >= 3);
  {
    const h = Object.fromEntries(hinaiFor(A).map((r) => [r.identifier, [r.resultValue, r.labResultId]]));
    assert.deepEqual(h, { TSH3: ['2.14', 93100001], FT4: ['1.10', 93100002], B12: ['412', 93100003] }, 'HINAI: its own labResultIds');
    assert.deepEqual(sorted(genxFor(A).map((r) => `${r.code}=${r.value}`)), ['B12=412', 'FT4=1.10', 'TSH3=2.14'], 'GenX: every value, by accession');
    await until('A acknowledged in HINAI', () => hinaiAcked.filter((r) => r.sampleID === A).length >= 3);
    await until('A acknowledged in GenX', () => genxAcked.includes(acc(A)));
    assert.deepEqual(sorted(hinaiAcked.filter((r) => r.sampleID === A).map((r) => String(r.labResultId))), ['93100001', '93100002', '93100003']);
    await until('A to be complete in the store', () => Object.values(stored(A)?.values ?? {}).every((v) => v.filedAt));
    const s = stored(A)!;
    for (const [code, line, lr] of [['TSH3', 191001, 93100001], ['FT4', 191001, 93100002], ['B12', 191002, 93100003]] as const) {
      const v = s.values[code]!;
      assert.ok(v.lanes?.hinai?.filedAt && v.lanes?.genx?.filedAt, `${code}: filed in both lanes (${JSON.stringify(v.lanes)})`);
      assert.deepEqual(sorted(Object.keys(v.lanes!)), ['genx', 'hinai'], `${code}: store lane keys exactly "hinai" / "genx" (A5)`);
      assert.equal(v.lanes!.hinai!.labResultId, lr, `${code}: HINAI labResultId`);
      assert.equal(v.lanes!.genx!.labResultId, line, `${code}: GenX labResultId = sampleLineId`);
    }
    assert.ok(summaryOf(A)?.complete, 'the console shows A complete');
    console.log('✓ both lanes: filed to HINAI and GenX, each with its own labResultId, acknowledged per lane');
  }

  // ---- 6) GenX 503: HINAI files, GenX retried, HINAI not re-posted -----------
  genxResultsDown = true;
  await sendResult(D, { B12: '300' });
  await until('D filed in HINAI', () => hinaiFor(D).length >= 1);
  await until('GenX tried D', () => genxResultCalls.includes(acc(D)));
  await wait(500);
  {
    const v = stored(D)!.values.B12!;
    assert.ok(v.lanes?.hinai?.filedAt, 'HINAI lane marked filed');
    assert.ok(!v.lanes?.genx?.filedAt, 'GenX lane not filed');
    assert.equal(v.filedAt, null, 'the value is not done until every lane has it');
    assert.equal(summaryOf(D)?.complete, false);
  }
  genxResultsDown = false;
  await until('GenX to file D on a later pass', () => genxFor(D).length >= 1, 15000);
  await until('D done in the store', () => !!stored(D)?.values.B12?.filedAt);
  assert.equal(hinaiFor(D).length, 1, 'HINAI was not posted D again');
  assert.equal(hinaiAcked.filter((r) => r.sampleID === D).length, 1, 'nor acknowledged twice');
  await until('D acknowledged in GenX', () => genxAcked.includes(acc(D)));
  console.log('✓ lane failure: HINAI filed, GenX retried on the next pass, HINAI not re-posted');

  // ---- 5) hold: a tube in one lane only ---------------------------------------
  await sendResult(B, { B12: '500' });
  await until('B to be held', () => /only in hinai/i.test(stored(B)?.lastError ?? ''));
  {
    const why = stored(B)!.lastError!;
    assert.match(why, /order only in hinai\b.*waiting for genx/i, why);
    assert.match(why, /File now/);
    assert.equal(hinaiFor(B).length, 0, 'nothing posted to HINAI');
    assert.equal(genxFor(B).length + genxResultCalls.filter((a) => a === acc(B)).length, 0, 'nothing posted to GenX');
    assert.ok(/only in hinai/i.test(JSON.stringify(summaryOf(B))), 'the console summary carries the held reason');
    assert.equal(summaryOf(B)?.complete, false);
  }
  await sendResult(F, { TSH3: '1.00' });
  await until('F to be held', () => /neither/i.test(stored(F)?.lastError ?? ''));
  assert.equal(hinaiFor(F).length, 0);
  assert.equal(genxResultCalls.filter((a) => a === acc(F)).length, 0);
  console.log('✓ hold: a tube in one lane, or in neither, is held — nothing posted anywhere');

  // The tube appears in GenX: the next poll brings it, and it files to both.
  genxTubes.push(gtube(B, [[191021, 'VITB12']]));
  await until('B filed in GenX once GenX lists it', () => genxFor(B).length >= 1, 15000);
  await until('B filed in HINAI too', () => hinaiFor(B).length >= 1);
  await until('B done', () => !!stored(B)?.values.B12?.filedAt);
  {
    const v = stored(B)!.values.B12!;
    assert.equal(v.lanes?.hinai?.labResultId, 93100021);
    assert.equal(v.lanes?.genx?.labResultId, 191021);
    // Cleared at the end of the same pass, after the acknowledge — wait for it.
    await until('the hold reason is cleared', () => !stored(B)?.lastError);
  }
  console.log('✓ hold: files to both lanes automatically the moment the other lane lists the tube');

  // "File now" on a tube held because only GenX has it.
  await sendResult(E, { B12: '250' });
  await until('E to be held', () => /only in genx/i.test(stored(E)?.lastError ?? ''));
  assert.equal(genxFor(E).length, 0, 'held: nothing posted to GenX yet');
  const warnsBefore = warns.length;
  const ok = await connector.fileNow('im', E);
  assert.equal(ok, true);
  await until('E filed in GenX by the operator', () => genxFor(E).length >= 1);
  await until('E done', () => !!stored(E)?.values.B12?.filedAt);
  {
    assert.equal(hinaiFor(E).length, 0, 'nothing posted to HINAI, which has no order');
    const v = stored(E)!.values.B12!;
    assert.equal(v.lanes?.hinai?.skipped, 'operator', 'the HINAI lane is marked skipped by the operator');
    assert.ok(v.lanes?.genx?.filedAt);
    assert.equal(v.lanes?.genx?.labResultId, 191031);
    assert.ok(summaryOf(E)?.complete, 'the sample counts as complete');
    const said = warns.slice(warnsBefore).join('\n');
    assert.ok(said.includes(E) && /hinai/i.test(said) && said.includes('B12'), `a warning names the barcode, the lane and the values:\n${said}`);
  }
  console.log('✓ "File now" while held: posted to GenX only, HINAI marked skipped by the operator, sample complete');

  // ---- 7) rerun after filed in both ------------------------------------------
  const hA = hinaiFor(A).length;
  const gA = genxFor(A).length;
  await sendResult(A, { TSH3: '2.50', FT4: '1.10', B12: '412' });
  await until('the rerun TSH3 in HINAI', () => hinaiFor(A).some((r) => r.identifier === 'TSH3' && r.resultValue === '2.50'));
  await until('the rerun TSH3 in GenX', () => genxFor(A).some((r) => r.code === 'TSH3' && r.value === '2.50'));
  await until('A done again', () => !!stored(A)?.values.TSH3?.filedAt);
  {
    assert.deepEqual(hinaiFor(A).slice(hA).map((r) => `${r.identifier}=${r.resultValue}@${r.labResultId}`), ['TSH3=2.50@93100001'], 'HINAI: only the changed value');
    assert.deepEqual(genxFor(A).slice(gA).map((r) => `${r.code}=${r.value}`), ['TSH3=2.50'], 'GenX: only the changed value');
    const v = stored(A)!.values.TSH3!;
    assert.ok(v.lanes?.hinai?.filedAt && v.lanes?.genx?.filedAt);
  }
  console.log('✓ rerun: the corrected value is re-filed to both lanes, and only it');

  // ---- nothing is posted twice across passes ----------------------------------
  const snapshot = () => JSON.stringify([hinaiPosted.length, hinaiAcked.length, genxResultCalls.length, genxAcked.length]);
  // Settle first: the rerun's acknowledgements are sent AFTER its values are
  // marked filed (acknowledge is always last), so on a loaded machine one can
  // still be in flight here. Wait until nothing has changed for 3 s.
  {
    let last = snapshot();
    let stableSince = Date.now();
    await until('posts and acknowledgements to settle', () => {
      const now = snapshot();
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      }
      return Date.now() - stableSince >= 3000;
    }, 30000);
  }
  const before = snapshot();
  await wait(11000); // two filing passes and two polls
  assert.equal(snapshot(), before, 'no post or acknowledge repeated by later passes');
  assert.deepEqual(genxCertify, [], 'genxAutoCertify off: GenX certify never called');
  assert.deepEqual(hinaiOther, [], 'HINAI was only ever asked for pending / labresult / acknowledge');
  for (const b of [...hinaiBodies, ...genxBodies]) assert.ok(!/"source"/.test(b), `no lane tag on the wire: ${b.slice(0, 200)}`);
  console.log('✓ two more passes: nothing posted or acknowledged again; no lane tag ever on the wire');
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
  console.error('\nlanes-filing: FAILED');
  process.exit(1);
}
console.log('\nlanes-filing: all checks passed');
process.exit(0);
