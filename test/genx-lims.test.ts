// GenX lims-node "Lab Connector" client (src/hmis/genx-lims.ts) against a
// LOCAL stub on 127.0.0.1 only. Nothing leaves the machine.
// Run with:  LAB_CONNECTOR_ENV=/nonexistent.env npx tsx test/genx-lims.test.ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenxLimsClient, type GenxLimsOptions } from '../src/hmis/genx-lims.js';
import { HmisUnavailableError } from '../src/hmis/client.js';
import type { LisInboundResultRow } from '../src/types.js';
import { logger } from '../src/logger.js';

type Seen = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string; json: any };
const seen: Seen[] = [];
type Reply = { status: number; body: unknown };
let handler: (s: Seen) => Reply = () => ({ status: 404, body: {} });
let loginCount = 0;
let loginBody: (n: number) => unknown = (n) => ({ token: `tok${n}` });

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, message: 'ok', data, timestamp: 't' } });

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, 'http://127.0.0.1');
    let json: any = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* form body */ }
    const s: Seen = { method: req.method!, path: u.pathname, query: u.searchParams, headers: req.headers, body, json };
    seen.push(s);
    let r: Reply;
    if (u.pathname === '/api/auth/login') { loginCount++; r = { status: 200, body: loginBody(loginCount) }; }
    else if (u.pathname === '/oauth/token') { loginCount++; r = { status: 200, body: { access_token: `otok${loginCount}`, expires_in: 3600 } }; }
    else r = handler(s);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const opts = (over: Partial<GenxLimsOptions> = {}): GenxLimsOptions => ({
  baseUrl: base,
  authBaseUrl: base,
  auth: 'login',
  loginPath: '/api/auth/login',
  username: 'lab',
  password: 'pw',
  tokenPath: '/oauth/token',
  clientId: 'cid',
  clientSecret: 'sec',
  scope: '',
  clientAuth: 'basic',
  apiKeyHeader: 'X-API-Key',
  moduleCode: 'DS',
  ordersPath: '/api/connector/orders',
  acknowledgePath: '/api/connector/acknowledge',
  resultsPath: '/api/connector/results',
  autoCertifyPath: '/api/lines/auto-certify',
  barcodeField: 'barcode',
  serviceTests: { CBC: ['WBC', 'HGB'] },
  pendingLineStatuses: [],
  batchDays: 1,
  reliabilityPct: null,
  timeoutMs: 5000,
  tlsRejectUnauthorized: true,
  logger,
  ...over,
});

let pass = 0;
let fail = 0;
const check = (name: string, good: boolean, detail = '') => {
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  good ? pass++ : fail++;
};
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error; } };
const reset = () => { seen.length = 0; loginCount = 0; loginBody = (n) => ({ token: `tok${n}` }); };
const apiCalls = () => seen.filter((s) => !s.path.startsWith('/api/auth') && s.path !== '/oauth/token');
const lastApi = () => apiCalls().at(-1)!;
const pad = (n: number) => String(n).padStart(2, '0');
const ld = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const row = (o: Partial<LisInboundResultRow>): LisInboundResultRow => ({
  sampleId: 'LB1', labServiceId: 1, labResultId: 10, equipmentId: null, ipAddress: '', portNo: '',
  identifier: 'WBC', resultValue: '7.8', isLoaded: false, uniqueIdentifier: 'WBC', parameterId: null, ...o,
});

