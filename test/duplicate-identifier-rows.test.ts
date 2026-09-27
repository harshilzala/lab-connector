import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from '../src/orders/store.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import type { HmisResultUpload, MirthAcknowledgeItem, PendingOrders } from '../src/types.js';

// =============================================================================
// "PL2609240006 RBC Count not transferred" — one HMIS identifier, two
// parameters, and the row that got thrown away.
//
// HMIS's service 3141 (CBC + peripheral smear) names TWO of its parameters
// "RBC" — #2152, the smear line, and #2124, RBC COUNT — and two of them "WBC"
// — #2166 and #2123. It has done since the lab renamed the master on
// 12 Sep 2026, and config.json puts #2152/#2166 in the BC-5150's
// excludeParameterIds precisely so the instrument's count lands on the count
// row and never on the smear line.
//
// The order store kept one row per IDENTIFIER, so of the 26 rows HMIS offered
// for PL2609240006 only 24 were stored and one of each pair was lost. The
// gateway shuffles the row order on every poll, so which one survived was a
// coin flip. On 24 Sep the smear rows won; being excluded, the instrument's RBC
// then matched nothing, the "RBC COUNT" alias matched nothing, and
// fillMissingOrderRows invented a row. HMIS answered 200 and the value never
// reached the report.
//
// Pinned here, from the real reply: both rows survive, RBC and WBC each resolve
// to the COUNT parameter with HMIS's own labResultId, and testCodes still lists
// each code once so the assay is never programmed twice.
//
//   npx tsx test/duplicate-identifier-rows.test.ts
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

const BARCODE = 'PL2609240006';
/** Verbatim from the 24 Sep pending reply for ZHPN001, service HEM0000123 →
 *  labServiceId 3141, every row sharing labResultId 93663687. The two pairs
 *  are listed smear-first, the order that broke it. */
const OFFERED: Array<[string, number]> = [
  ['NEU%', 2143], ['EOS%', 2145], ['RBC', 2152], ['Band cells', 2151], ['RDW-CV', 2122],
  ['Promyelocytes', 2148], ['MON%', 2146], ['HCT', 2131], ['Absolute Eosinophil count', 6962],
  ['WBC', 2166], ['HGB', 2130], ['MCV', 2127], ['MCH', 2129], ['MCHC', 2128], ['Blasts', 2142],
  ['Metamyelocytes', 2150], ['PARASITE', 2165], ['BAS%', 2147], ['Myelocytes', 2149],
  ['MPV', 6193], ['PCT', 2162], ['PERIPHERAL SMEAR FINDINGS/COMMENT', 7056], ['LYM%', 2144],
  ['PLT', 2168],
  // The two the store used to lose.
  ['RBC', 2124], ['WBC', 2123],
];

const row = ([identifier, parameterId]: [string, number]): MirthAcknowledgeItem => ({
  sampleID: BARCODE,
  identifier,
  parameterId,
  labResultId: 93663687,
  labServiceId: 3141,
  equipmentId: 224302864,
  ipAddress: '10.20.4.50',
  portNo: '5100',
  resultType: 'PARAMETER',
  isTransmitted: false,
});

const pending = (rows: Array<[string, number]>): PendingOrders =>
  ({
    sampleId: BARCODE,
    found: true,
    testCodes: rows.map(([i]) => i),
    patient: null,
    specimenType: null,
    priority: 'R',
    ackItems: rows.map(row),
  }) as unknown as PendingOrders;

const dir = mkdtempSync(join(tmpdir(), 'lab-dup-ident-'));
const store = new OrderStore(dir, quiet);

