// Tatva v1 (hmis.tatva) — the ZyHos partner Lab Middleware API, post-only.
// One stub server plays both systems: HINAI's /mirth/* (orders + ack) and the
// new partner API (/oauth/token, /external/v1/lab/equipment/*), shaped like
// ZyHos-Preprod-Lab-Middleware.postman_collection.json.
// Run with:  npx tsx test/tatva-client.test.ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HmisClient } from '../src/hmis/client.js';
import { ResultRoutedGateway, makeTatvaClient, tatvaClientOptions, tatvaEquipmentOptions, type TatvaSettings } from '../src/hmis/tatva.js';
import { TatvaEquipmentClient, refusedCodes } from '../src/hmis/tatva-equipment.js';
import { logger } from '../src/logger.js';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
const seen: Seen[] = [];
let resultsReply: unknown = { filed: 2, unmatched: [], outOfRange: [], messageId: 'm1' };
let mirthReply: unknown = { status: 'success', message: 'saved 2 row(s)', filed: 2 };

const envelope = (data: unknown) =>
  JSON.stringify({ success: true, data: { success: true, message: 'ok', data } });

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    const url = req.url!;
    if (url === '/oauth/token') {
      return send(200, JSON.stringify({ access_token: 'rs512tok', token_type: 'Bearer', expires_in: 600, scope: 'lab.equipment.result.publish' }));
    }
    if (url.startsWith('/external/v1/lab/equipment/worklist')) {
      return send(200, envelope({ content: [{ accessionNumber: 'ACC26000001', sampleNumber: 'PL2610200001', tests: [] }] }));
    }
    if (url === '/external/v1/lab/equipment/results') return send(200, envelope(resultsReply));
    if (url === '/external/v1/lab/equipment/acknowledge') return send(200, envelope({ acknowledgements: [{ acknowledged: true }] }));
    if (url === '/diagnostic-service/mirth/labresult') return send(200, JSON.stringify(mirthReply));
    if (url === '/diagnostic-service/mirth/acknowledge') return send(200, JSON.stringify({ status: 'success', message: 'acknowledged 1 row(s)', filed: 1 }));
    if (url.startsWith('/mirth/pending')) return send(200, JSON.stringify([]));
    if (url === '/mirth/acknowledge') return send(200, JSON.stringify({ status: 'success', message: 'ok' }));
    if (url === '/mirth/labresult') return send(200, JSON.stringify({ status: 'success', successData: [{}] }));
    send(404, '{}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const settings: TatvaSettings = {
  baseUrl: base,
  apiPrefix: '/external/v1',
  tokenPath: '/oauth/token',
  revokePath: '/oauth/revoke',
  worklistPath: '',
  acknowledgePath: '',
  resultsPath: '',
  clientId: 'cid',
  clientSecret: 'csecret',
  scope: 'lab.equipment.worklist.read lab.equipment.acknowledge lab.equipment.result.publish',
  clientAuth: 'body',
  apiKey: '',
  apiKeyHeader: 'X-Api-Key',
  barcodeField: 'sampleNumber',
  accessionCacheFile: join(mkdtempSync(join(tmpdir(), 'tatva-')), 'acc.json'),
  facilityId: 'F1',
  organizationId: '',
};
const common = { timeoutMs: 5000, tlsRejectUnauthorized: true, logger };

const hinai = new HmisClient({
  baseUrl: base, pendingPath: '/mirth/pending', acknowledgePath: '/mirth/acknowledge', resultsPath: '/mirth/labresult', ...common,
});
const tatva = makeTatvaClient(tatvaClientOptions(settings, common));
const routed = new ResultRoutedGateway(hinai, tatva, 'orders');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const row = (identifier: string, resultValue: string) => ({
  sampleId: 'PL2610200001', labServiceId: 11, labResultId: 22, equipmentId: null,
  ipAddress: '', portNo: '', isLoaded: false, uniqueIdentifier: identifier, parameterId: null, identifier, resultValue,
  unit: 'g/dL', abnormalFlag: 'N',
});

// --- orders still come from HINAI ---------------------------------------------
await routed.getPending({ sampleId: 'PL2610200001', eqCode: 'EQ-HEMA-01' });
check('pending poll goes to HINAI /mirth/pending', seen.some((s) => s.url.startsWith('/mirth/pending')));

// --- results go to Tatva v1 ----------------------------------------------------
const res = await routed.postResults([row('HGB', '12.5'), row('WBC', '7.1')], 'EQ-HEMA-01');
const token = seen.find((s) => s.url === '/oauth/token')!;
check('token: client_credentials with client_id/secret in the form body',
  token.body.includes('grant_type=client_credentials') && token.body.includes('client_id=cid') && token.body.includes('client_secret=csecret') && !token.headers.authorization);
