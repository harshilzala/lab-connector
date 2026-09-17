import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// Pins the console's "Re-send" (Orders tab → Re-send).
//
// The poller hands an order to the instrument once and marks it downloaded;
// it is never offered again. When the machine loses it (worklist cleared, a
// download that was ACKed but never took) the operator needs a way to push it
// again. The contract:
//   • the WHOLE order goes, not just the un-downloaded part,
//   • the rows are read from HMIS afresh, so a test added since the poll is
//     included — and the store is updated to match,
//   • when HMIS has nothing for the barcode now, the cached order is sent,
//   • an unknown barcode is null; a link that is down, or an HL7 analyzer
//     (query-reply only), is a plain-language error and nothing is sent,
//   • a failed push does not mark the order downloaded.
//   Run:  npx tsx test/order-resend.test.ts

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'lab-resend-'));

const row = (sampleId: string, code: string, labResultId: number) => ({
  SampleID: sampleId,
  eqIdntifier: code,
  equipmentCode: 'ZHFC02',
  equipmentId: 177336856,
  labResultId,
  labServiceId: 3141,
  parameterId: labResultId % 100,
  ipAddress: '10.20.1.53',
  portNo: '4001',
  labServiceName: code,
});

// What HMIS answers for the per-barcode lookup the re-send makes. Mutated by
// the steps below; a bulk poll (empty sampleId) always offers GLU + CREA.
let lookupRows: unknown[] = [];
let lookupThrows = false;
const hmis = {
  async getPending(q: { sampleId: string }) {
    if (q.sampleId) {
      if (lookupThrows) throw new Error('HMIS unreachable');
      return { status: 'success', data: lookupRows };
    }
    return { status: 'success', data: [row('SF2609170001', 'GLU', 900001), row('SF2609170001', 'CREA', 900002)] };
  },
  async acknowledge() {},
  async postResults(rows: unknown[]) {
    return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
  },
} as unknown as HmisClient;

const baseCfg = {
  id: 'vitros-250-test',
  equipmentCode: 'ZHFC02',
  extraEquipmentCodes: [],
  equipmentId: 177336856,
  protocol: 'kermit',
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: 15254 },
  sendDemographics: false,
  hostQuery: false,
  sendDate: false,
  orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: ['SF'], excludeTestCodes: [] },
  qc: { sampleIdPrefixes: [], sampleIdRegex: null },
  testCodeAliases: {},
  astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
  kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
  filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
  hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
};

type Inner = {
  pollOrders(): Promise<void>;
  transport: { connected: boolean };
  link: { sendOrders(o: Array<{ sampleId: string; testCodes: string[] }>): Promise<void> };
  orders: { get(b: string): { downloaded: string[]; testCodes: string[]; source: string } | null };
};

const rt = new AnalyzerRuntime(baseCfg as unknown as AnalyzerConfig, hmis, dir, quiet);
const inner = rt as unknown as Inner;
let connected = true;
Object.defineProperty(inner.transport, 'connected', { get: () => connected, configurable: true });
const sent: Array<{ sampleId: string; testCodes: string[] }> = [];
let linkFails = false;
inner.link.sendOrders = async (orders) => {
  if (linkFails) throw new Error('Kermit: no ACK after 5 retries');
  sent.push(...orders);
};

// ---- 0) the poller downloads the order once ------------------------------
await inner.pollOrders();
assert.equal(sent.length, 1, 'the poll pushed the order');
assert.deepEqual(sent[0]!.testCodes, ['GLU', 'CREA']);
await inner.pollOrders();
assert.equal(sent.length, 1, 'a second poll does not offer it again — this is why Re-send exists');
console.log('✓ the poller hands an order over once and never again');

