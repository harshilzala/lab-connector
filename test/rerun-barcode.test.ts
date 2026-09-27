import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { rerunBaseBarcode } from '../src/mapping/mapper.js';
import { parseResultFile } from '../src/codec/kermit/vitros250.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// Reruns the operator marked on the sample id, and assay codes the wire cannot
// carry — two ways a result used to disappear without being named.
//
// Found by reconciling every VITROS 250 order against every frame it answered,
// 16–27 Sep 2026:
//
//   PL2609240011/R  90=56    50 delivery attempts, parked in failed/
//   PL2609260017/R  46=1.3   50 delivery attempts, parked in failed/
//   PL2609190003R   32=117   parked, then DISCARDED past the retention window
//
// HMIS registers none of those barcodes, so no pending row can ever match. The
// suffix is still not stripped: PL2609240011 had already filed 90=57 and
// PL2609260017 had already filed 46=1.3, so filing the repeat would overwrite
// an acknowledged value with a near-miss or a duplicate. The connector reports
// it and drops it; whether the repeat should stand is the lab's call.
//
// Separately, HMIS code 986 on PL2609240002 cannot be a single byte, so the
// codec dropped it before the transfer. It is recorded as downloaded on purpose
// — otherwise the poller re-sends it every 30s for ever — so the outstanding
// assay report must exclude it rather than claim the order reached the analyzer
// carrying it.
//
//   npx tsx test/rerun-barcode.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';

console.log('\n[1] A rerun mark is only read as one when the base barcode is on file');
{
  const known = (b: string) => ['PL2609240011', 'PL2609260017', 'PL2609190003'].includes(b);
  for (const [id, want] of [
    ['PL2609240011/R', 'PL2609240011'],
    ['PL2609190003R', 'PL2609190003'],
    ['PL2609260017-R2', 'PL2609260017'],
    ['PL2609240011 R', 'PL2609240011'],
    ['pl2609240011/r', 'PL2609240011'],
  ] as const) {
    assert.equal(rerunBaseBarcode(id, known), want, `${id} -> ${want}`);
    console.log(`  ${G} ${id.padEnd(16)} -> ${want}`);
  }

  // The safety property: no order on file, no rerun. A real barcode ending in R
  // must survive untouched, or the connector would file one patient's values
  // against another patient's barcode.
  for (const id of ['PL2609990099/R', 'BHUSHAN16', 'PL2609240012', 'SENDER', 'R', '']) {
    assert.equal(rerunBaseBarcode(id, known), null, `${id} must not be read as a rerun`);
  }
  console.log(`  ${G} an unknown base, a typed name, and a bare "R" are left alone`);
  assert.equal(rerunBaseBarcode('PL2609240011', known), null);
  console.log(`  ${G} the base barcode itself is not a rerun of itself`);
}

const hmis = {
  async getPending() {
    return { status: 'success', data: [] };
  },
  async acknowledge() {},
  async postResults() {
    return { status: 'success', message: 'ok', successData: [], filed: 0 };
  },
} as unknown as HmisClient;

function runtime(dir: string, warned: Array<Record<string, unknown> & { msg: string }>) {
  const log = {
    child: () => log,
    info() {},
    debug() {},
    trace() {},
    fatal() {},
    error() {},
    warn(o: unknown, m?: string) {
      if (typeof o === 'object' && o && typeof m === 'string') warned.push({ ...(o as object), msg: m } as never);
    },
  } as never;

  const cfg = {
    id: 'vitros-250-rerun-test',
    equipmentCode: 'ZHPN003',
    extraEquipmentCodes: [],
    siteIds: [],
    protocol: 'kermit',
    transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15257 },
    sendDemographics: true,
    hostQuery: false,
    sendDate: false,
    qc: { sampleIdPrefixes: [], sampleIdRegex: '^[0-9]+$', patientPrefixes: [] },
    testCodeAliases: {},
    excludeIdentifiers: [],
    excludeParameterIds: [],
    ignoreTestCodes: [],
    allowTestCodes: [],
    testCodeScale: {},
    testValueMap: {},
    fillMissingOrderRows: false,
    equipmentId: 224895586,
    ipAddress: '10.20.4.52',
    portNo: '4001',
    orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: [], excludeTestCodes: [] },
    astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
    kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
    filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
    hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
  } as unknown as AnalyzerConfig;

  const rt = new AnalyzerRuntime(cfg, hmis, dir, log);
  return rt as unknown as {
    orders: {
      upsert(b: string, p: unknown, s: string): unknown;
      markDownloaded(b: string, c: string[]): void;
      get(b: string): unknown;
    };
    onMessage(m: unknown): Promise<void>;
    reportRerun(payload: unknown, base: string): void;
  };
}

