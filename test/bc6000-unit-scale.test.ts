// =============================================================================
// BC-6000 WBC/PLT unit handling, replayed from the real wire frame.
//
// The analyzer reports WBC and PLT in 10^9/L (equivalently 10*3/uL — the same
// number, only a different label). Until 2026-09-08 the connector multiplied
// both by 1000; the lab then confirmed that the factor is applied on the HMIS
// side (its CBC parameter master carries WBC 1000.0, everything else 1.0) and
// asked for the connector's factor to be removed. This test replays
// CH2609070001 from logs/wire-cancer-bc6000.log and pins that:
//
//   • config.json carries NO scale for the BC-6000
//   • WBC and PLT are filed exactly as the analyzer printed them (8.89, 226)
//   • no analyte's value changes on the way out at all
//   • the scaling mechanism itself still works when a factor IS configured,
//     for another analyzer or site — without a floating-point tail, and
//     without touching non-numeric values
//
// Run: npx tsx test/bc6000-unit-scale.test.ts
// =============================================================================
import { readFileSync } from 'node:fs';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { scaleResultValue, toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

const root = resolve(import.meta.dirname, '..');
const BARCODE = 'CH2609070001';

const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'cancer-bc6000');
if (!analyzer) throw new Error('cancer-bc6000 is not configured');

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

// ---- the frame the analyzer actually sent -----------------------------------
// Every day file of the wire log, oldest first — see DailyLogFile.files.
const wire = DailyLogFile.files(resolve(root, 'logs/wire-cancer-bc6000.log'))
  .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { direction: string; text: string })
  .find((e) => e.direction === 'IN' && e.text.includes(BARCODE));
if (!wire) throw new Error(`no inbound frame for ${BARCODE} in the wire log`);

const parsed = hl7ToParsedMessage(parseHl7(wire.text.replace(/<VT>|<FS>/g, '').trim()), {
  valueTypes: analyzer.hl7.valueTypes,
});
if (!parsed) throw new Error(`${BARCODE} carried no filable result`);
const upload = toResultUploads(analyzer, parsed).find((u) => u.barcode === BARCODE);
if (!upload) throw new Error(`${BARCODE} did not survive intake`);

const order = JSON.parse(
  readFileSync(resolve(root, `spool/cancer-bc6000/orders/${BARCODE}.json`), 'utf8'),
) as { rows: MirthAcknowledgeItem[] };

const join = (scales: Record<string, number>) =>
  toLisResultRows(
    upload,
    order.rows,
    undefined,
    analyzer.testCodeAliases,
    analyzer.ignoreTestCodes,
    scales,
    analyzer.allowTestCodes,
  );

// What the instrument put on the wire, for the before/after comparison.
const sent = new Map(upload.results.map((r) => [r.testCode.toUpperCase(), r.value]));
const valueOf = (run: ReturnType<typeof join>, code: string) =>
  run.rows.find((r) => r.identifier.toUpperCase() === code)?.resultValue;

// ---- the live configuration: no factor on this analyzer ---------------------
check(
  Object.keys(analyzer.testCodeScale).length === 0,
  `config.json carries no testCodeScale for the BC-6000 (got ${JSON.stringify(analyzer.testCodeScale)})`,
);

const live = join(analyzer.testCodeScale);
for (const code of ['WBC', 'PLT']) {
  check(valueOf(live, code) === sent.get(code), `${code} files exactly as sent: ${valueOf(live, code)} — HMIS applies its own factor`);
}
check(live.scaled.length === 0, 'no unit conversion is reported on the live configuration');
const moved = live.rows.filter((r) => r.resultValue !== sent.get(r.identifier.toUpperCase()));
check(
  moved.length === 0,
  `all ${live.rows.length} filed values are the analyzer's own numbers${moved.length ? ` — CHANGED: ${moved.map((r) => r.identifier).join(', ')}` : ''}`,
);

// ---- the mechanism still works when a factor IS configured ------------------
// (for another analyzer or site — it is not used here)
const plain = join({});
const scaledRun = join({ WBC: 1000, PLT: 1000 });
for (const code of ['WBC', 'PLT']) {
  const after = valueOf(scaledRun, code);
  const expected = String(Number(sent.get(code)) * 1000);
  check(after === expected, `with an explicit factor, ${code} ${sent.get(code)} would file as ${after}`);
  check(!/\.\d{6}/.test(after ?? ''), `${code} carries no floating-point tail: ${after}`);
}
check(
  scaledRun.scaled.length === 2 && scaledRun.scaled.every((s) => /^(WBC|PLT) /.test(s)),
  `exactly the two configured conversions are reported: ${scaledRun.scaled.join(', ')}`,
);
const leaked = scaledRun.rows.filter((r) => {
  const code = r.identifier.toUpperCase();
  if (code === 'WBC' || code === 'PLT') return false;
  return r.resultValue !== valueOf(plain, code);
});
check(leaked.length === 0, `a factor never leaks onto other analytes${leaked.length ? ` — LEAKED: ${leaked.map((r) => r.identifier).join(', ')}` : ''}`);
check(
  scaledRun.rows.length === plain.rows.length &&
    scaledRun.unmatched.length === plain.unmatched.length &&
    scaledRun.ignored.length === plain.ignored.length,
  `filed/unmatched/ignored unchanged by scaling at ${scaledRun.rows.length}/${scaledRun.unmatched.length}/${scaledRun.ignored.length}`,
);

// ---- the conversion helper itself ---------------------------------------------
check(scaleResultValue('8.89', 1000) === '8890', 'scaleResultValue("8.89", 1000) === "8890"');
check(scaleResultValue('226', 1000) === '226000', 'scaleResultValue("226", 1000) === "226000"');
check(scaleResultValue('6.03', 1000) === '6030', 'scaleResultValue("6.03", 1000) === "6030"');
check(scaleResultValue('0.01', 1000) === '10', 'scaleResultValue("0.01", 1000) === "10"');
check(scaleResultValue('<0.1', 1000) === '<0.1', 'a censored value is filed unchanged');
check(scaleResultValue('****', 1000) === '****', 'a non-numeric channel value is filed unchanged');
check(scaleResultValue('Normal', 1000) === 'Normal', 'a flag string is filed unchanged');

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL BC-6000 UNIT-SCALE TESTS PASSED');
