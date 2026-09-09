// =============================================================================
// ABL9 → HMIS: the interface is scoped to the parameters HMIS registers.
//
// The lab supplied the ZCCEQ005 equipment-parameter table on 2026-09-08. Four
// services run on this analyzer and they share one parameter set:
//
//   Arterial Blood Gas(ABG)*   18 parameters
//   Venous Blood Gas (VBG)*    17 — the same list without T
//   Bicarbonate(HCO3)-Serum     1 — HCO3-
//   Ionized Calcium*            1 — Ca++
//
// The instruction was: file those, file nothing else, and do not leave the
// sample waiting once they are in. This replays the ENTIRE legacy production
// capture (E:\Devices_Cancer\ABL9\Communi_Data.Log — 414 real envelopes)
// through the SAME join the staged filer runs, against a synthetic ABG order
// carrying one pending row per HMIS identifier, and pins:
//
//   filed      only codes named in config.json allowTestCodes
//   ignored    every other channel the analyzer sends
//   unmatched  nothing, ever — so no value is re-queued or left waiting for a
//              parameter HMIS does not interface
//
// It also pins the finding that shaped the list: FIO2 and T are operator-
// entered on the ABL9 and this site does not enter them, so they never arrive
// in 414 samples. They stay in the allow-list because HMIS asks for them, but
// the ABG order cannot close on the HMIS side until the lab either enters them
// on the analyzer or removes them from the ZCCEQ005 mapping.
//
// Run: npx tsx test/abl9-allow-codes.test.ts   (npm run abl9:allow)
// =============================================================================
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Abl9Link } from '../src/codec/abl9/link.js';
import { EOT, SOH } from '../src/codec/astm/control.js';
import { logger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import type { Transport } from '../src/transport/types.js';
import type { MirthAcknowledgeItem, ParsedMessage } from '../src/types.js';

const root = resolve(import.meta.dirname, '..');
const CAPTURE = 'E:/Devices_Cancer/ABL9/Communi_Data.Log';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'cancer-abl9');
// This is a site replay: it needs cancer-abl9 in the local config.json plus that
// machine's wire log and order store. Those are lab-floor artefacts (they carry
// patient barcodes) and are deliberately not in the repo — skip rather than fail
// when running anywhere other than the site PC.
if (!analyzer) {
  console.log('SKIP: cancer-abl9 is not in this config.json — site replay test');
  process.exit(0);
}

const allow = analyzer.allowTestCodes;
const upper = (s: string) => s.trim().toUpperCase();
const allowSet = new Set(allow.map(upper));

// ---- the list itself ---------------------------------------------------------
check(allow.length === 18, `config lists ${allow.length} interfaced parameters (HMIS registers 18)`);
check(allowSet.size === allow.length, 'no duplicate in allowTestCodes');
check(
  allow.every((c) => !c.includes('*')),
  'no wildcards — an allow-list is read literally, so "Anion gap" cannot admit "Anion gap (K+)"',
);
for (const code of ['pH', 'pCO2', 'pO2', 'HCO3-', 'Ca++', 'FIO2', 'T']) {
  check(allowSet.has(upper(code)), `HMIS identifier ${code} is interfaced`);
}
check(!allowSet.has(upper('Anion gap (K+)')), '"Anion gap (K+)" is a different HMIS parameter and stays out');

// ---- replay the whole legacy capture ----------------------------------------
class FakeTransport extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  readonly connected = true;
  readonly describe = 'tcp://fake';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(): Promise<void> {}
}

const cap = readFileSync(resolve(CAPTURE));
const envelopes: Buffer[] = [];
for (let i = 0; ; ) {
  const s = cap.indexOf(SOH, i);
  if (s === -1) break;
  const e = cap.indexOf(EOT, s);
  if (e === -1) break;
  envelopes.push(cap.subarray(s, e + 1));
  i = e + 1;
}

const transport = new FakeTransport();
const link = new Abl9Link(transport, { logger: logger.child({ test: 'abl9-allow' }), sampleIdFrom: 'patient' });
const msgs: ParsedMessage[] = [];
link.on('message', (m: ParsedMessage) => msgs.push(m));
link.on('error', () => {});
await link.start();
transport.emit('data', Buffer.concat(envelopes));
await new Promise((r) => setImmediate(r));

check(msgs.length === envelopes.length, `${msgs.length} of ${envelopes.length} production envelopes parsed`);

// ---- the ABG order HMIS raises: one pending row per registered identifier ----
const orderRows = (sampleId: string): MirthAcknowledgeItem[] =>
  allow.map((identifier, n) => ({
    sampleID: sampleId,
    equipmentId: 28746509,
    identifier,
    ipAddress: '10.11.100.59',
    isTransmitted: true,
    labResultId: 900000,
    labServiceId: 3200,
    portNo: '4001',
    parameterId: 5000 + n,
  }));

// ---- join every sample the analyzer ever sent -------------------------------
const filedCodes = new Map<string, number>();
const ignoredCodes = new Map<string, number>();
const voidedCodes = new Map<string, number>();
/** Every code that survived intake, i.e. arrived carrying an actual value. */
const receivedCodes = new Set<string>();
const perSampleCounts = new Set<number>();
let samples = 0;
let unmatchedTotal = 0;
let unaccounted = 0;
let leaked: string[] = [];