// --- login + host query -------------------------------------------------------
{
  reset();
  const tube = { barcode: 'LB1', priority: 'STAT', specimenName: 'Blood', patient: { uhid: 'U1', name: 'P', genderCode: 'M', dateOfBirth: '1990-01-01' },
    tests: [{ sampleLineId: 5, serviceId: 9, serviceCode: 'CBC', lineStatus: 'PENDING' }] };
  handler = () => ok([tube]);
  const c = new GenxLimsClient(opts());
  const rows = (await c.getPending({ sampleId: 'lb1', eqCode: 'EC013' })) as any[];
  const login = seen[0]!;
  check('login: POST /api/auth/login', login.method === 'POST' && login.path === '/api/auth/login');
  check('login: body has userName/password/userLoginHistoryInput', JSON.stringify(login.json) === JSON.stringify({ userName: 'lab', password: 'pw', userLoginHistoryInput: { usingDetailsHistory: [{}] } }), login.body);
  const g = lastApi();
  check('orders: GET on ordersPath', g.method === 'GET' && g.path === '/api/connector/orders');
  check('orders: query equipmentCode + uppercased barcode', g.query.get('equipmentCode') === 'EC013' && g.query.get('barcode') === 'LB1' && !g.query.has('date'), g.query.toString());
  check('orders: Bearer token + module-code DS', g.headers.authorization === 'Bearer tok1' && g.headers['module-code'] === 'DS');
  check('orders: no body sent on GET', g.body === '');
  check('orders: CBC expanded via serviceTests to 2 rows', rows.length === 2 && rows[0].identifier === 'WBC' && rows[1].identifier === 'HGB' && rows[0].sampleID === 'LB1');
  check('orders: row carries line id, service, patient', rows[0].labResultId === 5 && rows[0].labServiceId === 9 && rows[0].uhid === 'U1' && rows[0].gender === 'M' && rows[0].priority === 'STAT');
  check('orders: empty pendingLineStatuses -> isTransmitted false', rows.every((r) => r.isTransmitted === false));
  await c.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  check('token reused across calls (one login)', loginCount === 1);
}

// --- batch ------------------------------------------------------------------------
{
  reset();
  handler = () => ok([]);
  const c = new GenxLimsClient(opts({ batchDays: 2 }));
  await c.getPending({ eqCode: 'EC013' });
  const calls = apiCalls();
  const today = new Date();
  const want = [0, 1, 2].map((d) => ld(new Date(today.getTime() - d * 86_400_000)));
  check('batch: batchDays+1 GETs', calls.length === 3, String(calls.length));
  check('batch: one local date per call, newest first', JSON.stringify(calls.map((x) => x.query.get('date'))) === JSON.stringify(want), JSON.stringify(calls.map((x) => x.query.get('date'))));
  check('batch: equipmentCode set, no barcode', calls.every((x) => x.query.get('equipmentCode') === 'EC013' && !x.query.has('barcode')));
}

// --- toRows shapes ----------------------------------------------------------------
{
  const c = new GenxLimsClient(opts({ pendingLineStatuses: ['PENDING'] }));
  const ids = (rs: any[]) => rs.map((r) => r.identifier);
  const t = { barcode: 'LB2', tests: [{ lineStatus: 'PENDING', parameters: [{ parameterId: 1334, parameterCode: 'PO2', machineTestCode: 'PO2M' }, { parameterId: 7, parameterCode: 'PCO2' }] }] };
  const r1 = c.toRows([t], '');
  check('rows: analytes -> identifier machineTestCode, fallback parameterCode', JSON.stringify(ids(r1)) === '["PO2M","PCO2"]', JSON.stringify(ids(r1)));
  check('rows: parameterId kept', r1[0]!.parameterId === 1334 && r1[1]!.parameterId === 7);
  check('rows: PENDING status -> isTransmitted false', r1.every((r) => r.isTransmitted === false));
  const r2 = c.toRows([{ barcode: 'LB2', lines: [{ status: 'DONE', parameters: [{ parameterCode: 'A' }] }] }], '');
  check('rows: lines key + pending list with status DONE -> isTransmitted true', r2.length === 1 && r2[0]!.isTransmitted === true);
  const r3 = c.toRows([{ barcode: 'LB3', tests: [{ serviceCode: 'CBC' }, { serviceCode: 'ZZZ' }] }], '');
  check('rows: serviceTests expansion + unmapped serviceCode as single row', JSON.stringify(ids(r3)) === '["WBC","HGB","ZZZ"]', JSON.stringify(ids(r3)));
  const r4 = c.toRows([{ barcode: 'LB4', tests: [{ parameters: [{ parameterCode: 'X', parameterId: 1 }] }, { parameters: [{ parameterCode: 'x', parameterId: 1 }, { parameterCode: 'Y' }] }] }], '');
  check('rows: duplicate analyte across lines -> one row', JSON.stringify(ids(r4)) === '["X","Y"]', JSON.stringify(ids(r4)));
  const r5 = c.toRows([{ sampleNumber: 'LB5', parameters: [{ parameterCode: 'Q' }] }], '');
  check('rows: tube listing analytes directly (sampleNumber fallback)', r5.length === 1 && r5[0]!.sampleID === 'LB5');
  const r6 = c.toRows([{ priority: 'x', tests: [] }], '');
  check('rows: tube without barcode skipped', r6.length === 0);

  // response envelope shapes through the wire
  reset();
  const shapes: Array<[string, unknown]> = [
    ['data array', [t]],
    ['data.content', { content: [t] }],
    ['data.orders', { orders: [t] }],
    ['data single tube object', t],
  ];
  const cl = new GenxLimsClient(opts());
  for (const [name, data] of shapes) {
    handler = () => ok(data);
    const rs = (await cl.getPending({ sampleId: 'LB2', eqCode: 'EC013' })) as any[];
    check(`wire shape: ${name}`, rs.length === 2, String(rs.length));
  }
}

