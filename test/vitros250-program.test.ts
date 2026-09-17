import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// What the VITROS 250 is programmed with: orderPoll.excludeTestCodes and the
// whole-panel download.
//
// WHY. 16–17 Sep 2026, Shela: every LFT tube the connector programmed was keyed
// in by hand on the analyzer (result records: fluid '0', operator "TP"), while
// the tubes sent without HMIS's derived LFT values 107/108/109 ran from the
// download (fluid '4', no operator). The retired host's capture says the same
// — June 2026, 30 such programs re-keyed — and shows the cure: on 19 Jun those
// samples were re-sent WITHOUT 107/108/109 and every one ran from the download.
// The analyzer drops a program that names an assay it does not have.
//
// The same capture shows a second download for a sample REPLACING the first
// (SF2606190004: 15 tests, then 12 — it ran the 12). This connector used to
// send only the tests added since the last download, which on that instrument
// would have wiped the ones already programmed.
//
// Pinned here:
//   • a code in excludeTestCodes is never sent, but its row is still stored,
//   • a sample whose only new codes are excluded is not sent at all,
//   • a link that replaces programs is given the WHOLE panel on every send,
//   • a link that does not is still given only the delta.
//
//   npx tsx test/vitros250-program.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

const BARCODE = 'SF2609170013';
/** HMIS service 3221 as the gateway lists it: three assays and three derived values. */
const LFT = ['36', '37', '89', '107', '108', '109'];

let rows: string[] = [];
const pendingBody = () => ({
  status: 'success',
  data: rows.map((identifier, i) => ({
    sampleID: BARCODE,
    identifier,
    equipmentCode: 'ZHFC02',
    equipmentId: 177336856,
    labResultId: 93333534 + (identifier === '46' ? 1 : 0),
    labServiceId: identifier === '46' ? 104 : 3221,
    parameterId: 2220 + i,
    ipAddress: '10.20.1.53',
    portNo: '4001',
    resultType: 'PARAMETER',
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
  id: 'vitros-250-program-test',
  equipmentCode: 'ZHFC02',
  extraEquipmentCodes: [],
  equipmentId: 177336856,
  protocol: 'kermit',
  transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15254 },
  sendDemographics: true,
  hostQuery: false,
  sendDate: false,
  qc: { sampleIdPrefixes: [], sampleIdRegex: null },
  testCodeAliases: {},
  excludeIdentifiers: [],
  excludeParameterIds: [],
  astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
  kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
  filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
  hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
} as unknown as AnalyzerConfig;

interface Harness {
  poll(): Promise<string[][]>;
  storedCodes(): string[];
  setReplaces(v: boolean): void;
  close(): void;
}

/** A runtime whose link and transport are stubbed; each poll returns the panels sent. */
function harness(excludeTestCodes: string[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'lab-250-program-'));
  const cfg = {
    ...baseCfg,
    orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: [], excludeTestCodes },
  } as unknown as AnalyzerConfig;
  const rt = new AnalyzerRuntime(cfg, hmis, dir, quiet);
  const inner = rt as unknown as {
    pollOrders(): Promise<void>;
    transport: { connected: boolean };
    link: { sendOrders(o: Array<{ sampleId: string; testCodes: string[] }>): Promise<void>; downloadReplacesProgram?: boolean };
    orders: { get(b: string): { testCodes: string[] } | null };
  };
  Object.defineProperty(inner.transport, 'connected', { get: () => true, configurable: true });
  let sent: string[][] = [];
  inner.link.sendOrders = async (orders) => {
    for (const o of orders) sent.push(o.testCodes);
  };
  return {
    async poll() {
      sent = [];
      await inner.pollOrders();
      return sent;
    },
    storedCodes: () => inner.orders.get(BARCODE)?.testCodes ?? [],
    setReplaces: (v) => Object.defineProperty(inner.link, 'downloadReplacesProgram', { value: v, configurable: true }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

console.log('\n[1] excludeTestCodes: the derived values never reach the analyzer, their rows are still stored');
{
  rows = LFT;
  const h = harness(['107', '108', '109']);
  const sent = await h.poll();
  assert.deepEqual(sent, [['36', '37', '89']], `expected one program of 36/37/89, got ${JSON.stringify(sent)}`);
  console.log(`  ${G} programmed: ${sent[0]!.join(',')}`);
  assert.deepEqual(h.storedCodes().sort(), [...LFT].sort());
  console.log(`  ${G} all six rows cached for result-time joins: ${h.storedCodes().join(',')}`);

  const again = await h.poll();
  assert.deepEqual(again, [], `the same rows must not be sent twice, got ${JSON.stringify(again)}`);
  console.log(`  ${G} nothing new on the next tick — the excluded codes never count as waiting`);
  h.close();
}

console.log('\n[2] A sample whose only tests are excluded is not sent at all');
{
  rows = ['107', '108', '109'];
  const h = harness(['107', '108', '109']);
  const sent = await h.poll();
  assert.deepEqual(sent, []);
  console.log(`  ${G} no program for a panel of nothing but excluded codes`);
  h.close();
}

console.log('\n[3] A link that replaces programs (VITROS 250) is given the WHOLE panel when a test is added');
{
  rows = LFT;
  const h = harness(['107', '108', '109']);
  assert.deepEqual(await h.poll(), [['36', '37', '89']]);
  rows = [...LFT, '46'];
  const sent = await h.poll();
  assert.deepEqual(sent, [['36', '37', '89', '46']], `expected the whole panel again, got ${JSON.stringify(sent)}`);
  console.log(`  ${G} 46 added → sent ${sent[0]!.join(',')} (not just 46)`);
  assert.deepEqual(await h.poll(), []);
  console.log(`  ${G} and nothing further once it is programmed`);
  h.close();
}

console.log('\n[4] A link that does NOT replace programs still gets only the delta — unchanged behaviour');
{
  rows = LFT;
  const h = harness([]);
  h.setReplaces(false);
  assert.deepEqual(await h.poll(), [LFT]);
  rows = [...LFT, '46'];
  const sent = await h.poll();
  assert.deepEqual(sent, [['46']], `expected just the added test, got ${JSON.stringify(sent)}`);
  console.log(`  ${G} 46 added → sent ${sent[0]!.join(',')}`);
  h.close();
}

console.log('\nALL VITROS 250 PROGRAM TESTS PASSED\n');
