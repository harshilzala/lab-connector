import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';
import type { HmisResultUpload, LisInboundResultRow } from '../src/types.js';

// =============================================================================
// The console's "Force" push (config Force_Hmis).
//
// WHY. On 2026-09-12 HMIS withdrew PL2609120001's CBC rows from the pending
// list between 19:11 and 19:40, before the interface had filed 11 of the 22
// values. The normal filing pass can only file into a row HMIS is offering,
// so those values sat in the staged store while the report stayed blank.
// Force sends everything the sample holds — filed values again, waiting ones
// mapped from the order rows cached for the barcode and the parameter
// catalogue — and never asks HMIS for pending rows first.
//
// The contract pinned here:
//   • getPending is NOT called;
//   • a value already filed is sent again;
//   • a waiting value whose row HMIS withdrew is rebuilt from the catalogue
//     (labResultId borrowed from the sample's own rows) and sent;
//   • a code the catalogue has never seen is reported as unresolved, not
//     guessed;
//   • the rows sent are acknowledged, as a normal filing is.
//
//   npx tsx test/force-push.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

const BARCODE = 'PL2609120001';
const LAB_RESULT_ID = 93122704;
const row = (identifier: string, parameterId: number) => ({
  SampleID: BARCODE,
  eqIdntifier: identifier,
  equipmentCode: 'ZHPN001',
  equipmentId: 224302864,
  labResultId: LAB_RESULT_ID,
  labServiceId: 3141,
  parameterId,
  ipAddress: '10.20.4.50',
  portNo: '5100',
  labServiceName: 'CBC',
  resultType: 'PARAMETER',
});

let pendingCalls = 0;
const posted: LisInboundResultRow[][] = [];
const acknowledged: unknown[][] = [];
/** What the gateway currently offers for the sample — set per phase. */
let offered: ReturnType<typeof row>[] = [];

const hmis = {
  async getPending() {
    pendingCalls++;
    return { status: 'success', data: offered };
  },
  async acknowledge(rows: unknown[]) {
    acknowledged.push(rows);
  },
  async postResults(rows: LisInboundResultRow[]) {
    posted.push(rows);
    return { status: 'success', message: 'data transmitted successfully', successData: rows.map(() => ({})), filed: rows.length };
  },
} as unknown as HmisClient;

const cfg = {
  id: 'force-test',
  equipmentCode: 'ZHPN001',
  extraEquipmentCodes: [],
  equipmentId: 224302864,
  protocol: 'hl7',
  transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15255 },
  sendDemographics: false,
  hostQuery: false,
  sendDate: false,
  orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: false, downloadPrefixes: [] },
  qc: { sampleIdPrefixes: [], sampleIdRegex: null, patientPrefixes: [], upload: false },
  testCodeAliases: { HGB: 'HAEMOGLOBIN' },
  ignoreTestCodes: [],
  allowTestCodes: [],
  testCodeScale: {},
  excludeIdentifiers: [],
  excludeParameterIds: [],
  fillMissingOrderRows: false, // Force must rebuild regardless of this
  filing: { mode: 'staged', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
  astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'atellica', sampleIdFrom: 'order' },
  kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
  hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
  gh900: { fileOnSamplingError: false },
} as unknown as AnalyzerConfig;

const dir = mkdtempSync(join(tmpdir(), 'lab-force-'));
const rt = new AnalyzerRuntime(cfg, hmis, dir, quiet);
const inner = rt as unknown as {
  onMessage(m: unknown): Promise<void>;
  parameters: { learn(rows: unknown[], o?: unknown): void };
  orders: { upsert(barcode: string, pending: unknown, source: string): unknown };
  staged: { get(b: string): { values: Record<string, { filedAt: string | null }> } | null };
  resolveOrderRows(b: string, o?: { refresh?: boolean }): Promise<unknown[]>;
};

// ---- phase 1: HMIS offers MCV and HAEMOGLOBIN; the catalogue also learns PLT
// from another sample of the same service, the way the order poll does.
offered = [row('MCV', 2127), row('HAEMOGLOBIN', 2130)];
const otherSample = { ...row('PLT', 2168), SampleID: 'PL2609120002' };
const { groupPendingByBarcode } = await import('../src/hmis/pending.js');
for (const [, pending] of groupPendingByBarcode({ status: 'success', data: [...offered, otherSample] }, { eqCode: 'ZHPN001', equipmentId: 224302864, ipAddress: '', portNo: '' })) {
  inner.parameters.learn((pending as { ackItems: unknown[] }).ackItems);
  inner.orders.upsert((pending as { sampleId: string }).sampleId, pending, 'poll');
}

