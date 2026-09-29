import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { strippedRerunBarcode, trimToBarcodeFormat } from '../src/mapping/mapper.js';
import { parseResultFile } from '../src/codec/kermit/vitros250.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// rerunSuffix: "strip" — the lab's decision (2026-09-29) for the VITROS 250 and
// ECiQ: a repeat keyed as "PL2609240011/R" files under PL2609240011.
// The default ("report") is covered by test/rerun-barcode.test.ts and must not
// change.
//
//   npx tsx test/rerun-strip.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';

console.log('\n[1] Which ids are stripped');
{
  const known = (b: string) => ['PL2609190003'].includes(b);
  for (const [id, want] of [
    ['PL2609240011/R', 'PL2609240011'], // separator: stripped even with no order on file
    ['pl2609240011/r', 'PL2609240011'],
    ['PL2609260017-R2', 'PL2609260017'],
    ['PL2609260017_R', 'PL2609260017'],
    ['PL2609240011 R', 'PL2609240011'],
    ['PL2609190003R', 'PL2609190003'], // bare R: only because the base is known
  ] as const) {
    assert.equal(strippedRerunBarcode(id, known), want, `${id} -> ${want}`);
    console.log(`  ${G} ${id.padEnd(16)} -> ${want}`);
  }
  for (const id of ['PL2609240012', 'PL2609990099R', 'BHUSHAN16', 'SENDER', 'R', '/R', 'AB/R', '']) {
    assert.equal(strippedRerunBarcode(id, known), null, `${id} must be left alone`);
  }
  console.log(`  ${G} a plain barcode, a bare R on an unknown base, and short junk are left alone`);
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

function runtime(
  dir: string,
  rerunSuffix: 'report' | 'strip',
  warned: Array<Record<string, unknown> & { msg: string }>,
  sampleIdFormat: string | null = null,
) {
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
    id: 'vitros-250-strip-test',
    equipmentCode: 'ZHPN003',
    extraEquipmentCodes: [],
    siteIds: [],
    protocol: 'kermit',
    transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15258 },
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
    rerunSuffix,
    sampleIdFormat,
    equipmentId: 224895586,
    ipAddress: '10.20.4.52',
    portNo: '4001',
    orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: [], excludeTestCodes: [] },
    astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
    kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
    filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
    hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
  } as unknown as AnalyzerConfig;
  return new AnalyzerRuntime(cfg, hmis, dir, log) as unknown as { onMessage(m: unknown): Promise<void> };
}

const record = (sample: string, stamp: string, blocks: Array<[code: string, value: string]>) =>
  stamp +
  'DPKC'.padEnd(15) +
  sample.padEnd(15) +
  `10!51.000` +
  blocks.map(([code, value]) => String.fromCharCode(Number(code)) + value.padStart(9) + '000}').join('') +
  '|1123      ]';

const queued = (dir: string) => {
  const pending = join(dir, 'vitros-250-strip-test', 'pending');
  return readdirSync(pending).map((f) => JSON.parse(readFileSync(join(pending, f), 'utf8')));
};

console.log('\n[2] strip: the rerun is queued under the base barcode, and logged');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-strip-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const rt = runtime(dir, 'strip', warned);
  // PL2609240011/R 90=56, the case from spool/vitros-250/failed.
  await rt.onMessage(parseResultFile(record('PL2609240011/R', '1946030924', [['90', '56']]), new Date('2026-09-24T19:46:03')));

  const items = queued(dir);
  assert.equal(items.length, 1);
  const payload = items[0].payload ?? items[0];
  assert.equal(payload.barcode, 'PL2609240011', JSON.stringify(payload).slice(0, 200));
  assert.equal(payload.results[0].value, '56');
  console.log(`  ${G} queued as ${payload.barcode}, 90=${payload.results[0].value}`);

  const hit = warned.find((w) => w.msg.startsWith('sample id trimmed'));
  assert.ok(hit, 'the strip must be logged');
  assert.equal(hit!.barcode, 'PL2609240011/R');
  assert.equal(hit!.filedAs, 'PL2609240011');
  assert.deepEqual(hit!.values, ['90=56']);
  console.log(`  ${G} logged: ${hit!.barcode} -> ${hit!.filedAs} (${(hit!.values as string[]).join(',')})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] report (default): unchanged — the id is kept as the analyzer sent it');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-report-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const rt = runtime(dir, 'report', warned);
  await rt.onMessage(parseResultFile(record('PL2609240011/R', '1946030924', [['90', '56']]), new Date('2026-09-24T19:46:03')));
  const payload = queued(dir)[0].payload ?? queued(dir)[0];
  assert.equal(payload.barcode, 'PL2609240011/R');
  assert.ok(!warned.some((w) => w.msg.startsWith('sample id trimmed')));
  console.log(`  ${G} still ${payload.barcode}; nothing stripped`);
  rmSync(dir, { recursive: true, force: true });
}

const FORMAT = '[A-Z]{2}[0-9]{10}'; // every one of 1,943 HMIS barcodes on 2026-09-29

console.log('\n[4] sampleIdFormat: extra after a valid barcode is cut off');
{
  for (const [id, want] of [
    ['PL2609280007R', 'PL2609280007'], // BC-5150 rerun, bare R — no order needed
    ['PL2609240011/R', 'PL2609240011'], // VITROS 250
    ['PL2609260017-R2', 'PL2609260017'],
    [' pl2609280007 ', null], // only case/space — normalizeBarcode already handles it
    ['/PL2609280007X', 'PL2609280007'], // stray leading separator
  ] as const) {
    assert.equal(trimToBarcodeFormat(id, FORMAT), want, `${JSON.stringify(id)} -> ${want}`);
    console.log(`  ${G} ${JSON.stringify(id).padEnd(18)} -> ${want ?? '(unchanged)'}`);
  }
  for (const id of ['PL2609280007', '8001', '89772', 'PL26092800', 'BHUSHAN16', '']) {
    assert.equal(trimToBarcodeFormat(id, FORMAT), null, `${id} must be left alone`);
  }
  console.log(`  ${G} an exact barcode, QC ids (8001, 89772), a short id and a name are left alone`);
}

console.log('\n[5] sampleIdFormat on a machine with rerunSuffix "report": still trimmed, logged with the rule');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-format-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const rt = runtime(dir, 'report', warned, FORMAT);
  await rt.onMessage(parseResultFile(record('PL2609280007R', '0937000929', [['90', '41']]), new Date('2026-09-29T09:37:00')));
  const payload = queued(dir)[0].payload ?? queued(dir)[0];
  assert.equal(payload.barcode, 'PL2609280007');
  const hit = warned.find((w) => w.msg.startsWith('sample id trimmed'));
  assert.equal(hit?.rule, 'sampleIdFormat');
  console.log(`  ${G} PL2609280007R queued as ${payload.barcode} (rule: ${hit!.rule})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[6] sampleIdFormat leaves a QC id alone');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-format-qc-'));
  const warned: Array<Record<string, unknown> & { msg: string }> = [];
  const rt = runtime(dir, 'report', warned, FORMAT);
  await rt.onMessage(parseResultFile(record('8001', '0937000929', [['90', '41']]), new Date('2026-09-29T09:37:00')));
  assert.ok(!warned.some((w) => w.msg.startsWith('sample id trimmed')), 'QC id must not be trimmed');
  console.log(`  ${G} 8001 untouched`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\nrerun-strip: all checks passed\n');
process.exit(0);