// --- results ---------------------------------------------------------------------
{
  reset();
  const c = new GenxLimsClient(opts());
  handler = (s) => (s.method === 'GET' ? ok([{ barcode: 'LB1', tests: [{ parameters: [{ parameterId: 1334, parameterCode: 'PO2', machineTestCode: 'PO2M' }, { parameterCode: 'PCO2' }] }] }]) : ok({ filed: 3 }));
  await c.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  const rows = [
    row({ identifier: 'PO2M', resultValue: '90', unit: 'mmHg' }),
    row({ identifier: 'PCO2', resultValue: '40' }),
    row({ identifier: 'NA', resultValue: '140', parameterId: 55 }),
    row({ identifier: 'K', resultValue: '4' }),
  ];
  const res = await c.postResults(rows, 'EC013');
  const p = lastApi();
  check('results: POST resultsPath with JSON body', p.method === 'POST' && p.path === '/api/connector/results' && p.headers['content-type'] === 'application/json');
  check('results: bearer + module-code', p.headers.authorization === 'Bearer tok1' && p.headers['module-code'] === 'DS');
  check('results: barcode/equipmentCode/messageId top-level, no reliabilityPct', p.json.barcode === 'LB1' && p.json.equipmentCode === 'EC013' && /^EC013-[0-9a-f]{16}$/.test(p.json.messageId) && !('reliabilityPct' in p.json));
  const v = p.json.values;
  check('results: parameterId learned from orders', v[0].parameterId === 1334 && !('parameterCode' in v[0]));
  check('results: parameterCode learned from orders when no id', v[1].parameterCode === 'PCO2' && !('parameterId' in v[1]));
  check('results: row.parameterId wins', v[2].parameterId === 55);
  check('results: unknown -> parameterCode = identifier', v[3].parameterCode === 'K' && !('parameterId' in v[3]));
  check('results: value fields', v[0].value === '90' && v[0].rawValue === '90' && v[0].unit === 'mmHg' && v[0].machineUnit === 'mmHg' && v[0].remarks === null && !('unit' in v[1]));
  check('results: idempotency-key header', /^[0-9a-f-]{36}$/.test(String(p.headers['idempotency-key'])));
  check('results: successData per row, filed 4', res.successData.length === 4 && res.filed === 4 && res.status === 'success', JSON.stringify(res));
  const key1 = p.json.messageId;
  await c.postResults(rows, 'EC013');
  check('messageId stable for identical content', lastApi().json.messageId === key1 && lastApi().headers['idempotency-key'] === p.headers['idempotency-key']);
  await c.postResults([row({ identifier: 'PO2M', resultValue: '91' })], 'EC013');
  check('messageId changes with content', lastApi().json.messageId !== key1);

  const cr = new GenxLimsClient(opts({ reliabilityPct: 95 }));
  await cr.postResults([row({})], 'EC013');
  check('reliabilityPct sent when configured', lastApi().json.reliabilityPct === 95);

  // two tubes -> two POSTs
  const n0 = apiCalls().length;
  await c.postResults([row({ sampleId: 'a1' }), row({ sampleId: 'b2' })], 'EC013');
  const posted = apiCalls().slice(n0).map((x) => x.json.barcode);
  check('results: one POST per tube, barcodes uppercased', JSON.stringify(posted) === '["A1","B2"]', JSON.stringify(posted));

  const empty = await c.postResults([], 'EC013');
  check('results: empty input -> no call', empty.filed === 0 && apiCalls().length === n0 + 2);

  // unmatched shapes
  const um = async (reply: unknown, rs: LisInboundResultRow[]) => { handler = () => ok(reply); return new GenxLimsClient(opts()).postResults(rs, 'EC013'); };
  const two = [row({ identifier: 'PO2', parameterId: 1334 }), row({ identifier: 'WBC' })];
  let r = await um({ filed: 1, unmatched: [1334] }, two);
  check('unmatched [1334] -> back to identifier, excluded', JSON.stringify(r.unmatched) === '["PO2"]' && r.successData.length === 1 && r.filed === 1, JSON.stringify(r));
  r = await um({ unmatched: [{ parameterCode: 'PO2' }] }, [row({ identifier: 'PO2' }), row({ identifier: 'WBC' })]);
  check('unmatched [{parameterCode}] -> identifier, filed inferred', JSON.stringify(r.unmatched) === '["PO2"]' && r.successData.length === 1, JSON.stringify(r));
  r = await um({ values: [{ parameterCode: 'PO2', status: 'FAILED' }, { parameterCode: 'WBC', status: 'SUCCESS' }] }, [row({ identifier: 'PO2' }), row({ identifier: 'WBC' })]);
  check('values[].status FAILED -> unmatched', JSON.stringify(r.unmatched) === '["PO2"]' && r.successData.length === 1, JSON.stringify(r));

  let e = await rejects(um({ filed: 0, unmatched: ['WBC'] }, [row({})]));
  check('filed 0 -> throws', !!e && /filed 0/.test(e.message), e?.message);
  e = await rejects(um({ status: 'failure', message: 'nope' }, [row({})]));
  check("status 'failure' -> throws", !!e && /failure/.test(e.message), e?.message);
  e = await rejects(um({ unmatched: ['WBC'] }, [row({})]));
  check('every value unmatched (no filed field) -> throws', !!e);
}

