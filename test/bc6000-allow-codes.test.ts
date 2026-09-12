// =============================================================================
// BC-6000 → HMIS: the interface is scoped to 22 values.
//
// The lab's instruction (2026-09-07): the BC-6000 interfaces exactly the 22 CBC
// analytes HMIS registers under the analyzer mnemonic, and the connector must
// not try to add the instrument's other channels to HMIS. This replays the
// CH2609070001 frame from logs/wire-cancer-bc6000.log through the SAME join the
// orchestrator runs (aliases, ignore list, scale AND the allow-list) and pins:
//
//   filed      exactly the 22 listed in config.json allowTestCodes
//   ignored    the other codes the analyzer sent — including the 13
//              reportable analytes HMIS has not interfaced. 39 rather than 41
//              because this frame's H-NR% and L-NR% carry the "****"
//              withheld-value marker and are dropped at intake as placeholders.
//   unmatched  nothing, so no spool item is ever re-queued for a channel the
//              lab has chosen not to interface
//
// Run: npx tsx test/bc6000-allow-codes.test.ts   (npm run bc6000:allow)
// =============================================================================
import { readFileSync } from 'node:fs';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

const root = resolve(import.meta.dirname, '..');
const BARCODE = 'CH2609070001';

const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'cancer-bc6000');
// This is a site replay: it needs cancer-bc6000 in the local config.json plus that
// machine's wire log and order store. Those are lab-floor artefacts (they carry
// patient barcodes) and are deliberately not in the repo — skip rather than fail
// when running anywhere other than the site PC.
if (!analyzer) {
  console.log('SKIP: cancer-bc6000 is not in this config.json — site replay test');
  process.exit(0);
}

// Every day file of the wire log, oldest first — see DailyLogFile.files.
const wire = DailyLogFile.files(resolve(root, 'logs/wire-cancer-bc6000.log'))
  .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { direction: string; text: string })
  .find((e) => e.direction === 'IN' && e.text.includes(BARCODE));
if (!wire) {
  console.log(`SKIP: no inbound frame for ${BARCODE} in the local wire log`);
  process.exit(0);
}

const parsed = hl7ToParsedMessage(parseHl7(wire.text.replace(/<VT>|<FS>/g, '').trim()), {
  valueTypes: analyzer.hl7.valueTypes,
});
if (!parsed) throw new Error(`${BARCODE} carried no filable result`);
const upload = toResultUploads(analyzer, parsed).find((u) => u.barcode === BARCODE);
if (!upload) throw new Error(`${BARCODE} did not survive intake`);

const order = JSON.parse(
  readFileSync(resolve(root, `spool/cancer-bc6000/orders/${BARCODE}.json`), 'utf8'),
) as { rows: MirthAcknowledgeItem[] };

// The exact call the orchestrator makes at delivery time.
const full = toLisResultRows(
  upload,
  order.rows,
  undefined,
  analyzer.testCodeAliases,
  analyzer.ignoreTestCodes,
  analyzer.testCodeScale,
  analyzer.allowTestCodes,
);
// Without the allow-list, for comparison.
const without = toLisResultRows(
  upload,
  order.rows,
  undefined,
  analyzer.testCodeAliases,
  analyzer.ignoreTestCodes,
  analyzer.testCodeScale,
);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

console.log(`analyzer sent ${upload.results.length} values; HMIS raised ${order.rows.length} parameter rows\n`);

const allow = analyzer.allowTestCodes;
check(allow.length === 22, `config lists ${allow.length} interfaced values`);