/**
 * A VITROS 250 result record, built rather than hand-counted: the assay code is
 * the FIRST BYTE of each result block (code 56 is "8", code 32 is a space), so a
 * literal is very easy to get subtly wrong. Layout per src/codec/kermit/
 * vitros250.ts — stamp(10) operator(15) sample(15) "10" seq fluid "1.000" then
 * one [code][value:9][alarm:3]"}" block per assay.
 */
const record = (sample: string, stamp: string, blocks: Array<[code: string, value: string]>) =>
  stamp +
  'DPKC'.padEnd(15) +
  sample.padEnd(15) +
  `10!51.000` +
  blocks.map(([code, value]) => String.fromCharCode(Number(code)) + value.padStart(9) + '000}').join('') +
  '|1123      ]';

/** An order as HMIS offers it, with one row per code. */
const order = (barcode: string, codes: string[]) => ({
  sampleId: barcode,
  found: true,
  testCodes: codes,
  patient: null,
  specimenType: 'Serum',
  priority: 'R' as const,
  ackItems: codes.map((identifier, i) => ({
    sampleID: barcode,
    identifier,
    equipmentId: 224895586,
    labResultId: 94000000 + i,
    labServiceId: 3221,
    parameterId: null,
    ipAddress: '10.20.4.52',
    portNo: '4001',
    resultType: 'Numeric',
  })),
});

console.log('\n[2] The rerun is named, with the barcode it repeats — and is not filed');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-rerun-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const inner = runtime(dir, warned);

  inner.orders.upsert('PL2609240011', order('PL2609240011', ['46', '76', '90']), 'poll');
  inner.orders.markDownloaded('PL2609240011', ['46', '76', '90']);

  // Verbatim from spool/vitros-250/failed/PL2609240011_R-…json — the value that
  // spent 50 attempts going nowhere.
  inner.reportRerun(
    {
      equipmentId: null,
      eqCode: 'ZHPN003',
      barcode: 'PL2609240011/R',
      isQc: false,
      results: [{ testCode: '90', value: '56', unit: null, abnormalFlag: null, status: 'F', completedAt: '20260924194603' }],
    },
    'PL2609240011',
  );

  const hit = warned.find((w) => w.msg.startsWith('rerun of an existing barcode'));
  assert.ok(hit, `expected the rerun warning, got ${JSON.stringify(warned.map((w) => w.msg))}`);
  assert.equal(hit!.barcode, 'PL2609240011/R');
  assert.equal(hit!.rerunOf, 'PL2609240011');
  assert.deepEqual(hit!.values, ['90=56']);
  assert.deepEqual(hit!.onOriginalOrder, ['90'], 'the original order does cover assay 90');
  console.log(`  ${G} ${hit!.barcode} reported as a rerun of ${hit!.rerunOf}, values ${(hit!.values as string[]).join(',')}`);
  console.log(`  ${G} and it says assay 90 is on the original order — the lab can compare the two`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] A code the wire cannot carry is not reported as "did not run"');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-unencodable-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const inner = runtime(dir, warned);

  // PL2609240002 as HMIS raised it: 986 is beyond one byte, 56 is fine.
  inner.orders.upsert('PL2609240002', order('PL2609240002', ['986', '56']), 'poll');
  inner.orders.markDownloaded('PL2609240002', ['986', '56']);

  await inner.onMessage(
    parseResultFile(record('PL2609240002', '0531000924', [['56', '4.10']]), new Date('2026-09-24T05:31:00')),
  );
  const hit = warned.find((w) => w.msg.startsWith('analyzer answered this sample without'));
  assert.ok(!hit, `986 was never programmed, so nothing is outstanding; got ${JSON.stringify(hit)}`);
  console.log(`  ${G} 56 came back and 986 never went out — no false "the order did reach it" claim`);

  // But a code that COULD have been sent and did not answer is still reported.
  warned.length = 0;
  inner.orders.upsert('PL2609240003', order('PL2609240003', ['986', '56', '76']), 'poll');
  inner.orders.markDownloaded('PL2609240003', ['986', '56', '76']);
  await inner.onMessage(
    parseResultFile(record('PL2609240003', '0532000924', [['56', '4.10']]), new Date('2026-09-24T05:32:00')),
  );
  const still = warned.find((w) => w.msg.startsWith('analyzer answered this sample without'));
  assert.ok(still, 'assay 76 was programmed and did not answer — that must still be reported');
  assert.deepEqual(still!.outstanding, ['76'], `only 76 is outstanding; got ${JSON.stringify(still!.outstanding)}`);
  console.log(`  ${G} outstanding: 76 — reported, while 986 stays out of it`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\nrerun-barcode: all checks passed\n');
