import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { parseResultFile } from '../src/codec/kermit/vitros250.js';
import { parseMessage } from '../src/codec/astm/records.js';
import type { HmisClient } from '../src/hmis/client.js';
import type { AnalyzerConfig } from '../src/config.js';

// =============================================================================
// "The VITROS 250 is working single-directional" — what that really was, and
// the log line that now says so.
//
// Reported by Prahlad Nagar on 23 Sep 2026. The link was not one-directional:
// over 21–23 Sep every sample program was acknowledged packet by packet and
// every result came back on the same barcode. What the analyzer did was drop
// PARTICULAR ASSAYS — and say nothing about them. An assay it omits carries no
// value and not even the "NO RESULT" placeholder, so the sample filed its other
// values, HMIS held the missing row pending for ever, and the only reasonable
// reading from the lab's side was that the worklist never arrived.
//
// Two different faults hid in that silence, and the connector must tell them
// apart, because only one of them is ours:
//
//   107 / 108 / 109 — HMIS's derived members of service 3221. The analyzer has
//     no assay at those numbers and DISCARDS THE WHOLE PROGRAM that names one,
//     so the tube gets keyed in by hand. Cured by orderPoll.excludeTestCodes,
//     which the vitros-250 profile now carries (test/vitros250-program.test.ts
//     pins the mechanism; this file pins the symptom being visible).
//   76 — the analyzer knows it, accepts the program and runs the sample; the
//     assay itself never yields (0 of 29 programmes, four of them answering
//     "NO RESULT 060MENSPF"). Nothing to fix in the connector: the lab clears
//     it at the instrument.
//
//   npx tsx test/vitros250-outstanding.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';

const BARCODE = 'PL2609230008';
/** Verbatim from logs/wire-vitros-250-2026-09-23.log, R0000004 — the lipid
 *  tube programmed with nine assays that answered with six. */
const R0000004 =
  '1023260923DSA            PL2609230008   10"01.000$  167.   000}Z   38.   000}%  128.   000}.    1.0  000}Y   37.   000}"    3.6  000}|1123      ]';
/** Verbatim, R0000008 — the tube whose assays all came back "NO RESULT". */
const R0000008 =
  '1853000923DPKC           PL2609230021   10!51.000ZNO RESULT060MEPF}.NO RESULT060MEPF}|1123      ]';

console.log('\n[1] The analyzer answered nine programmed assays with six — and never mentions the other three');
{
  const msg = parseResultFile(R0000004, new Date('2026-09-23T14:00:00'));
  const got = msg.results.map((r) => r.testCode).sort();
  assert.deepEqual(got, ['34', '36', '37', '46', '89', '90'], `got ${JSON.stringify(got)}`);
  console.log(`  ${G} returned ${got.join(',')} — 107/108/109 absent entirely, not even as "NO RESULT"`);
}

console.log('\n[2] A "NO RESULT" assay is still reported, with the analyzer\'s condition code');
{
  const msg = parseResultFile(R0000008, new Date('2026-09-23T19:00:00'));
  assert.deepEqual(
    msg.results.map((r) => [r.testCode, r.value, r.abnormalFlag]),
    [
      ['90', 'NO RESULT', '060MEPF'],
      ['46', 'NO RESULT', '060MEPF'],
    ],
  );
  console.log(`  ${G} 90 and 46 come back as voids carrying 060MEPF — the lab can see WHY`);
}

