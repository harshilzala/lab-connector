import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// allowTestCodes also filters the PENDING ROWS HMIS offers — not just results.
//
// WHY. HMIS raises a pending row for every parameter of a CBC, and 16 of them
// are registered under a bare number (290, 460, 76 …) that the BC-6000 never
// reports: the interface is scoped to 22 analyzer mnemonics (config.json,
// allowTestCodes). On 2026-09-11 all 43 CH-orders of the day carried those 16
// rows. The connector never files them, so they sat in the order store, were
// learned by the parameter catalogue and made every CBC look incomplete.
//
// The lab's decision (2026-09-11): filter them out on the connector side only.
// Contract pinned here:
//   • a row whose identifier is outside allowTestCodes (or the alias spelling
//     testCodeAliases maps an allowed code to) is never stored, never counted;
//   • rows for the 22 are untouched;
//   • a tube offered ONLY non-interfaced rows is not stored at all;
//   • nothing is acknowledged for a dropped row — HMIS is not written to;
//   • an empty allowTestCodes filters nothing (every other analyzer unchanged).
//
//   npx tsx test/bc6000-interfaced-rows.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

const ALLOW = [
  'WBC', 'NEU#', 'LYM#', 'MON#', 'EOS#', 'BAS#', 'NEU%', 'LYM%', 'MON%', 'EOS%', 'BAS%',
  'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'PLT', 'MPV', 'PDW', 'PCT',
];
/** The bare-number identifiers HMIS carries for the CBC service (from CH2609110044). */
const BARE = ['290', '460', '76', '300', '280', '26', '43', '310', '414', '50', '660', '44', '81', '42', '101', '25'];

/** Rows as the gateway returns them for ZCCEQ004, one per identifier. */
const row = (SampleID: string, eqIdntifier: string, i: number) => ({
  SampleID,
  eqIdntifier,
  equipmentCode: 'ZCCEQ004',
  equipmentId: 30285205,
  labResultId: 93087742,
  labServiceId: 3141,
  parameterId: 6000 + i,
  ipAddress: '10.12.19.43',
  portNo: '4001',
  labServiceName: 'CBC',
});

const acknowledged: unknown[] = [];
const hmisWith = (rows: unknown[]) =>
  ({
    async getPending() {
      return { status: 'success', data: rows };
    },
    async acknowledge(items: unknown[]) {
      acknowledged.push(...items);
    },
    async postResults() {
      return { status: 'success', message: 'ok', successData: [], filed: 0 };
    },
  }) as unknown as HmisClient;

const baseCfg = {
  id: 'bc6000-rows-test',
  equipmentCode: 'ZCCEQ004',
  extraEquipmentCodes: [],
  // Schema fields with defaults still have to be present in a hand-built
  // fixture: nothing runs it through the zod schema, so an omission surfaces
  // as a TypeError inside the poll rather than a config error.
  siteIds: [],
  equipmentId: 30285205,
  protocol: 'hl7',
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: 16060 },
  sendDemographics: false,
  hostQuery: false,
  sendDate: false,
  qc: { sampleIdPrefixes: [], sampleIdRegex: null },
  testCodeAliases: { 'RDW-CV': 'RDW' },
  ignoreTestCodes: [],
  testCodeScale: {},
  fillMissingOrderRows: false,
  astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'atellica' },
  kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
  filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
  hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
  orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: false, downloadPrefixes: [], excludeTestCodes: [] },
} as unknown as AnalyzerConfig;

/** One poll tick; returns the identifiers stored per barcode. */
async function pollWith(allowTestCodes: string[], rows: unknown[]): Promise<Map<string, string[]>> {
  const dir = mkdtempSync(join(tmpdir(), 'lab-rows-'));
  const cfg = { ...baseCfg, allowTestCodes } as unknown as AnalyzerConfig;
  const rt = new AnalyzerRuntime(cfg, hmisWith(rows), dir, quiet);
  const inner = rt as unknown as {
    pollOrders(): Promise<void>;
    orders: { count(): number; get(b: string): { rows: Array<{ identifier: string }> } | null };
  };
  await inner.pollOrders();
  const out = new Map<string, string[]>();
  for (const b of ['CH2609110044', 'CH2609110045']) {
    const o = inner.orders.get(b);
    if (o) out.set(b, o.rows.map((r) => r.identifier).sort());
  }
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// A CBC: 4 still-pending mnemonics, the alias spelling RDW, and the 16 numbers.
const FULL = [
  ...['BAS#', 'MON#', 'PCT', 'PDW', 'RDW'].map((id, i) => row('CH2609110044', id, i)),
  ...BARE.map((id, i) => row('CH2609110044', id, 100 + i)),
];
// A tube HMIS offers ONLY non-interfaced rows for.
const NUMBERS_ONLY = BARE.map((id, i) => row('CH2609110045', id, 200 + i));

console.log('\n[1] With the 22-code allow-list, bare-number rows never reach the order store');
{
  const stored = await pollWith(ALLOW, [...FULL, ...NUMBERS_ONLY]);
  const kept = stored.get('CH2609110044');
  assert.ok(kept, 'the CBC with interfaced rows must be stored');
  assert.deepEqual(kept, ['BAS#', 'MON#', 'PCT', 'PDW', 'RDW'], `got ${kept!.join(', ')}`);
  console.log(`  ${G} CH2609110044 stored with ${kept!.length} rows: ${kept!.join(', ')}`);
  console.log(`  ${G} the 16 bare-number rows (${BARE.slice(0, 5).join(', ')} …) were dropped at the door`);
  assert.equal(stored.has('CH2609110045'), false, 'a tube with only non-interfaced rows must not be stored');
  console.log(`  ${G} CH2609110045 (numbers only) not stored at all`);
  assert.equal(acknowledged.length, 0, 'dropping a row must never acknowledge it');
  console.log(`  ${G} nothing acknowledged to HMIS`);
}

console.log('\n[2] The alias spelling counts as interfaced (RDW-CV → RDW)');
{
  const stored = await pollWith(ALLOW, FULL);
  assert.ok(stored.get('CH2609110044')!.includes('RDW'));
  console.log(`  ${G} "RDW" kept because testCodeAliases maps RDW-CV to it`);
}

console.log('\n[3] Matching is exact and case-insensitive');
{
  const stored = await pollWith(ALLOW.map((c) => c.toLowerCase()), FULL);
  assert.deepEqual(stored.get('CH2609110044'), ['BAS#', 'MON#', 'PCT', 'PDW', 'RDW']);
  console.log(`  ${G} lower-cased allow-list keeps the same rows`);
}

console.log('\n[4] An empty allow-list filters nothing — other analyzers unchanged');
{
  const stored = await pollWith([], [...FULL, ...NUMBERS_ONLY]);
  assert.equal(stored.get('CH2609110044')!.length, FULL.length, 'all rows kept');
  assert.equal(stored.get('CH2609110045')!.length, BARE.length, 'numbers-only tube kept');
  console.log(`  ${G} ${FULL.length} + ${BARE.length} rows stored when no allow-list is configured`);
}

console.log('\nALL BC-6000 INTERFACED-ROW TESTS PASSED\n');
