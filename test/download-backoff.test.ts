import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// Pins the order-download circuit breaker.
//
// A VITROS 250 that is powered off still holds a healthy TCP socket through its
// Moxa, so every download runs its full Kermit retry budget (~50s) before
// failing. Left alone that floods the log AND starves the 30s order poll, so
// HMIS stops being read for that analyzer entirely — which is exactly what was
// observed in production: 456 ACK timeouts, 91 failed downloads, and ZHFC02
// polled 8 times against 130 for the healthy machines.
//
// The contract this test defends:
//   • pushes stop after a few consecutive failures,
//   • COLLECTION never stops — orders keep reaching the store while paused,
//   • the backoff doubles, so a machine left off settles at a slow retry,
//   • any sign of life (a message, a reconnect) resumes immediately.
//   Run:  npx tsx test/download-backoff.test.ts

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'lab-backoff-'));

// One pending CBC row per poll, on a barcode that changes so each tick has
// genuinely new work to push.
let barcodeSeq = 0;
const pendingBody = () => {
  barcodeSeq++;
  return {
    status: 'success',
    data: [
      {
        SampleID: `SF26090${String(barcodeSeq).padStart(5, '0')}`,
        eqIdntifier: 'GLU',
        equipmentCode: 'ZHFC02',
        equipmentId: 177336856,
        labResultId: 900000 + barcodeSeq,
        labServiceId: 3141,
        parameterId: 42,
        ipAddress: '10.20.1.53',
        portNo: '4001',
        labServiceName: 'Glucose',
      },
    ],
  };
};

let getPendingCalls = 0;
const hmis = {
  async getPending() {
    getPendingCalls++;
    return pendingBody();
  },
  async acknowledge() {},
  async postResults(rows: unknown[]) {
    return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
  },
} as unknown as HmisClient;

const cfg = {
  id: 'vitros-250-test',
  equipmentCode: 'ZHFC02',
  extraEquipmentCodes: [],
  equipmentId: 177336856,
  protocol: 'kermit',
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: 15253 },
  sendDemographics: false,
  hostQuery: false,
  sendDate: false,
  orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: [] },
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

const rt = new AnalyzerRuntime(cfg, hmis, dir, quiet);
const inner = rt as unknown as {
  pollOrders(): Promise<void>;
  transport: { connected: boolean; emit(e: string): void };
  link: { sendOrders(o: unknown[]): Promise<void> };
  orders: { count(): number };
  downloadPausedUntil: number;
  downloadFailStreak: number;
};

// The instrument holds a socket but never answers — exactly the Moxa case:
// `connected` is true throughout, which is why the breaker cannot simply lean
// on the transport's own state.
Object.defineProperty(inner.transport, 'connected', { get: () => true, configurable: true });
let sendAttempts = 0;
let instrumentAlive = false;
inner.link.sendOrders = async () => {
  sendAttempts++;
  if (!instrumentAlive) throw new Error('Kermit: no ACK after 5 retries');
};

const poll = () => inner.pollOrders();

// ---- 1) the breaker opens after a few failures ----------------------------
await poll();
await poll();
await poll();
assert.equal(sendAttempts, 3, 'three ticks, three attempts before the breaker opens');
assert.ok(inner.downloadPausedUntil > Date.now(), 'downloads are now suspended');
console.log(`✓ breaker opened after ${sendAttempts} consecutive failures`);

// ---- 2) pushes stop, but COLLECTION carries on ----------------------------
const storedBefore = inner.orders.count();
const hmisBefore = getPendingCalls;
await poll();
await poll();
await poll();
assert.equal(sendAttempts, 3, 'no further pushes while suspended');
assert.ok(getPendingCalls > hmisBefore, 'HMIS is still being polled');
assert.ok(inner.orders.count() > storedBefore, 'orders still reach the store');
console.log(
  `✓ while paused: ${getPendingCalls - hmisBefore} more HMIS polls, ` +
    `${inner.orders.count() - storedBefore} more orders stored, 0 extra pushes`,
);

// ---- 3) the backoff doubles ------------------------------------------------
const firstWait = inner.downloadPausedUntil - Date.now();
inner.downloadPausedUntil = Date.now() - 1; // pretend the pause elapsed
await poll(); // one attempt through, fails again, re-pauses longer
assert.equal(sendAttempts, 4, 'exactly one probe attempt after the pause elapses');
const secondWait = inner.downloadPausedUntil - Date.now();
assert.ok(secondWait > firstWait, `backoff must grow: ${firstWait}ms → ${secondWait}ms`);
console.log(`✓ backoff doubles: ${Math.round(firstWait / 1000)}s → ${Math.round(secondWait / 1000)}s`);

// ---- 4) a message from the analyzer resumes immediately -------------------
assert.ok(inner.downloadPausedUntil > Date.now(), 'still paused before the signal');
(rt as unknown as { onMessage(m: unknown): Promise<void> }).onMessage({
  protocol: 'kermit',
  sender: 'VITROS250',
  patient: null,
  queries: [],
  results: [],
  raw: '',
});
assert.equal(inner.downloadPausedUntil, 0, 'an inbound message closes the breaker');
assert.equal(inner.downloadFailStreak, 0, 'and clears the streak');
console.log('✓ an inbound message from the analyzer resumes downloads at once');

// ---- 5) recovery: the held orders go out ----------------------------------
instrumentAlive = true;
const before = sendAttempts;
await poll();
assert.ok(sendAttempts > before, 'pushing resumes');
assert.equal(inner.downloadFailStreak, 0, 'a success keeps the streak clear');
assert.equal(inner.downloadPausedUntil, 0, 'and the breaker stays closed');
console.log('✓ once the instrument answers, orders flow again');

// ---- 6) a reconnect also resumes ------------------------------------------
instrumentAlive = false;
await poll();
await poll();
await poll();
assert.ok(inner.downloadPausedUntil > Date.now(), 'breaker re-opens on a fresh failure run');
inner.transport.emit('connect');
assert.equal(inner.downloadPausedUntil, 0, 'a reconnect closes the breaker');
console.log('✓ a transport reconnect resumes downloads at once');

await rt.stop();
rmSync(dir, { recursive: true, force: true });
console.log('\nALL DOWNLOAD-BACKOFF TESTS PASSED');