// ---- 1) re-send pushes the whole order, read from HMIS -------------------
lookupRows = [row('SF2609170001', 'GLU', 900001), row('SF2609170001', 'CREA', 900002), row('SF2609170001', 'UREA', 900003)];
const r1 = await rt.resendOrder('sf2609170001');
assert.ok(r1, 'a known barcode is re-sent');
assert.equal(r1.source, 'hmis');
assert.deepEqual(r1.tests, ['GLU', 'CREA', 'UREA'], 'the whole order, including the test HMIS added since the poll');
assert.equal(sent.length, 2);
assert.equal(sent[1]!.sampleId, 'SF2609170001', 'the barcode goes as HMIS spells it');
const stored = inner.orders.get('SF2609170001')!;
assert.deepEqual(stored.testCodes, ['GLU', 'CREA', 'UREA'], 'the store now matches HMIS');
assert.deepEqual(stored.downloaded, ['GLU', 'CREA', 'UREA'], 'and every test is marked downloaded');
assert.equal(stored.source, 'resend');
console.log('✓ re-send pushes every test, with the rows read from HMIS afresh');

// ---- 2) HMIS has nothing now → the cached order goes ---------------------
lookupRows = [];
const r2 = await rt.resendOrder('SF2609170001');
assert.ok(r2);
assert.equal(r2.source, 'store');
assert.deepEqual(r2.tests, ['GLU', 'CREA', 'UREA']);
assert.equal(sent.length, 3);
console.log('✓ when HMIS offers nothing, the cached order is sent and the report says so');

// ---- 3) HMIS down → the cached order goes too ----------------------------
lookupThrows = true;
const r3 = await rt.resendOrder('SF2609170001');
lookupThrows = false;
assert.equal(r3?.source, 'store');
assert.equal(sent.length, 4);
console.log('✓ an HMIS outage does not block a re-send of a cached order');

// ---- 4) unknown barcode → null, nothing sent ------------------------------
assert.equal(await rt.resendOrder('SF9999999999'), null);
assert.equal(sent.length, 4);
console.log('✓ an unknown barcode is refused without touching the analyzer');

// ---- 5) outside downloadPrefixes → refused ---------------------------------
lookupRows = [row('LB2609170001', 'GLU', 900010)];
await assert.rejects(() => rt.resendOrder('LB2609170001'), /downloadPrefixes/);
assert.equal(sent.length, 4);
console.log('✓ a barcode this analyzer does not run is refused');

// ---- 6) link down → refused before HMIS is asked --------------------------
connected = false;
await assert.rejects(() => rt.resendOrder('SF2609170001'), /link is down/);
connected = true;
assert.equal(sent.length, 4);
console.log('✓ a down link is reported, not attempted');

// ---- 7) the analyzer refuses → error, and NOT marked downloaded ----------
lookupRows = [row('SF2609170001', 'GLU', 900001), row('SF2609170001', 'CREA', 900002), row('SF2609170001', 'UREA', 900003), row('SF2609170001', 'NA', 900004)];
linkFails = true;
await assert.rejects(() => rt.resendOrder('SF2609170001'), /did not accept/);
linkFails = false;
const after = inner.orders.get('SF2609170001')!;
assert.ok(!after.downloaded.includes('NA'), 'the test the analyzer never took stays un-downloaded');
await inner.pollOrders();
// The bulk poll only knows GLU + CREA, so NA is not offered there; it is the
// operator's next Re-send (or the instrument's own query) that carries it.
console.log('✓ a failed push leaves the new test un-downloaded');

// ---- 8) HL7 analyzers cannot be pushed ------------------------------------
const hl7 = new AnalyzerRuntime(
  { ...baseCfg, id: 'h360-test', protocol: 'hl7', transport: { ...baseCfg.transport, port: 15255 } } as unknown as AnalyzerConfig,
  hmis,
  mkdtempSync(join(tmpdir(), 'lab-resend-hl7-')),
  quiet,
);
await assert.rejects(() => hl7.resendOrder('SF2609170001'), /host query/);
await hl7.stop();
console.log('✓ an HL7 (query-reply only) analyzer is refused with the reason');

await rt.stop();
rmSync(dir, { recursive: true, force: true });
console.log('\nALL ORDER-RESEND TESTS PASSED');