// The HMIS equipment-parameter master for the CBC service, as supplied by the
// lab on 2026-09-08 (Cancer site, BC-6000). 38 rows: 22 carry the analyzer
// mnemonic as the identifier and are the interface; the other 16 carry a bare
// number and name analytes this instrument never produces (LUC%, MPC, MPM,
// Lobularity Index, Cellular Hb, Large Platelets …). Only the 22 may file.
const HMIS_CBC_MASTER: Array<[name: string, identifier: string]> = [
  ['WBC COUNT', 'WBC'], ['RBC COUNT', 'RBC'], ['MCH', 'MCH'], ['PLATELET COUNT', 'PLT'],
  ['HAEMOGLOBIN', 'HGB'], ['MCV', 'MCV'], ['MCHC', 'MCHC'], ['RDW-CV', 'RDW-CV'], ['MPV', 'MPV'],
  ['Neutrophils', 'NEU%'], ['Monocytes', 'MON%'], ['Eosinophils', 'EOS%'], ['Basophils', 'BAS%'],
  ['HEMATOCRIT', 'HCT'], ['% Hypochromasia #', '310'], ['% Hyperchromasia #', '300'],
  ['% Microcytosis #', '290'], ['% Macrocytosis #', '280'], ['Absolute Neutrophil count', 'NEU#'],
  ['Absolute Lymphocyte count*', 'LYM#'], ['Absolute Eosinophil count', 'EOS#'],
  ['Lobularity Index(LI) #', '26'], ['MPC (Mean platelet component) #', '660'], ['LUC% #', '25'],
  ['% Micro/% Hypo Ratio #', '460'], ['Lymphocytes', 'LYM%'], ['Left shift', '42'], ['ATYPS', '43'],
  ['Blast suspect flag', '44'], ['Cellular Hb #', '414'], ['WBC (P) #', '50'],
  ['PDW (Platelet Distribution Width)*', 'PDW'], ['PCT (Plateletcrit)*', 'PCT'],
  ['Large Platelets (>20fL) #', '76'], ['Platelet Clumps Counts #', '81'], ['MPM (Mean platelet mass)*', '101'],
  ['Absolute Monocyte Count', 'MON#'], ['Absolute Basophils Count', 'BAS#'],
];
const masterMnemonics = HMIS_CBC_MASTER.map(([, id]) => id).filter((id) => !/^[0-9]+$/.test(id));
const allowUpper = new Set(allow.map((c) => c.toUpperCase()));
const missing = masterMnemonics.filter((id) => !allowUpper.has(id.toUpperCase()));
const extra = allow.filter((c) => !masterMnemonics.some((id) => id.toUpperCase() === c.toUpperCase()));
check(HMIS_CBC_MASTER.length === 38 && masterMnemonics.length === 22, 'the HMIS master has 38 rows, 22 with an analyzer mnemonic');
check(missing.length === 0, `every mnemonic in the HMIS master is allowed${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}`);
check(extra.length === 0, `nothing is allowed that the HMIS master does not list${extra.length ? ` — EXTRA: ${extra.join(', ')}` : ''}`);
const numericSent = HMIS_CBC_MASTER.map(([, id]) => id)
  .filter((id) => /^[0-9]+$/.test(id))
  .filter((id) => upload.results.some((r) => r.testCode.toUpperCase() === id));
check(numericSent.length === 0, 'the BC-6000 never emits any of the 16 bare-number identifiers, so nothing outside the 22 can ever match');
check(new Set(allow.map((c) => c.toUpperCase())).size === allow.length, 'no duplicate in allowTestCodes');

check(full.rows.length === 22, `${full.rows.length} rows filed`);
const filed = new Set(full.rows.map((r) => r.identifier.toUpperCase()));
const notFiled = allow.filter((c) => !filed.has(c.toUpperCase()));
check(notFiled.length === 0, `every allowed code was filed${notFiled.length ? ` — MISSING: ${notFiled.join(', ')}` : ''}`);
const outside = full.rows.filter((r) => !allow.some((c) => c.toUpperCase() === r.identifier.toUpperCase()));
check(outside.length === 0, `nothing outside the 22 was filed${outside.length ? ` — LEAKED: ${outside.map((r) => r.identifier).join(', ')}` : ''}`);