// The instrument reports four values. Normal filing files MCV and HGB (via
// its alias); PLT and NEU% wait.
const upload: HmisResultUpload = {
  equipmentId: 224302864,
  eqCode: 'ZHPN001',
  barcode: BARCODE,
  isQc: false,
  messageId: 'm1',
  results: [
    { testCode: 'MCV', value: '95.7', unit: 'fL', abnormalFlag: 'N', status: 'F', completedAt: '20260912184749' },
    { testCode: 'HGB', value: '15.8', unit: 'g/dL', abnormalFlag: 'N', status: 'F', completedAt: '20260912184749' },
    { testCode: 'PLT', value: '348', unit: '10*3/uL', abnormalFlag: 'H', status: 'F', completedAt: '20260912184749' },
    { testCode: 'NEU%', value: '35.7', unit: '%', abnormalFlag: 'L', status: 'F', completedAt: '20260912184749' },
  ],
};
await inner.onMessage({ protocol: 'hl7', isQc: false, sampleId: BARCODE, queries: [], results: upload.results.map((r) => ({ ...r, sampleId: BARCODE, referenceRange: null, instrument: 'BC-5150' })), raw: '' });
await new Promise((r) => setTimeout(r, 50));

const before = inner.staged.get(BARCODE)!;
assert.ok(before.values.MCV!.filedAt && before.values.HGB!.filedAt, 'normal pass filed MCV and HGB');
assert.ok(!before.values.PLT!.filedAt && !before.values['NEU%']!.filedAt, 'PLT and NEU% wait — HMIS offers no row');
console.log(`${G} normal filing: MCV + HGB filed, PLT + NEU% waiting (${posted.length} upload so far)`);

// ---- phase 2: HMIS withdraws everything (the 12-09 collapse). Force.
offered = [];
const pendingBefore = pendingCalls;
const postsBefore = posted.length;
const acksBefore = acknowledged.length;

const report = await rt.stagedForce(BARCODE);
assert.ok(report, 'known barcode → a report');
assert.equal(pendingCalls, pendingBefore, 'Force never asks HMIS for pending rows');
assert.equal(posted.length, postsBefore + 1, 'exactly one upload');
const sent = posted[posted.length - 1]!;
const byCode = new Map(report!.rows.map((x) => [x.testCode, x]));
const byIdent = new Map(sent.map((r) => [r.identifier, r]));
assert.ok(byCode.has('MCV') && byCode.has('HGB'), 'already-filed values are sent again');
assert.equal(byCode.get('HGB')!.identifier, 'HAEMOGLOBIN', 'alias applied on the forced row');
assert.equal(byCode.get('PLT')!.parameterId, 2168, 'PLT rebuilt from the catalogue even with fillMissingOrderRows off');
assert.equal(byIdent.get('PLT')!.labResultId, LAB_RESULT_ID, "rebuilt row borrows the sample's own labResultId");
assert.ok(!byCode.has('NEU%'), 'a code the catalogue never saw is NOT sent');
assert.deepEqual(report!.unresolved, ['NEU%'], 'and is reported as unresolved');
assert.equal(report!.sent, 3);
assert.equal(report!.accepted, 3);
assert.equal(report!.values, 4);
assert.equal(acknowledged.length, acksBefore + 1, 'the rows sent are acknowledged');
const after = inner.staged.get(BARCODE)!;
assert.ok(after.values.PLT!.filedAt, 'PLT marked filed after the forced push');
assert.ok(!after.values['NEU%']!.filedAt, 'NEU% still waiting');
console.log(`${G} force: sent ${report!.sent} (MCV, HGB, PLT) without a pending lookup; unresolved: ${report!.unresolved.join(', ')}`);

assert.equal(await rt.stagedForce('NOPE'), null, 'unknown barcode → null');
console.log(`${G} unknown barcode → null`);

rmSync(dir, { recursive: true, force: true });
console.log('\nALL FORCE-PUSH TESTS PASSED\n');