check('sampleNumber looked up on the worklist for its accessionNumber', seen.some((s) => s.url.startsWith('/external/v1/lab/equipment/worklist?barcode=PL2610200001')));
const post = seen.filter((s) => s.url === '/external/v1/lab/equipment/results').at(-1)!;
const sent = JSON.parse(post.body);
check('results posted to {apiPrefix}/lab/equipment/results', !!post);
check('Bearer token sent', post.headers.authorization === 'Bearer rs512tok');
check('Idempotency-Key (not X-Idempotency-Key) present', !!post.headers['idempotency-key'] && !post.headers['x-idempotency-key']);
check('body keyed by accessionNumber + equipmentCode', sent.accessionNumber === 'ACC26000001' && sent.equipmentCode === 'EQ-HEMA-01');
check('values sent as machineTestCode/value', sent.results[0].machineTestCode === 'HGB' && sent.results[0].value === '12.5');
check('unit + flag sent', sent.results[0].unit === 'g/dL' && sent.results[0].flag === 'N', JSON.stringify(sent.results[0]));
check('X-Facility-ID sent, empty X-Organization-ID not', post.headers['x-facility-id'] === 'F1' && post.headers['x-organization-id'] === undefined);
check('HINAI /mirth/labresult NOT called', !seen.some((s) => s.url === '/mirth/labresult'));
check('filed count returned', res.filed === 2, String(res.filed));

// --- outOfRange counts as not filed ---------------------------------------------
resultsReply = { filed: 1, unmatched: [], outOfRange: ['WBC'] };
const partial = await routed.postResults([row('HGB', '12.6'), row('WBC', '999')], 'EQ-HEMA-01');
check('outOfRange code reported as unplaced', (partial.unmatched ?? []).includes('WBC'), JSON.stringify(partial.unmatched));
check('only placed values in successData', partial.filed === 1);

resultsReply = { filed: 0, unmatched: ['HGB'] };
let threw = '';
try {
  await routed.postResults([row('HGB', '12.7')], 'EQ-HEMA-01');
} catch (e) {
  threw = (e as Error).message;
}
check('filed 0 throws, labelled Tatva v1', threw.includes('Tatva v1') && threw.includes('filed 0'), threw);

// --- acknowledge stays on HINAI by default ---------------------------------------
await routed.acknowledge([{ sampleID: 'PL2610200001', identifier: 'HGB' } as never], 'EQ-HEMA-01');
check('acknowledge goes to HINAI /mirth/acknowledge', seen.some((s) => s.url === '/mirth/acknowledge'));
check('Tatva acknowledge not called', !seen.some((s) => s.url === '/external/v1/lab/equipment/acknowledge'));

const off = new ResultRoutedGateway(hinai, tatva, 'off');
const before = seen.length;
await off.acknowledge([{ sampleID: 'PL2610200001', identifier: 'HGB' } as never], 'EQ-HEMA-01');
check('acknowledge "off" makes no call', seen.length === before);

// --- auth "equipment": per-machine X-Equipment-ID / X-Equipment-Secret ----------
const eq = new TatvaEquipmentClient(
  tatvaEquipmentOptions(settings, { equipmentId: '49', equipmentSecret: 's3cret' }, { timeoutMs: 5000, logger }),
);
const routedEq = new ResultRoutedGateway(hinai, eq, 'orders');
const eqRes = await routedEq.postResults([row('TSH', '2.1'), row('FT4', '1.2')], 'MAGLUMI01');
const mpost = seen.filter((s) => s.url === '/diagnostic-service/mirth/labresult').at(-1)!;
const mbody = JSON.parse(mpost.body);
check('equipment: posted to /diagnostic-service/mirth/labresult', !!mpost);
check('equipment: X-Equipment-ID + X-Equipment-Secret headers', mpost.headers['x-equipment-id'] === '49' && mpost.headers['x-equipment-secret'] === 's3cret');
check('equipment: no Bearer token', !mpost.headers.authorization);
check('equipment: array body, barcode sent as sampleId', Array.isArray(mbody) && mbody[0].sampleId === 'PL2610200001' && mbody[0].identifier === 'TSH');
check('equipment: unit + abnormalFlag sent', mbody[0].unit === 'g/dL' && mbody[0].abnormalFlag === 'N');
check('equipment: filed 2', eqRes.filed === 2);

mirthReply = { status: 'success', message: 'saved 1 row(s); FT4 unmapped', filed: 1 };
const eqPartial = await routedEq.postResults([row('TSH', '2.2'), row('FT4', '1.3')], 'MAGLUMI01');
check('equipment: "unmapped" code reported unmatched', JSON.stringify(eqPartial.unmatched) === '["FT4"]', JSON.stringify(eqPartial.unmatched));

mirthReply = { status: 'success', message: 'TSH: Outside the reportable range', filed: 0 };
let eqThrew = '';
try {
  await routedEq.postResults([row('TSH', '999')], 'MAGLUMI01');
} catch (e) {
  eqThrew = (e as Error).message;
}
check('equipment: status success + filed 0 is a failure', eqThrew.includes('filed 0'), eqThrew);
check('refusedCodes ignores codes glued to other text', refusedCodes('XTSH unmapped', [row('TSH', '1')]).length === 0);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