console.log('\n[1] Both rows of a shared identifier survive the store');
{
  const { order } = store.upsert(BARCODE, pending(OFFERED), 'poll');
  assert.equal(order.rows.length, 26, `all 26 rows must be stored, got ${order.rows.length}`);
  const rbc = order.rows.filter((r) => r.identifier === 'RBC').map((r) => r.parameterId).sort();
  const wbc = order.rows.filter((r) => r.identifier === 'WBC').map((r) => r.parameterId).sort();
  assert.deepEqual(rbc, [2124, 2152], `RBC rows: ${JSON.stringify(rbc)}`);
  assert.deepEqual(wbc, [2123, 2166], `WBC rows: ${JSON.stringify(wbc)}`);
  console.log(`  ${G} RBC kept as #2124 and #2152; WBC as #2123 and #2166`);

  // Whichever order the gateway shuffles them into.
  const reversed = [...OFFERED].reverse();
  const again = store.upsert(BARCODE, pending(reversed), 'poll').order;
  assert.equal(again.rows.length, 26, 'a reshuffled reply must not change the count');
  console.log(`  ${G} still 26 after the same reply arrives in the opposite order`);
}

console.log('\n[2] testCodes lists each code once — the assay is never programmed twice');
{
  const order = store.get(BARCODE)!;
  const rbcCodes = order.testCodes.filter((c) => c === 'RBC');
  assert.equal(rbcCodes.length, 1, `testCodes had RBC ${rbcCodes.length} times`);
  assert.equal(order.testCodes.length, new Set(order.testCodes.map((c) => c.toUpperCase())).size);
  console.log(`  ${G} ${order.testCodes.length} distinct codes from 26 rows`);
}

console.log('\n[3] With the smear rows excluded, RBC and WBC file against the COUNT parameters');
{
  const order = store.get(BARCODE)!;
  const upload: HmisResultUpload = {
    barcode: BARCODE,
    eqCode: 'ZHPN001',
    equipmentId: 224302864,
    isQc: false,
    results: [
      ['RBC', '4.95'],
      ['WBC', '5.52'],
      ['HGB', '14.3'],
    ].map(([testCode, value]) => ({
      sampleId: BARCODE, testCode: testCode!, value: value!, unit: null, referenceRange: null,
      abnormalFlag: null, status: 'F', completedAt: null, instrument: null,
    })),
  } as HmisResultUpload;

  // The BC-5150's real config: the smear rows are never filed into, and the
  // aliases that were needed before the master was renamed are still present.
  const out = toLisResultRows(
    upload,
    order.rows,
    (id) => id, // canonicalCode
    { WBC: 'WBC COUNT', RBC: 'RBC COUNT', HGB: 'HAEMOGLOBIN' }, // aliases
    [], // ignoreTestCodes
    {}, // scales
    [], // allowTestCodes
    [], // excludeIdentifiers
    [2166, 2152, 2162], // excludeParameterIds — the smear rows
  );

  assert.deepEqual(out.unmatched, [], `nothing may go unmatched, got ${JSON.stringify(out.unmatched)}`);
  assert.deepEqual(out.ambiguous, [], `nothing may be ambiguous, got ${JSON.stringify(out.ambiguous)}`);

  const byCode = new Map(out.rows.map((r) => [r.uniqueIdentifier, r]));
  const rbc = out.rows.find((r) => r.resultValue === '4.95')!;
  assert.equal(rbc.parameterId, 2124, `RBC must file against #2124, went to #${rbc.parameterId}`);
  assert.equal(rbc.identifier, 'RBC', `and under HMIS's own spelling, got "${rbc.identifier}"`);
  assert.equal(rbc.labResultId, 93663687, 'with the real labResultId, not a rebuilt one');
  console.log(`  ${G} RBC 4.95 → parameterId ${rbc.parameterId}, identifier "${rbc.identifier}", labResultId ${rbc.labResultId}`);

  const wbc = out.rows.find((r) => r.resultValue === '5.52')!;
  assert.equal(wbc.parameterId, 2123, `WBC must file against #2123, went to #${wbc.parameterId}`);
  console.log(`  ${G} WBC 5.52 → parameterId ${wbc.parameterId}, identifier "${wbc.identifier}"`);

  assert.ok(!out.rows.some((r) => r.parameterId === 2152 || r.parameterId === 2166), 'a smear row must never be filed into');
  console.log(`  ${G} nothing filed into the smear rows #2152 / #2166`);
  assert.ok(byCode.has('HGB'));
}

rmSync(dir, { recursive: true, force: true });
console.log('\nduplicate-identifier-rows: all checks passed\n');