check(
  full.rows.map((r) => r.identifier).join() === without.rows.map((r) => r.identifier).join(),
  'the allow-list files the same 22 the join already filed — it changes nothing on a patient record',
);

check(full.unmatched.length === 0, `nothing is left unmatched (was ${without.unmatched.length} without the allow-list) — no re-queue, no retry burn`);
// 39, not 41: this frame reports H-NR% and L-NR% as "****" — the BC-6000's
// withheld-value marker — and intake drops a placeholder before the join ever
// sees it (see isVoidResult). Both are research channels on ignoreTestCodes
// either way, so the interfaced 22 are untouched.
const INTAKE_DROPPED = ['H-NR%', 'L-NR%'];
check(full.ignored.length === 39, `${full.ignored.length} codes outside the interface dropped`);
check(
  upload.results.length === 61 && !upload.results.some((r) => INTAKE_DROPPED.includes(r.testCode)),
  `the 2 "****" placeholders (${INTAKE_DROPPED.join(', ')}) never reach the join`,
);
check(
  full.rows.length + full.ignored.length + full.voided.length + INTAKE_DROPPED.length === 63,
  'every value the analyzer sent is accounted for: filed, ignored, void or dropped at intake',
);

// The 13 reportable analytes HMIS has not interfaced must be DROPPED, not retried.
const NOT_INTERFACED = [
  'IMG#', 'IMG%', 'RDW-SD', 'PLCC', 'PLCR', 'NRBC#', 'NRBC%',
  'Micro#', 'Micro%', 'Macro#', 'Macro%', 'PDW-SD', 'CORRECTED WBC',
];
const ignored = new Set(full.ignored);
const retried = NOT_INTERFACED.filter((c) => !ignored.has(c));
check(retried.length === 0, `the 13 non-interfaced analytes are dropped, not re-queued${retried.length ? ` — STILL RETRIED: ${retried.join(', ')}` : ''}`);

// Unit conversion still runs on the allowed codes.
check(full.scaled.length === 0, 'no unit conversion on the way out — HMIS applies the WBC factor itself (lab, 2026-09-08)');

// A pending row that HMIS raises for a code outside the list must not pull it in.
const extraRow: MirthAcknowledgeItem = { ...order.rows[0], identifier: 'NRBC#', parameterId: -1 };
const withExtra = toLisResultRows(
  upload, [...order.rows, extraRow], undefined,
  analyzer.testCodeAliases, analyzer.ignoreTestCodes, analyzer.testCodeScale, analyzer.allowTestCodes,
);
check(
  withExtra.rows.length === 22 && !withExtra.rows.some((r) => r.identifier === 'NRBC#'),
  'a new HMIS pending row for a non-interfaced code does not widen the interface on its own',
);

// An empty allow-list means "no allow-list" — other analyzers are unaffected.
const none = toLisResultRows(upload, order.rows, undefined, analyzer.testCodeAliases, analyzer.ignoreTestCodes, analyzer.testCodeScale, []);
check(none.rows.length === without.rows.length && none.unmatched.length === without.unmatched.length, 'an empty allowTestCodes leaves the join unchanged');
// Only the two analyzers the lab has scoped are allow-listed. The ABL9 joined
// them on 2026-09-08 (see test/abl9-allow-codes.test.ts); the two VITROS file
// whatever HMIS raises a row for, so an allow-list there would be a silent way
// to lose an assay the lab adds later.
const SCOPED = new Set(['cancer-bc6000', 'cancer-abl9']);
for (const a of cfg.analyzers) {
  if (!SCOPED.has(a.id)) check(a.allowTestCodes.length === 0, `${a.id} carries no allow-list`);
}

console.log(`\nfiled (${full.rows.length}): ${full.rows.map((r) => r.identifier).join(', ')}`);
console.log(`dropped (${full.ignored.length}): ${full.ignored.join(', ')}`);

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL BC-6000 ALLOW-LIST TESTS PASSED');