for (const m of msgs) {
  for (const upload of toResultUploads(analyzer, m)) {
    if (upload.isQc) continue; // controls are filtered at intake, not filed
    samples++;
    perSampleCounts.add(upload.results.length);
    for (const r of upload.results) receivedCodes.add(r.testCode);
    const joined = toLisResultRows(
      upload,
      orderRows(upload.barcode),
      undefined,
      analyzer.testCodeAliases,
      analyzer.ignoreTestCodes,
      analyzer.testCodeScale,
      analyzer.allowTestCodes,
    );
    unmatchedTotal += joined.unmatched.length;
    if (joined.rows.length + joined.ignored.length + joined.voided.length !== upload.results.length) unaccounted++;
    for (const r of joined.rows) {
      filedCodes.set(r.identifier, (filedCodes.get(r.identifier) ?? 0) + 1);
      if (!allowSet.has(upper(r.identifier))) leaked.push(r.identifier);
    }
    for (const c of joined.ignored) ignoredCodes.set(c, (ignoredCodes.get(c) ?? 0) + 1);
    for (const c of joined.voided) voidedCodes.set(c, (voidedCodes.get(c) ?? 0) + 1);
  }
}

console.log(`\n${samples} patient samples joined`);
console.log(`  filed   : ${[...filedCodes.keys()].sort().join(', ')}`);
console.log(`  ignored : ${[...ignoredCodes.keys()].sort().join(', ')}`);
console.log(`  void    : ${[...voidedCodes.keys()].sort().join(', ')}\n`);

check(samples > 0, 'the capture contains patient samples to join');
check(leaked.length === 0, `nothing outside the interface was filed${leaked.length ? ` — LEAKED: ${[...new Set(leaked)].join(', ')}` : ''}`);
check(
  unmatchedTotal === 0,
  `no value is ever left unmatched (${unmatchedTotal} across ${samples} samples) — nothing re-queued, nothing waiting on a parameter HMIS does not interface`,
);
check(unaccounted === 0, 'every value the analyzer sent is accounted for: filed, ignored or void');

// ---- the measured analytes must all reach HMIS ------------------------------
// The nine ^M channels are the blood gas itself. If the allow-list ever loses
// one, a real number silently stops reaching the patient's report.
const MEASURED = ['pH', 'pCO2', 'Hct', 'pO2', 'K+', 'Na+', 'Ca++', 'Cl-', 'Lac'];
const lost = MEASURED.filter((c) => !filedCodes.has(c));
check(lost.length === 0, `every measured analyte files${lost.length ? ` — LOST: ${lost.join(', ')}` : ''}`);

// The calculated channels HMIS does register must file too.
const CALCULATED_INTERFACED = ['HCO3-', 'ABE', 'tCO2(P)', 'tCO2(B)', 'tHb', 'sO2', 'Anion gap'];
const missing = CALCULATED_INTERFACED.filter((c) => !filedCodes.has(c));
check(missing.length === 0, `the interfaced calculated channels file${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}`);

// ---- FIO2 and T: requested by HMIS, never sent by this analyzer -------------
check(
  !receivedCodes.has('FIO2') && !receivedCodes.has('T'),
  'FIO2 and T never arrive in 414 samples — operator-entered, and this site does not enter them',
);
// The 14 channels derived from temperature and FIO2 are transmitted on every
// sample, but always as the ABL9's "....." no-result placeholder, so intake
// drops them before the join ever sees them. That is the same evidence from
// the other direction: the two inputs are not being entered on the analyzer.
const DERIVED = ['pH(T)', 'pCO2(T)', 'pO2(T)', 'pO2(A)', 'AaDpO2', 'a/ApO2', 'RI', 'cH+(T)', 'pO2(a)/FIO2'];
const arrived = DERIVED.filter((c) => receivedCodes.has(c));
check(
  arrived.length === 0,
  `every temperature/FIO2-derived channel arrives empty and is dropped at intake${arrived.length ? ` — GOT A VALUE FOR: ${arrived.join(', ')}` : ''}`,
);
const widest = Math.max(...perSampleCounts);
check(
  widest <= 24,
  `a sample carries at most 24 valued results out of the 38 codes transmitted (widest seen: ${widest}; counts: ${[...perSampleCounts].sort((a, b) => a - b).join(', ')})`,
);

// ---- a pending row cannot widen the interface on its own --------------------
const oneMsg = msgs.find((m) => toResultUploads(analyzer, m).length > 0)!;
const oneUpload = toResultUploads(analyzer, oneMsg)[0]!;
const withExtra = toLisResultRows(
  oneUpload,
  [...orderRows(oneUpload.barcode), { ...orderRows(oneUpload.barcode)[0]!, identifier: 'SBE', parameterId: -1 }],
  undefined,
  analyzer.testCodeAliases,
  analyzer.ignoreTestCodes,
  analyzer.testCodeScale,
  analyzer.allowTestCodes,
);
check(
  !withExtra.rows.some((r) => r.identifier === 'SBE'),
  'a new HMIS pending row for a non-interfaced code does not widen the interface by itself',
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
