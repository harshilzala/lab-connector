import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// orderPoll.downloadPrefixes — program only the barcodes this analyzer runs.
//
// WHY. HMIS lists rows under ZCCEQ003 for six barcode prefixes, but the VITROS
// 250 only ever runs ZC tubes. Measured over 2026-09-06/07: the connector
// programmed 1014 distinct samples onto it (670 LB, 139 ZN, 58 ZS, 58 ZV, 53
// ZC, 30 SF, 6 CF) and the analyzer returned results for 53 — every one of
// them ZC, and not one for any other prefix. The whole legacy capture says the
// same: 48 orders sent, all ZC, 84 result samples, all ZC.
//
// The legacy Vitros250.exe applied SamplePrefix=ZC to BOTH directions
// ("sample_id LIKE 'ZC%'"). This connector applied it only to results, via
// qc.patientPrefixes — so it filled the instrument's program list with tubes
// it never sees, and any result that did come back on those barcodes would
// have been discarded as QC anyway.
//
// The contract pinned here:
//   • a barcode outside downloadPrefixes is NEVER sent to the analyzer,
//   • but its rows ARE still cached, so a result can be joined if one arrives,
//   • an empty list means "download everything", i.e. no behaviour change for
//     the analyzers that do not set it.
//
//   npx tsx test/download-prefixes.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

/** The prefix mix HMIS actually returns for ZCCEQ003, one row each. */
const BARCODES = ['ZC2609070005', 'LB2609070198', 'ZN2609070006', 'ZS2609070185', 'ZV2609070007', 'SF2609070062', 'CF2609070001'];

const pendingBody = () => ({
  status: 'success',
  data: BARCODES.map((SampleID, i) => ({
    SampleID,
    eqIdntifier: '32',
    equipmentCode: 'ZCCEQ003',
    equipmentId: 29688657,
    labResultId: 92800000 + i,
    labServiceId: 64,
    parameterId: null,
    ipAddress: '10.12.19.41',
    portNo: '4001',
    labServiceName: 'Glucose',
  })),
});

const hmis = {
  async getPending() {
    return pendingBody();
  },
  async acknowledge() {},
  async postResults() {
    return { status: 'success', message: 'ok', successData: [], filed: 0 };
  },
} as unknown as HmisClient;

const baseCfg = {
  id: 'vitros-250-prefix-test',
  equipmentCode: 'ZCCEQ003',
  extraEquipmentCodes: [],
  equipmentId: 29688657,
  protocol: 'kermit',
  transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15254 },
  sendDemographics: true,
  hostQuery: false,
  sendDate: false,
  qc: { sampleIdPrefixes: [], sampleIdRegex: null },
  testCodeAliases: {},
  astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
  kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
  // The schema defaults, spelled out. This fixture is cast straight to
  // AnalyzerConfig, so nothing type-checks it and a field added to the schema
  // later goes missing here silently — which is how it came to throw on
  // `cfg.filing.mode` in the runtime constructor.
  filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
  hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
} as unknown as AnalyzerConfig;

/** One poll tick against a runtime whose link and transport are stubbed out. */
async function pollWith(downloadPrefixes: string[]): Promise<{ sent: string[]; stored: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'lab-prefix-'));
  const cfg = {
    ...baseCfg,
    orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes },
  } as unknown as AnalyzerConfig;

  const rt = new AnalyzerRuntime(cfg, hmis, dir, quiet);
  const inner = rt as unknown as {
    pollOrders(): Promise<void>;
    transport: { connected: boolean };
    link: { sendOrders(o: Array<{ sampleId: string }>): Promise<void> };
    orders: { count(): number };
  };
  Object.defineProperty(inner.transport, 'connected', { get: () => true, configurable: true });

  const sent: string[] = [];
  inner.link.sendOrders = async (orders) => {
    for (const o of orders) sent.push(o.sampleId);
  };

  await inner.pollOrders();
  const stored = inner.orders.count();
  rmSync(dir, { recursive: true, force: true });
  return { sent, stored };
}

console.log('\n[1] downloadPrefixes: ["ZC"] — only the ZC tube is programmed');
const zcOnly = await pollWith(['ZC']);
assert.deepEqual(zcOnly.sent, ['ZC2609070005'], `expected only the ZC barcode, got ${zcOnly.sent.join(', ')}`);
console.log(`  ${G} sent to the analyzer: ${zcOnly.sent.join(', ')}`);
console.log(`  ${G} not sent: ${BARCODES.filter((b) => !zcOnly.sent.includes(b)).join(', ')}`);

assert.equal(zcOnly.stored, BARCODES.length, `all ${BARCODES.length} barcodes must still be cached, got ${zcOnly.stored}`);
console.log(`  ${G} all ${zcOnly.stored} barcodes still cached in the order store for result-time joins`);

console.log('\n[2] Matching is case-insensitive on the prefix');
const lower = await pollWith(['zc']);
assert.deepEqual(lower.sent, ['ZC2609070005']);
console.log(`  ${G} "zc" matches ZC2609070005`);

console.log('\n[3] An empty list downloads everything — unchanged behaviour');
const all = await pollWith([]);
assert.deepEqual(all.sent.sort(), [...BARCODES].sort(), `expected every barcode, got ${all.sent.join(', ')}`);
console.log(`  ${G} all ${all.sent.length} barcodes programmed when no prefix list is set`);

console.log('\n[4] Several prefixes are allowed');
const two = await pollWith(['ZC', 'SF']);
assert.deepEqual(two.sent.sort(), ['SF2609070062', 'ZC2609070005']);
console.log(`  ${G} ["ZC","SF"] sends ${two.sent.sort().join(', ')}`);

console.log('\nALL DOWNLOAD-PREFIX TESTS PASSED\n');
