// =============================================================================
// BC-6000 → HMIS CBC join, replayed from the real wire frame.
//
// CH2609070001 (2026-09-07) is the first CBC this site filed. The analyzer sent
// 63 NM values; HMIS raised 38 parameter rows for the panel, of which only 22
// carry the analyzer's own mnemonic in eqIdntifier. This test replays that exact
// frame from logs/wire-cancer-bc6000.log against the cached order rows and pins
// the three-way split the connector must produce:
//
//   filed      the 22 analytes HMIS can actually take
//   ignored    the 28 research channels and "…-IM" flag scores, which are not
//              results and must never be re-queued
//   unmatched  the 13 genuine analytes still missing an HMIS row — these stay
//              visible on purpose so the master-data gap is not papered over
//
// NOTE: this exercises ignoreTestCodes on its own. In production the BC-6000
// also carries allowTestCodes (the 22 interfaced values), which drops those 13
// as well — see test/bc6000-allow-codes.test.ts for the join as it actually runs.
//
// Run: npx tsx test/bc6000-ignore-codes.test.ts
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

// ---- the frame the analyzer actually sent -----------------------------------
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

// The wire log renders the MLLP block characters as <VT>/<FS> so the line stays
// readable; strip them to get back the HL7 the codec saw.
const parsed = hl7ToParsedMessage(parseHl7(wire.text.replace(/<VT>|<FS>/g, '').trim()), {
  valueTypes: analyzer.hl7.valueTypes,
});
if (!parsed) throw new Error(`${BARCODE} carried no filable result`);
const uploads = toResultUploads(analyzer, parsed);
const upload = uploads.find((u) => u.barcode === BARCODE);
if (!upload) throw new Error(`${BARCODE} did not survive intake`);

// ---- the order rows HMIS raised for it --------------------------------------
const order = JSON.parse(
  readFileSync(resolve(root, `spool/cancer-bc6000/orders/${BARCODE}.json`), 'utf8'),
) as { rows: MirthAcknowledgeItem[] };

const join = (ignore: string[]) =>
  toLisResultRows(upload, order.rows, undefined, analyzer.testCodeAliases, ignore);

const before = join([]);
const after = join(analyzer.ignoreTestCodes);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

console.log(`analyzer sent ${upload.results.length} values; HMIS raised ${order.rows.length} parameter rows\n`);

check(
  after.rows.length === 22 && before.rows.length === 22,
  `filing is untouched: ${after.rows.length} rows filed, same as before the filter`,
);
check(
  after.rows.map((r) => r.identifier).join() === before.rows.map((r) => r.identifier).join(),
  'the filed identifiers are identical — the filter cannot change what reaches a patient record',
);
// 39 and 26, not 41 and 28: this frame reports H-NR% and L-NR% as "****", the
// BC-6000's withheld-value marker, and intake drops a placeholder before the
// join sees it (see isVoidResult). Both sit on ignoreTestCodes anyway, so the
// filter's job — and the 22 filed above — are unchanged.
check(
  before.unmatched.length === 39 && after.unmatched.length === 13,
  `re-queued remainder drops from ${before.unmatched.length} codes to ${after.unmatched.length}`,
);
check(after.ignored.length === 26, `${after.ignored.length} research channels and flag scores dropped`);

// The 13 that must SURVIVE as unmatched: genuine analytes whose HMIS row is
// registered under a bare number instead of the analyzer mnemonic.
const REPORTABLE = [
  'IMG#', 'IMG%', 'RDW-SD', 'PLCC', 'PLCR', 'NRBC#', 'NRBC%',
  'Micro#', 'Micro%', 'Macro#', 'Macro%', 'PDW-SD', 'CORRECTED WBC',
];
const stillUnmatched = new Set(after.unmatched);
const swallowed = REPORTABLE.filter((c) => !stillUnmatched.has(c));
check(swallowed.length === 0, `every genuine analyte stays visible as unmatched${swallowed.length ? ` — SWALLOWED: ${swallowed.join(', ')}` : ''}`);

// Nothing filable may ever be silenced.
const filed = new Set(after.rows.map((r) => r.identifier.toUpperCase()));
const silencedButFilable = after.ignored.filter((c) => filed.has(c.toUpperCase()));
check(silencedButFilable.length === 0, 'no ignored code also matched a pending row');

check(
  after.ignored.filter((c) => /-IM$/i.test(c)).length === 13,
  'the 13 "…-IM" suspect-flag scores are caught by the single "*-IM" entry',
);
check(
  after.ignored.some((c) => /^InR/i.test(c)) && after.ignored.filter((c) => /^InR/i.test(c)).length === 2,
  'both InR channels are caught by "InR*" without needing the per-mille character in config',
);

console.log(`\nstill unmatched (${after.unmatched.length}): ${after.unmatched.join(', ')}`);

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL BC-6000 IGNORE-CODE TESTS PASSED');
