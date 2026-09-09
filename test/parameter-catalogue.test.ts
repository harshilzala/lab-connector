import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParameterCatalogue } from '../src/orders/parameters.js';
import { isVoidResult, toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem } from '../src/types.js';

// Pins the recovery from a collapsed HMIS pending list, and the "****" drop.
//
// Live case, CH2609080028 on the Cancer BC-6000, 2026-09-08. The CBC
// (labServiceId 3141, resultType PARAMETER, labResultId 92910365) is 38
// parameters. From the first poll onwards HMIS offered only 20 of its rows: 4
// under the analyzer's own mnemonic and 16 under a bare number. The analyzer
// sent a full CBC; 4 values filed; the sample flipped to "result interfaced"
// with a blank report. One of those 4 was MON# = "****" — the instrument had
// withheld the differential — so it filed a placeholder over a real parameter.
//
//   Run:  npx tsx test/parameter-catalogue.test.ts

// Same quiet stub the order-store test uses.
const log = { child: () => log, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as any;
const dir = mkdtempSync(join(tmpdir(), 'paramcat-'));

try {
  // --- the placeholder is not a result -------------------------------------
  assert.ok(isVoidResult('****'), 'Mindray withheld-value marker is void');
  assert.ok(isVoidResult('  ****  '));
  assert.ok(!isVoidResult('4.34'), 'a real value is not void');
  assert.ok(!isVoidResult('<0.02'), 'a censored value is still a result');

  // --- the catalogue -------------------------------------------------------
  const cat = new ParameterCatalogue(ParameterCatalogue.fileFor(dir), log);

  // Service 3141 as HMIS offered it in full on CH2609080024, the same morning:
  // 22 analytes under the instrument mnemonic (a handful shown here) plus the
  // bare-number parameters the interface does not cover.
  const CBC: Array<[string, number]> = [
    ['WBC', 2123], ['RBC', 2124], ['HGB', 2130], ['HCT', 2131], ['PLT', 2168],
    ['MCV', 2127], ['MCH', 2129], ['MCHC', 2128], ['RDW-CV', 2122], ['MPV', 6193],
    ['NEU#', 6960], ['LYM#', 6961], ['EOS#', 6962], ['MON#', 11304], ['BAS#', 11305],
    ['NEU%', 2143], ['LYM%', 2144], ['EOS%', 2145], ['MON%', 2146], ['BAS%', 2147],
    ['PCT', 6964], ['PDW', 7002], ['42', 2163], ['300', 6956],
  ];
  const row = (
    identifier: string,
    parameterId: number,
    over: Partial<MirthAcknowledgeItem> = {},
  ): MirthAcknowledgeItem => ({
    sampleID: 'CH2609080024', equipmentId: 30285205, identifier, ipAddress: '10.12.19.43',
    isTransmitted: true, labResultId: 92_900_544, labServiceId: 3141, portNo: '4001',
    parameterId, resultType: 'PARAMETER', ...over,
  });

  const learned = cat.learn(CBC.map(([id, pid]) => row(id, pid)));
  assert.strictEqual(learned, CBC.length, 'every parameter is learned once');
  assert.strictEqual(cat.learn(CBC.map(([id, pid]) => row(id, pid))), 0, 'a repeat poll learns nothing new');
  assert.deepStrictEqual(cat.counts(), { services: 1, parameters: CBC.length });

  // --- the collapsed sample ------------------------------------------------
  // What HMIS actually offered for CH2609080028: 4 mnemonics + 16 bare numbers,
  // all on labResultId 92910365.
  const collapsed: MirthAcknowledgeItem[] = ([
    ['MON#', 11304], ['BAS#', 11305], ['PCT', 6964], ['PDW', 7002], ['42', 2163], ['300', 6956],
  ] as Array<[string, number]>).map(([id, pid]) =>
    row(id, pid, { sampleID: 'CH2609080028', labResultId: 92_910_365 }),
  );

  const wanted = ['WBC', 'HGB', 'PLT', 'NEU%', 'CORRECTED WBC'];
  const { rows: rebuilt, unknown } = cat.synthesize(collapsed, wanted);

  assert.deepStrictEqual(
    rebuilt.map((r) => r.identifier).sort(),
    ['HGB', 'NEU%', 'PLT', 'WBC'],
    'the four analytes HMIS knows are rebuilt',
  );
  assert.deepStrictEqual(unknown, ['CORRECTED WBC'], 'an analyte HMIS has never named stays unfilable');
  for (const r of rebuilt) {
    assert.strictEqual(r.labResultId, 92_910_365, 'the labResultId is this sample’s own, borrowed from a sibling row');
    assert.strictEqual(r.labServiceId, 3141);
    assert.strictEqual(r.sampleID, 'CH2609080028');
    assert.strictEqual(r.ipAddress, '10.12.19.43');
    assert.strictEqual(r.portNo, '4001');
    assert.strictEqual(r.synthesized, true, 'rebuilt rows are marked');
  }
  assert.strictEqual(rebuilt.find((r) => r.identifier === 'WBC')!.parameterId, 2123);
  assert.strictEqual(rebuilt.find((r) => r.identifier === 'HGB')!.parameterId, 2130);

  // A parameter HMIS *is* offering is never rebuilt — no double filing.
  assert.strictEqual(cat.synthesize(collapsed, ['PCT', 'PDW']).rows.length, 0);

  // A rebuilt row must never teach the catalogue anything.
  assert.strictEqual(cat.learn(rebuilt), 0, 'synthesized rows are not learned from');

  // --- the join files them -------------------------------------------------
  const upload: HmisResultUpload = {
    equipmentId: 30285205, eqCode: 'ZCCEQ004', barcode: 'CH2609080028', isQc: false, raw: '',
    messageId: 'CH2609080028-test',
    results: [
      { testCode: 'WBC', value: '10.45' },
      { testCode: 'HGB', value: '5.7' },
      { testCode: 'PLT', value: '34' },
      { testCode: 'MON#', value: '****' },
      { testCode: 'PCT', value: '0.031' },
    ],
  };
  const scale = { WBC: 1000, PLT: 1000 };
  const allow = ['WBC', 'HGB', 'PLT', 'MON#', 'PCT'];

  const before = toLisResultRows(upload, collapsed, undefined, {}, [], scale, allow);
  assert.deepStrictEqual(before.rows.map((r) => r.identifier), ['PCT'], 'without the rebuild only PCT files');
  assert.deepStrictEqual(before.voided, ['MON#'], 'the placeholder is dropped, not filed');
  assert.deepStrictEqual(before.unmatched.sort(), ['HGB', 'PLT', 'WBC']);

  const after = toLisResultRows(upload, [...collapsed, ...rebuilt], undefined, {}, [], scale, allow);
  assert.deepStrictEqual(after.rows.map((r) => r.identifier).sort(), ['HGB', 'PCT', 'PLT', 'WBC']);
  assert.deepStrictEqual(after.unmatched, [], 'nothing is left waiting');
  assert.deepStrictEqual(after.voided, ['MON#'], 'the placeholder is still dropped');
  assert.ok(
    !after.rows.some((r) => r.resultValue.includes('*')),
    'no placeholder ever reaches the results endpoint',
  );
  // The unit conversion still applies to a rebuilt row.
  assert.strictEqual(after.rows.find((r) => r.identifier === 'WBC')!.resultValue, '10450');
  assert.strictEqual(after.rows.find((r) => r.identifier === 'PLT')!.resultValue, '34000');
  assert.ok(after.rows.every((r) => r.labResultId === 92_910_365));

  // --- the guards ----------------------------------------------------------
  // A Numeric service is one row per test: there is no sibling to borrow a
  // labResultId from, so nothing may ever be rebuilt inside one.
  const numDir = mkdtempSync(join(tmpdir(), 'paramcat-num-'));
  try {
    const numeric = new ParameterCatalogue(ParameterCatalogue.fileFor(numDir), log);
    const na = row('SODIUM', 5001, { labServiceId: 900, labResultId: 111, resultType: 'Numeric' });
    const nb = row('POTASSIUM', 5002, { labServiceId: 901, labResultId: 222, resultType: 'Numeric' });
    numeric.learn([na, nb]);
    assert.strictEqual(
      numeric.synthesize([na], ['POTASSIUM']).rows.length,
      0,
      'a Numeric service never lends its labResultId to another analyte',
    );
    assert.deepStrictEqual(numeric.synthesize([na], ['POTASSIUM']).unknown, ['POTASSIUM']);
  } finally {
    rmSync(numDir, { recursive: true, force: true });
  }

  // Nothing known for the sample at all: no template, so nothing is invented.
  assert.deepStrictEqual(cat.synthesize([], ['WBC']).rows, []);
  assert.deepStrictEqual(cat.synthesize([], ['WBC']).unknown, ['WBC']);

  // The catalogue survives a restart.
  const reopened = new ParameterCatalogue(ParameterCatalogue.fileFor(dir), log);
  assert.deepStrictEqual(reopened.counts(), { services: 1, parameters: CBC.length }, 'persisted to disk');
  assert.strictEqual(reopened.synthesize(collapsed, ['WBC']).rows[0]!.parameterId, 2123);

  console.log('parameter-catalogue: OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