console.log('\n[3] The runtime names the programmed assays a result came back without');
{
  const dir = mkdtempSync(join(tmpdir(), 'lab-250-outstanding-'));
  const warned: Array<{ barcode?: string; outstanding?: string[]; msg: string }> = [];
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

  const hmis = {
    async getPending() {
      return { status: 'success', data: [] };
    },
    async acknowledge() {},
    async postResults() {
      return { status: 'success', message: 'ok', successData: [], filed: 0 };
    },
  } as unknown as HmisClient;

  const cfg = {
    id: 'vitros-250-outstanding-test',
    equipmentCode: 'ZHPN003',
    extraEquipmentCodes: [],
    siteIds: [],
    protocol: 'kermit',
    transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15255 },
    sendDemographics: true,
    hostQuery: false,
    sendDate: false,
    qc: { sampleIdPrefixes: [], sampleIdRegex: null, patientPrefixes: [] },
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
  const inner = rt as unknown as {
    orders: {
      upsert(b: string, p: unknown, s: string): { order: unknown; newCodes: string[] };
      markDownloaded(b: string, c: string[]): void;
    };
    onMessage(m: unknown): Promise<void>;
  };

  // The order as HMIS offered it, and the nine assays we programmed.
  const nine = ['46', '34', '90', '107', '37', '89', '109', '108', '36'];
  inner.orders.upsert(
    BARCODE,
    {
      sampleId: BARCODE,
      found: true,
      testCodes: nine,
      patient: null,
      specimenType: 'Serum',
      priority: 'R',
      ackItems: nine.map((identifier, i) => ({
        sampleID: BARCODE,
        identifier,
        equipmentId: 224895586,
        labResultId: 93559900 + i,
        labServiceId: 3221,
        parameterId: 2220 + i,
        ipAddress: '10.20.4.52',
        portNo: '4001',
        resultType: 'PARAMETER',
      })),
    },
    'poll',
  );
  inner.orders.markDownloaded(BARCODE, nine);

  await inner.onMessage(parseResultFile(R0000004, new Date('2026-09-23T14:00:00')));

  const hit = warned.find((w) => w.msg.startsWith('analyzer answered this sample without'));
  assert.ok(hit, `expected the outstanding-assay warning, got ${JSON.stringify(warned.map((w) => w.msg))}`);
  assert.equal(hit!.barcode, BARCODE);
  assert.deepEqual([...hit!.outstanding!].sort(), ['107', '108', '109']);
  console.log(`  ${G} warned: ${hit!.msg}`);
  console.log(`  ${G} outstanding: ${hit!.outstanding!.join(',')} — the three the analyzer has no assay for`);

  // And a sample that answered everything it was programmed with stays quiet.
  warned.length = 0;
  inner.orders.upsert(
    'PL2609230016',
    {
      sampleId: 'PL2609230016',
      found: true,
      testCodes: ['32'],
      patient: null,
      specimenType: 'Serum',
      priority: 'R',
      ackItems: [
        {
          sampleID: 'PL2609230016',
          identifier: '32',
          equipmentId: 224895586,
          labResultId: 93559990,
          labServiceId: 77,
          parameterId: null,
          ipAddress: '10.20.4.52',
          portNo: '4001',
          resultType: 'Numeric',
        },
      ],
    },
    'poll',
  );
  inner.orders.markDownloaded('PL2609230016', ['32']);
  await inner.onMessage(
    parseResultFile('1414190923DPKC           PL2609230016   10!51.000   189.   000}|1123      ]', new Date('2026-09-23T14:20:00')),
  );
  assert.ok(
    !warned.some((w) => w.msg.startsWith('analyzer answered this sample without')),
    `a complete sample must not warn, got ${JSON.stringify(warned.map((w) => w.msg))}`,
  );
  console.log(`  ${G} a sample that returned everything programmed says nothing`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\n[4] On the ECiQ the two sides spell an assay differently — and that is not "did not run"');
{
  // HMIS carries the ECiQ's eqIdntifier as the FULL "1.000000+035+1"; the
  // analyzer's R record names the same assay "035". Compared raw, all five
  // assays that DID come back were reported as outstanding — 31 such false
  // alarms in logs/lab-interface.out.log between 16 and 27 Sep 2026, which
  // would have buried the genuine ones. Both sides go through the dialect's
  // canonical key instead, exactly as the filing join does.
  const dir = mkdtempSync(join(tmpdir(), 'lab-eciq-outstanding-'));
  const warned: Array<{ barcode?: string; outstanding?: string[]; msg: string }> = [];
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

  const hmis = {
    async getPending() {
      return { status: 'success', data: [] };
    },
    async acknowledge() {},
    async postResults() {
      return { status: 'success', message: 'ok', successData: [], filed: 0 };
    },
  } as unknown as HmisClient;

  const cfg = {
    id: 'vitros-eciq-outstanding-test',
    equipmentCode: 'ZHPN004',
    extraEquipmentCodes: [],
    siteIds: [],
    protocol: 'astm',
    transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 15256 },
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
    equipmentId: 224895587,
    ipAddress: '10.20.4.53',
    portNo: '4001',
    orderPoll: { enabled: false, intervalMs: 30000, lookbackDays: 0, download: true, downloadPrefixes: [], excludeTestCodes: [] },
    astm: { ackTimeoutMs: 15000, frameMaxData: 240, senderId: 'HOST', receiverId: '', dialect: 'vitros-eciq' },
    kermit: { ackTimeoutMs: 10000, maxRetries: 5, interPacketDelayMs: 0, interTransferDelayMs: 0 },
    filing: { mode: 'queue', passIntervalMs: 15000, recheckMs: 300000, keepFiledDays: 2 },
    hl7: { sendingApp: 'LIS', sendingFacility: '', charset: 'UNICODE', ack: true, valueTypes: ['NM'], encoding: 'utf8', idleFlushMs: 0 },
  } as unknown as AnalyzerConfig;

  const rt = new AnalyzerRuntime(cfg, hmis, dir, log);
  const inner = rt as unknown as {
    orders: {
      upsert(b: string, p: unknown, s: string): { order: unknown; newCodes: string[] };
      markDownloaded(b: string, c: string[]): void;
    };
    onMessage(m: unknown): Promise<void>;
  };

  const ECIQ = 'PL2609270011';
  /** Verbatim from spool/vitros-eciq/orders/PL2609270011.json — HMIS's own
   *  identifier spelling, full universal test ids. */
  const six = [
    '1.000000+035+1',
    '1.000000+003+1',
    '1.000000+002+1',
    '1.000000+032+1',
    '1.000000+074+1',
    '1.000000+038+1',
  ];
  inner.orders.upsert(
    ECIQ,
    {
      sampleId: ECIQ,
      found: true,
      testCodes: six,
      patient: null,
      specimenType: 'Serum',
      priority: 'R',
      ackItems: six.map((identifier, i) => ({
        sampleID: ECIQ,
        identifier,
        equipmentId: 224895587,
        labResultId: 93660000 + i,
        labServiceId: 3300,
        parameterId: null,
        ipAddress: '10.20.4.53',
        portNo: '4001',
        resultType: 'Numeric',
      })),
    },
    'poll',
  );
  inner.orders.markDownloaded(ECIQ, six);

  // Verbatim from logs/wire-vitros-eciq-2026-09-27.log — five of the six came
  // back; 003 is the one that genuinely did not run.
  const lines = [
    'H|\\^&|||VECI|||||||||20260927103909',
    `P|1|10002024452215|||BANERJI^URNA|||F`,
    `O|1|${ECIQ}^01^0||^^^1.000000+002+1\\032+1\\035+1\\038+1\\074+1|R||||||N||||4||||||||||F`,
    'R|1|^^^1.000000+002+1|90.9|nmol/L||^0^||V|||20260927094021|20260927100339|',
    'R|2|^^^1.000000+032+1|289|pg/mL||^0^||V|||20260927101541|20260927103859|',
    'R|3|^^^1.000000+035+1|1.129|uIU/mL||^0^||V|||20260927094141|20260927100459|',
    'R|4|^^^1.000000+038+1|5.5|U/mL||^5^OR||V|||20260927094101|20260927101758|',
    'R|5|^^^1.000000+074+1|26.2|ng/mL||^0^||V|||20260927094221|20260927100539|',
    'L|1|N',
  ];
  await inner.onMessage(parseMessage(lines, lines.join('\r\n'), 'vitros-eciq'));

  const hit = warned.find((w) => w.msg.startsWith('analyzer answered this sample without'));
  assert.ok(hit, `expected the outstanding-assay warning, got ${JSON.stringify(warned.map((w) => w.msg))}`);
  assert.equal(hit!.barcode, ECIQ);
  assert.deepEqual(
    hit!.outstanding,
    ['1.000000+003+1'],
    `only 003 is outstanding; got ${JSON.stringify(hit!.outstanding)}`,
  );
  console.log(`  ${G} outstanding: ${hit!.outstanding!.join(',')} — the five that returned are no longer named`);

  rmSync(dir, { recursive: true, force: true });
}

console.log('\nvitros250-outstanding: all checks passed\n');