// --- acknowledge / certify ------------------------------------------------------------
{
  reset();
  const c = new GenxLimsClient(opts());
  handler = () => ok({ results: [{ barcode: 'LB1', acknowledged: false, reason: 'x' }] });
  const e = await rejects(c.acknowledge([{ sampleID: 'lb1' } as any, { sampleID: 'LB1' } as any, { sampleID: 'lb2' } as any], 'EC013'));
  const a = lastApi();
  check('acknowledge: refusal verdict does not throw', e === null, e?.message);
  check('acknowledge: POST body equipmentCode + unique uppercased barcodes', a.method === 'POST' && a.path === '/api/connector/acknowledge' && JSON.stringify(a.json) === '{"equipmentCode":"EC013","barcodes":["LB1","LB2"]}', a.body);
  check('acknowledge: headers', a.headers.authorization === 'Bearer tok1' && a.headers['module-code'] === 'DS');
  const n = apiCalls().length;
  await c.acknowledge([], 'EC013');
  check('acknowledge: empty -> no call', apiCalls().length === n);

  handler = () => ok({ results: [{ sampleLineId: 77, certified: true }] });
  await c.autoCertify(77, 'EC013', 'LB1');
  const z = lastApi();
  check('autoCertify: POST {sampleLineIds:[id]}', z.method === 'POST' && z.path === '/api/lines/auto-certify' && JSON.stringify(z.json) === '{"sampleLineIds":[77]}' && z.headers['module-code'] === 'DS', z.body);
  handler = () => ok({ results: [{ certified: false, reason: 'x' }] });
  const e2 = await rejects(c.autoCertify(77));
  check('autoCertify: refusal throws', !!e2 && /refused/.test(e2.message), e2?.message);
}

