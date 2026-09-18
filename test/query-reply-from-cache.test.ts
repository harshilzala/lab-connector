import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { loadConfig } from '../src/config.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { HostQuery } from '../src/types.js';

// Pins the host-query reply when HMIS has withdrawn a sample's rows.
//
// LB2609180027 on the Ahmedabad U-WAM, 2026-09-17: the order poll cached 21
// rows at 18:42Z; at 19:08Z the U-WAM queried the barcode, the live per-sample
// lookup returned nothing, and the connector replied with an EMPTY download —
// while 27 values were later filed from exactly those cached rows. HMIS drops
// rows from its pending list and offers them again; the connector's order
// store is the durable record. The contract this test defends:
//   • a barcode HMIS cannot see right now is still answered from the cache,
//   • a barcode neither HMIS nor the cache knows gets the empty download,
//   • a barcode HMIS does see is answered from HMIS as before.
//   Run:  npx tsx test/query-reply-from-cache.test.ts

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'lab-query-cache-'));

writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://hmis.test/live/portal', siteId: '2' },
    analyzers: [
      {
        id: 'sysmex-uwam',
        profile: 'sysmex-uwam',
        equipmentCode: 'EC014',
        transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: 15254 },
      },
    ],
  }),
);
const cfg = loadConfig(join(dir, 'config.json')).analyzers[0]!;
assert.equal(cfg.hostQuery, true, 'the U-WAM profile answers host queries');

const row = (SampleID: string, eqIdntifier: string, parameterId: number) => ({
  SampleID, eqIdntifier, parameterId,
  equipmentCode: 'EC014', equipmentId: 19232485, labResultId: 93355178, labServiceId: 414,
  resultType: 'PARAMETER', ipAddress: '10.11.102.13', portNo: '2031',
  labServiceName: 'Urine examination(Reflectance photometry & flowcytometry)',
});
const CACHED = 'LB2609180027';
const LIVE = 'LB2609180099';
const UNKNOWN = 'LB2609180003';

// What HMIS answers: the date POLL lists the cached barcode; a per-sample
// lookup lists only LIVE — the cached barcode's rows have been withdrawn.
const hmis = {
  async getPending(q: { sampleId?: string }) {
    if (!q.sampleId) return { status: 'success', data: [row(CACHED, 'WBC Clumps', 5949), row(CACHED, 'SPERM', 5959)] };
    if (q.sampleId === LIVE) return { status: 'success', data: [row(LIVE, 'YLC', 5958)] };
    return { status: 'success', data: [] };
  },
  async acknowledge() {},
  async postResults(rows: unknown[]) {
    return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
  },
} as unknown as HmisClient;

const rt = new AnalyzerRuntime(cfg, hmis, dir, quiet);
const inner = rt as unknown as {
  pollOrders(): Promise<void>;
  answerQuery(q: HostQuery): Promise<void>;
  link: { sendOrders(o: unknown[]): Promise<void> };
  orders: { get(b: string): { rows: unknown[]; testCodes: string[] } | null };
};
const sent: unknown[][] = [];
inner.link.sendOrders = async (o) => { sent.push(o); };

// ---- 1) the poll caches the rows HMIS will later withdraw ----------------
await inner.pollOrders();
assert.deepEqual(inner.orders.get(CACHED)?.testCodes, ['WBC Clumps', 'SPERM'], 'poll cached the rows');

// ---- 2) HMIS cannot see the barcode now — answered from the cache --------
sent.length = 0;
await inner.answerQuery({ sampleId: CACHED, testCodes: [], specimenIdField: CACHED });
assert.equal(sent.length, 1, 'one reply');
const fromCache = sent[0]![0] as { sampleId: string; testCodes: string[]; queryReply: boolean } | undefined;
assert.ok(fromCache, 'the reply carries an order, not the empty download');
assert.equal(fromCache.sampleId, CACHED);
assert.deepEqual(fromCache.testCodes, ['WBC Clumps', 'SPERM'], 'the cached tests are downloaded');
assert.equal(fromCache.queryReply, true);
console.log('✓ a barcode HMIS has withdrawn is answered from the order store');

// ---- 3) neither side knows the barcode — empty download ------------------
sent.length = 0;
await inner.answerQuery({ sampleId: UNKNOWN, testCodes: [], specimenIdField: UNKNOWN });
assert.deepEqual(sent, [[]], 'empty download for a barcode with no order anywhere');
console.log('✓ an unknown barcode still gets the empty download');

// ---- 4) HMIS sees the barcode — answered from HMIS as before -------------
sent.length = 0;
await inner.answerQuery({ sampleId: LIVE, testCodes: [], specimenIdField: LIVE });
const fromHmis = sent[0]![0] as { testCodes: string[] };
assert.deepEqual(fromHmis.testCodes, ['YLC'], 'live rows win when HMIS has them');
console.log('✓ a barcode HMIS lists is answered from HMIS');

rmSync(dir, { recursive: true, force: true });
console.log('query-reply-from-cache: all checks passed');
