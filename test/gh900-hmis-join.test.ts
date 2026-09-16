import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { interfacedCodeFilter, keepInterfacedResults, toLisResultRows, toResultUploads, willSyncIdentifier } from '../src/mapping/mapper.js';
import { ResultStore, summarize } from '../src/results/store.js';
import { parseGh900Sample } from '../src/codec/gh900/parser.js';
import type { MirthAcknowledgeItem, ParsedMessage } from '../src/types.js';

// The Shela GH900 Plus (ZHPN002) end to end: the live block the instrument
// sent → the connector's codes → HMIS's own rows for the HbA1c service.
//
// HMIS registration read on 2026-09-16: eqCode ZHPN002, equipmentId 224347060,
// service BIO0000076 "HbA1c (Glycosylated Hemoglobin)", PARAMETER rows
// 1312 = HBA1C and 1313 = EAG-MGDL, and nothing else. So a sample is complete
// when those two are filed; the codec's other values (IFCC, eAG mmol/L, HbF,
// fraction ratios) must never be waited for.
//   Run:  npx tsx test/gh900-hmis-join.test.ts

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'zhp-gh900plus');
if (!analyzer) throw new Error('zhp-gh900plus is not configured');

// HMIS pending rows for one HbA1c order, verbatim shape from the 16-09-2026 poll.
const rows: MirthAcknowledgeItem[] = [
  [1313, 'EAG-MGDL'],
  [1312, 'HBA1C'],
].map(([parameterId, identifier]) => ({
  sampleID: 'SF2609160013',
  equipmentId: 224347060,
  identifier: identifier as string,
  ipAddress: '10.20.4.51',
  isTransmitted: true,
  labResultId: 93200001,
  labServiceId: 4420,
  portNo: '8089',
  parameterId: parameterId as number,
  resultType: 'PARAMETER',
}));

// The live block of 2026-09-12 (sample S1) with the barcode swapped for the
// HMIS one — same code length (2 → 12 characters, adjusted in the preamble).
const live =
  'S07----12SF2609160013035001000102609112027411318263452880.00130.00260.00150.00230.00580.2417' +
  '00.01200.07900.04400.09800.72313.28100.100.600.300.705.193.3032.005.5099.1' +
  '000' + '0';
const sample = parseGh900Sample(live);
assert.equal(sample.sampleId, 'SF2609160013');
const msg: ParsedMessage = { protocol: 'gh900', sender: 'GH900', patient: null, queries: [], results: sample.results, isQc: false, raw: live };

// ---- 1) config: scoped to what HMIS registers ----------------------------
assert.deepEqual([...analyzer.allowTestCodes].sort(), ['EAG-MGDL', 'HBA1C'], 'block scopes the interface to the two HMIS rows');
assert.equal(analyzer.orderPoll.enabled, true, 'orders are polled for ZHPN002');
assert.equal(analyzer.equipmentCode, 'ZHPN002');
console.log('✓ config: ZHPN002, polling on, allow-list = HBA1C + EAG-MGDL');

// ---- 2) intake: 9 codec values → 2 stored --------------------------------
const [full] = toResultUploads(analyzer, msg);
assert.equal(full!.results.length, 9, 'the codec reports 9 values');
const filter = interfacedCodeFilter(analyzer);
const { upload, dropped } = keepInterfacedResults(full!, filter);
assert.equal(upload.results.length, 2, 'only HBA1C and EAG-MGDL are staged');
assert.deepEqual(dropped.sort(), ['EAG-MMOL', 'HBA0', 'HBA1A', 'HBA1B', 'HBA1C-IFCC', 'HBF', 'LA1C']);
console.log('✓ intake: 9 → 2 (HBA1C 5.1 %, EAG-MGDL 99.1 mg/dL)');

// ---- 3) join: both land on their HMIS parameter, sample completes -------
const joined = toLisResultRows(upload, rows, undefined, analyzer.testCodeAliases, analyzer.ignoreTestCodes, analyzer.testCodeScale, analyzer.allowTestCodes, analyzer.excludeIdentifiers, analyzer.excludeParameterIds);
assert.equal(joined.rows.length, 2);
assert.deepEqual(joined.unmatched, []);
const by = new Map(joined.rows.map((r) => [r.identifier, r]));
assert.equal(by.get('HBA1C')!.parameterId, 1312);
assert.equal(by.get('HBA1C')!.resultValue, '5.1');
assert.equal(by.get('EAG-MGDL')!.parameterId, 1313);
assert.equal(by.get('EAG-MGDL')!.resultValue, '99.1');
assert.equal(by.get('HBA1C')!.sampleId, 'SF2609160013');

const store = new ResultStore(mkdtempSync(join(tmpdir(), 'lab-connector-gh900-')));
store.upsert(upload);
const before = summarize(store.get('SF2609160013')!);
assert.equal(before.total, 2, 'console: "0 of 2"');
store.markFiled('SF2609160013', joined.filedCodes, new Date().toISOString());
const after = summarize(store.get('SF2609160013')!);
assert.equal(after.filed, 2);
assert.equal(after.complete, true, 'sample is complete once HMIS has its two parameters');
console.log('✓ join: HBA1C → 1312, EAG-MGDL → 1313; sample completes at 2 of 2');

// ---- 4) orders view: both HMIS rows will sync -----------------------------
for (const r of rows) assert.equal(willSyncIdentifier(r.identifier, analyzer, r.parameterId), true, `${r.identifier} syncs`);
console.log('✓ orders view: HBA1C and EAG-MGDL both marked sync');

// ---- 5) a QC-material run never reaches HMIS ------------------------------
{
  const qc = parseGh900Sample(live.replace('0350010001026', '0350010001226')); // blood type 0x32
  assert.equal(qc.bloodType, 'qc');
  const qmsg: ParsedMessage = { ...msg, results: qc.results, isQc: true };
  const [u] = toResultUploads(analyzer, qmsg);
  assert.equal(u!.isQc, true, 'QC flag carried from the block, upload is not filed (qc.upload=false)');
  console.log('✓ QC material run flagged, kept out of HMIS');
}

console.log('gh900-hmis-join: all checks passed');