// --- errors / auth ----------------------------------------------------------------------
{
  reset();
  const c = new GenxLimsClient(opts());
  let fired = false;
  handler = () => { if (!fired) { fired = true; return { status: 401, body: { error: 'expired' } }; } return ok([]); };
  await c.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  const gets = apiCalls();
  check('401 once -> re-login and retry succeeds', loginCount === 2 && gets.length === 2 && gets[0]!.headers.authorization === 'Bearer tok1' && gets[1]!.headers.authorization === 'Bearer tok2');

  reset();
  handler = () => ({ status: 401, body: {} });
  let e = await rejects(new GenxLimsClient(opts()).getPending({ sampleId: 'LB1', eqCode: 'EC013' }));
  check('401 twice -> HmisUnavailableError', e instanceof HmisUnavailableError, e?.message);

  handler = () => ({ status: 500, body: 'boom' });
  e = await rejects(new GenxLimsClient(opts()).getPending({ sampleId: 'LB1', eqCode: 'EC013' }));
  check('HTTP 500 -> HmisUnavailableError', e instanceof HmisUnavailableError, e?.message);

  handler = () => ({ status: 200, body: { success: false, message: 'bad barcode', data: null } });
  e = await rejects(new GenxLimsClient(opts()).getPending({ sampleId: 'LB1', eqCode: 'EC013' }));
  check('success:false -> error with message', !!e && !(e instanceof HmisUnavailableError) && /bad barcode/.test(e.message), e?.message);

  handler = () => ({ status: 400, body: {} });
  e = await rejects(new GenxLimsClient(opts()).getPending({ sampleId: 'LB1', eqCode: 'EC013' }));
  check('HTTP 400 -> plain Error (not hold-queue)', !!e && !(e instanceof HmisUnavailableError), e?.message);

  reset();
  e = await rejects(new GenxLimsClient(opts({ username: '' })).getPending({ sampleId: 'LB1', eqCode: 'EC013' }));
  check('login without username -> HmisUnavailableError, zero HTTP calls', e instanceof HmisUnavailableError && seen.length === 0, `${e?.message} calls=${seen.length}`);

  // JWT exp: a token expiring within the 60s margin is not reused
  reset();
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  loginBody = (n) => ({ token: n === 1 ? jwt(Math.floor(Date.now() / 1000) + 30) : jwt(Math.floor(Date.now() / 1000) + 7200) });
  handler = () => ok([]);
  const cj = new GenxLimsClient(opts());
  await cj.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  await cj.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  check('JWT exp within 60s margin -> token refreshed on next call', loginCount === 2, String(loginCount));
  await cj.getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  check('JWT exp far ahead -> token reused', loginCount === 2);

  // token under data.token
  reset();
  loginBody = () => ({ data: { token: 'nested' } });
  handler = () => ok([]);
  await new GenxLimsClient(opts()).getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  check('login token nested under data accepted', lastApi().headers.authorization === 'Bearer nested');

  // oauth
  reset();
  await new GenxLimsClient(opts({ auth: 'oauth', apiKey: 'k1' })).getPending({ sampleId: 'LB1', eqCode: 'EC013' });
  const t = seen[0]!;
  check('oauth: client_credentials form on tokenPath with Basic auth', t.path === '/oauth/token' && t.body.includes('grant_type=client_credentials') && t.headers.authorization === 'Basic ' + Buffer.from('cid:sec').toString('base64'));
  check('oauth: Bearer + module-code + api key header on call', lastApi().headers.authorization === 'Bearer otok1' && lastApi().headers['module-code'] === 'DS' && lastApi().headers['x-api-key'] === 'k1');
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
