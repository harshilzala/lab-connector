// GenX LIMS client (hmis.api = "genx") against a local stub of the gateway,
// shaped exactly like the Postman collection's example responses.
// Run with:  npx tsx test/genx-client.test.ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenxHmisClient } from '../src/hmis/genx.js';
import { normalizePending } from '../src/hmis/pending.js';
import { parseJsonc } from '../src/config.js';
import { logger } from '../src/logger.js';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
const seen: Seen[] = [];
let tokensIssued = 0;
let expireNextApiCall = false;
let resultsReply: unknown = null;

const envelope = (message: string, data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message, timestamp: 't', data } });

const TUBE = {
  accessionNumber: 'ACC26092700017',
  sampleNumber: 'PL2609230001',
  sampleId: '88412',
  status: 'ACCEPTED',
  priority: 'STAT',
  specimenName: 'Whole Blood (EDTA)',
  patient: { uhid: 'UH00123456', name: 'Test Patient', genderCode: 'M', dateOfBirth: '1984-08-14' },
  tests: [
    { sampleLineId: '190233', serviceId: '1021', serviceCode: 'CBC', serviceName: 'Complete Blood Count', lineStatus: 'PENDING' },
    { sampleLineId: '190234', serviceId: '2001', serviceCode: 'HBA1C', serviceName: 'HbA1c', lineStatus: 'PENDING' },
  ],
};

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
    if (req.url === '/auth-service/api/oauth/token') {
      tokensIssued++;
      return send(200, JSON.stringify({ access_token: `tok${tokensIssued}`, token_type: 'Bearer', expires_in: 3600 }));
    }
    if (expireNextApiCall) {
      expireNextApiCall = false;
      return send(401, '{"error":"invalid_token"}');
    }
    if (req.url!.startsWith('/integration-service/external/v1/lab/equipment/worklist')) {
      const u = new URL(req.url!, 'http://x');
      const b = u.searchParams.get('barcode');
      const content = b === null || b === TUBE.sampleNumber ? [TUBE] : [];
      return send(200, envelope('Success', { content, page: 0, size: 200, totalElements: content.length }));
    }
    if (req.url === '/integration-service/external/v1/lab/equipment/acknowledge') {
      return send(200, envelope('Acknowledged', {
        acknowledgements: [{ accessionNumber: TUBE.accessionNumber, acknowledged: true, status: 'IN_PROCESS' }],
      }));
    }
    if (req.url === '/integration-service/external/v1/lab/equipment/results') {
      return send(200, envelope('Filed', resultsReply));
    }
    send(404, '{}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const cacheFile = join(mkdtempSync(join(tmpdir(), 'genx-')), 'acc.json');

const makeClient = () =>
  new GenxHmisClient({
    baseUrl: `http://127.0.0.1:${port}`,
    tokenPath: '/auth-service/api/oauth/token',
    worklistPath: '/integration-service/external/v1/lab/equipment/worklist',
    acknowledgePath: '/integration-service/external/v1/lab/equipment/acknowledge',
    resultsPath: '/integration-service/external/v1/lab/equipment/results',
    clientId: 'cid',
    clientSecret: 'secret',
    scope: 'lab.equipment.worklist.read',
    clientAuth: 'basic',
    apiKey: 'k123',
    apiKeyHeader: 'X-API-Key',
    barcodeField: 'sampleNumber',
    serviceTests: { CBC: ['WBC', 'HGB', 'PLT'] },
    equipmentServices: { ZHPN001: ['CBC'] },
    pendingLineStatuses: ['PENDING'],
    batchDays: 1,
    batchPageSize: 200,
    accessionCacheFile: cacheFile,
    timeoutMs: 5000,
    tlsRejectUnauthorized: true,
    logger,
  });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const client = makeClient();

// --- host query --------------------------------------------------------------
const body = await client.getPending({ sampleId: 'pl2609230001', eqCode: 'ZHPN001' });
const tokenCall = seen.find((s) => s.url === '/auth-service/api/oauth/token')!;
check('token: client_credentials form', tokenCall.body.includes('grant_type=client_credentials'));
check('token: Basic auth header', tokenCall.headers.authorization === 'Basic ' + Buffer.from('cid:secret').toString('base64'));
const wl = seen.find((s) => s.url.includes('/worklist'))!;
check('worklist queried by uppercased barcode', wl.url.endsWith('?barcode=PL2609230001'), wl.url);
check('worklist carries bearer token', wl.headers.authorization === 'Bearer tok1');
check('worklist carries api key', wl.headers['x-api-key'] === 'k123');

const orders = normalizePending(body, { sampleId: 'PL2609230001', eqCode: 'ZHPN001' });
check('CBC expanded to analyzer codes', JSON.stringify(orders.testCodes) === '["WBC","HGB","PLT"]', JSON.stringify(orders.testCodes));
check('HBA1C withheld from ZHPN001 by equipmentServices', !orders.testCodes.includes('HBA1C'));
check('labResultId = GenX sampleLineId', orders.ackItems.every((a) => a.labResultId === 190233));
check('patient carried through', orders.patient?.patientId === 'UH00123456' && orders.patient?.sex === 'M' && orders.patient?.birthDate === '19840814');
check('STAT priority', orders.priority === 'S');
check('specimen', orders.specimenType === 'Whole Blood (EDTA)');
check('accession remembered on disk', JSON.parse(readFileSync(cacheFile, 'utf8')).PL2609230001 === 'ACC26092700017');

const other = normalizePending(await client.getPending({ sampleId: 'PL2609230001', eqCode: 'ZHPN002' }), { sampleId: 'PL2609230001' });
check('unlisted equipmentCode takes every service', other.testCodes.includes('HBA1C') && other.testCodes.includes('WBC'), JSON.stringify(other.testCodes));

// --- results -----------------------------------------------------------------
resultsReply = { filed: 2, unmatched: ['XYZ'], outOfRange: [], panics: [], reflex: [], messageId: '553201' };
const rows = [
  { identifier: 'WBC', resultValue: '7.8' },
  { identifier: 'HGB', resultValue: '13.9' },
  { identifier: 'XYZ', resultValue: '1' },
].map((r) => ({
  sampleId: 'PL2609230001', labServiceId: 1021, labResultId: 190233, equipmentId: null,
  ipAddress: '', portNo: '', isLoaded: false, uniqueIdentifier: r.identifier, parameterId: null, ...r,
}));
const res = await client.postResults(rows, 'ZHPN001');
const post1 = seen.filter((s) => s.url.endsWith('/results')).at(-1)!;
const sent = JSON.parse(post1.body);
check('results keyed by accessionNumber', sent.accessionNumber === 'ACC26092700017');
check('results carry equipmentCode', sent.equipmentCode === 'ZHPN001');
check('values sent as machineTestCode', sent.results[0].machineTestCode === 'WBC' && sent.results[0].value === '7.8');
check('Idempotency-Key header present', /^[0-9a-f-]{36}$/.test(String(post1.headers['idempotency-key'])));
check('unmatched code not reported as filed', res.filed === 2 && !res.successData.some((d) => d === undefined));

await client.postResults(rows, 'ZHPN001');
const post2 = seen.filter((s) => s.url.endsWith('/results')).at(-1)!;
check('same content → same Idempotency-Key (retry is replayed, not re-filed)', post1.headers['idempotency-key'] === post2.headers['idempotency-key']);
await client.postResults([{ ...rows[0]!, resultValue: '7.9' }], 'ZHPN001');
const post3 = seen.filter((s) => s.url.endsWith('/results')).at(-1)!;
check('corrected value → new Idempotency-Key', post3.headers['idempotency-key'] !== post1.headers['idempotency-key']);

resultsReply = { filed: 0, unmatched: ['WBC'] };
let threw = '';
try {
  await client.postResults([rows[0]!], 'ZHPN001');
} catch (e) {
  threw = (e as Error).message;
}
check('filed 0 is a failure, not a silent success', threw.includes('filed 0'), threw);

// --- acknowledge ---------------------------------------------------------------
await client.acknowledge(orders.ackItems, 'ZHPN001');
const ack = JSON.parse(seen.filter((s) => s.url.endsWith('/acknowledge')).at(-1)!.body);
check('one acknowledgement per tube', ack.acknowledgements.length === 1);
check('ack keyed by accession + equipmentCode', ack.acknowledgements[0].accessionNumber === 'ACC26092700017' && ack.acknowledgements[0].equipmentCode === 'ZHPN001');

// --- token expiry ---------------------------------------------------------------
expireNextApiCall = true;
const before = tokensIssued;
await client.getPending({ sampleId: 'PL2609230001', eqCode: 'ZHPN001' });
check('401 → one new token and the call is retried', tokensIssued === before + 1);

// --- restart: accession comes from the cache file ---------------------------------
const restarted = makeClient();
resultsReply = { filed: 1, unmatched: [] };
const wlBefore = seen.filter((s) => s.url.includes('/worklist')).length;
await restarted.postResults([rows[0]!], 'ZHPN001');
check('after restart the accession is read from the cache, no worklist call', seen.filter((s) => s.url.includes('/worklist')).length === wlBefore);

// --- the live config parses with the genx block present ------------------------------
const cfgText = readFileSync(new URL('../config.json', import.meta.url), 'utf8');
const cfg = parseJsonc(cfgText) as { hmis: { api: string; genx: { serviceTests: Record<string, string[]> } } };
check('config.json: api switch present', cfg.hmis.api === 'mirth' || cfg.hmis.api === 'genx', cfg.hmis.api);
check('config.json: genx block present', Array.isArray(cfg.hmis.genx.serviceTests.CBC));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
