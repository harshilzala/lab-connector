// =============================================================================
// ABL9 SOH…EOT link, replayed from the ENTIRE legacy production capture.
//
// E:\Devices_Cancer\ABL9\Communi_Data.Log is a month of real traffic recorded
// by the retired .NET middleware: 414 SOH…EOT envelopes, one H| record each,
// records separated by a bare CR, no E1381 framing anywhere in 950 KB.
//
// This test feeds those exact bytes to Abl9Link and pins:
//
//   • all 414 envelopes parse, with the ZC tube barcode read off the P record
//   • one ACK byte is written per message, as the legacy host did
//   • an envelope split across many TCP reads is reassembled
//   • several envelopes arriving in ONE read are all consumed
//   • a partial envelope is not glued onto the next one after a disconnect
//   • AstmLink — the link this analyzer was wrongly configured to use — parses
//     ZERO of them. That is the regression this whole codec exists to prevent.
//
// Run: npx tsx test/abl9-protocol.test.ts
// =============================================================================
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Abl9Link } from '../src/codec/abl9/link.js';
import { AstmLink } from '../src/codec/astm/link.js';
import { ACK, EOT, SOH } from '../src/codec/astm/control.js';
import { logger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { isQcSample, toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import type { Transport } from '../src/transport/types.js';
import type { ParsedMessage } from '../src/types.js';

const CAPTURE = 'E:/Devices_Cancer/ABL9/Communi_Data.Log';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

// ---- a transport that just records what the link writes ---------------------
class FakeTransport extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  readonly connected = true;
  readonly describe = 'tcp://fake';
  written: number[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    for (const b of d) this.written.push(b);
  }
}

async function run(feed: (t: FakeTransport) => void): Promise<{ msgs: ParsedMessage[]; t: FakeTransport }> {
  const t = new FakeTransport();
  const link = new Abl9Link(t, { logger: logger.child({ test: 'abl9' }), sampleIdFrom: 'patient' });
  const msgs: ParsedMessage[] = [];
  link.on('message', (m: ParsedMessage) => msgs.push(m));
  link.on('error', () => {});
  await link.start();
  feed(t);
  await new Promise((r) => setImmediate(r));
  return { msgs, t };
}

// ---- pull the real envelopes out of the capture ------------------------------
const cap = readFileSync(resolve(CAPTURE));
const envelopes: Buffer[] = [];
for (let i = 0; ; ) {
  const s = cap.indexOf(SOH, i);
  if (s === -1) break;
  const e = cap.indexOf(EOT, s);
  if (e === -1) break;
  envelopes.push(cap.subarray(s, e + 1)); // SOH … EOT inclusive
  i = e + 1;
}
console.log(`capture: ${envelopes.length} SOH…EOT envelopes, ${cap.length} bytes\n`);
check(envelopes.length === 414, `all 414 production envelopes recovered from the capture`);

// ---- 1. every envelope parses -------------------------------------------------
const whole = Buffer.concat(envelopes);
const all = await run((t) => t.emit('data', whole));
check(all.msgs.length === 414, `all 414 envelopes parsed (got ${all.msgs.length})`);

const acks = all.t.written.filter((b) => b === ACK).length;
check(acks === 414, `one ACK per message — ${acks} ACKs written, and nothing else (${all.t.written.length} bytes total)`);
check(all.t.written.every((b) => b === ACK), 'the link writes ACK bytes ONLY — it never transmits to this analyzer');

const withResults = all.msgs.filter((m) => m.results.length > 0).length;
check(withResults === 414, `every message carried results (${withResults}/414)`);

// The capture splits cleanly in two: patient runs carrying a ZC tube barcode on
// the P record, and instrument runs the ABL9 sends with a BARE "P|1" and no id
// at all — 2-point calibrations ("O|1||Cal #^5835|…|SYSTEM|…|2 Point
// Calibration", sensor readings like "pH^Sens"). Those must never be filed, and
// they are not: with sampleIdFrom 'patient' the parser leaves their sampleId
// empty rather than falling back to the O record's "Cal #", and
// toResultUploads drops every result with no barcode.
const idOf = (m: ParsedMessage) => m.results[0]?.sampleId ?? '';
const zc = all.msgs.filter((m) => /^ZC/.test(idOf(m))).length;
const bare = all.msgs.filter((m) => idOf(m) === '').length;
const mrn = all.msgs.filter((m) => /^[0-9]{10,}$/.test(idOf(m))).length;
const shortNum = all.msgs.filter((m) => /^[0-9]{1,9}$/.test(idOf(m))).length;
const named = all.msgs.filter((m) => idOf(m) !== '' && !/^(ZC|[0-9])/.test(idOf(m))).length;
check(zc === 316, `316 patient messages carry a ZC tube barcode (got ${zc})`);
check(bare === 71, `71 instrument runs carry no barcode at all (got ${bare})`);
check(mrn === 21, `21 messages carry a 14-digit MRN instead of the tube barcode (got ${mrn})`);
check(shortNum === 3, `3 carry a short typed number (got ${shortNum})`);
check(named === 3, `3 carry free text — a patient name, "split", "Abg qc 1" (got ${named})`);
check(zc + bare + mrn + shortNum + named === 414, 'the five buckets account for all 414 messages');

// The ABL9 DOES send explicit control runs, typed as "Abg qc 1" in this corpus
// and "ABG QC 2" in production on 2026-09-07. The QC/CTRL/CONTROL prefixes
// cannot catch them (they begin "Abg"), so qc.sampleIdRegex must — the lab
// asked (2026-09-08) that this kind of run never reach HMIS.
const abgQc = all.msgs.filter((m) => /qc/i.test(idOf(m))).map(idOf);
check(abgQc.length === 1 && abgQc[0] === 'Abg qc 1', `the corpus carries one explicit control run, "${abgQc[0]}"`);

const cfg = loadConfig(resolve(import.meta.dirname, '..', 'config.json'));
const abl9Cfg = cfg.analyzers.find((a) => a.id === 'cancer-abl9');
if (!abl9Cfg) throw new Error('cancer-abl9 is not configured');

const QC_IDS = ['Abg qc 1', 'ABG QC 2', 'abg qc 3', 'ABG-QC2', 'ABGQC', 'QC 4', 'qc-1'];
const NOT_QC_IDS = ['ZC2608030162', '10002022335146', '33059', 'Gulambhai', 'split', 'Marqcus', ''];
for (const id of QC_IDS) check(isQcSample(id, abl9Cfg.qc), `"${id}" is a control run`);
for (const id of NOT_QC_IDS) check(!isQcSample(id, abl9Cfg.qc), `"${id || '(empty)'}" is NOT a control run`);
// Every id the analyzer actually sent that is not a control must stay visible.
const misfiled = all.msgs.map(idOf).filter((id) => id && !/qc/i.test(id) && isQcSample(id, abl9Cfg.qc));
check(misfiled.length === 0, `no real id in the corpus is swallowed as QC${misfiled.length ? ` — SWALLOWED: ${[...new Set(misfiled)].join(', ')}` : ''}`);

// Nothing without a barcode may ever become an upload.
let calUploads = 0;
for (const m of all.msgs) if (!m.results[0]?.sampleId) calUploads += toResultUploads(abl9Cfg, m).length;
check(calUploads === 0, `calibrations and other barcode-less runs produce 0 uploads (got ${calUploads})`);

// The SOH must be stripped before the records are handed on: left in place it
// sits at the head of the H record, "\x01H|" never matches "H", and the header
// is silently skipped. The wire log is the observable place that shows it.
const wireIn: string[] = [];
{
  const t2 = new FakeTransport();
  const l2 = new Abl9Link(t2, { logger: logger.child({ test: "soh" }), sampleIdFrom: "patient" });
  l2.on("wire", (w: { direction: string; text: string }) => { if (w.direction === "IN") wireIn.push(w.text); });
  l2.on("error", () => {});
  await l2.start();
  t2.emit("data", envelopes[0]!);
  await new Promise((r) => setImmediate(r));
}
check(wireIn.length === 1 && wireIn[0]!.startsWith("H|"), `the SOH is stripped — the record stream starts at "H|" (got ${JSON.stringify(wireIn[0]?.slice(0, 14))})`);
check(all.msgs[0]?.sender === "ABL9", `the H record is therefore recognised, sender = ${all.msgs[0]?.sender}`);

// The very first message in the capture, checked value-by-value.
const first = all.msgs[0]!;
const byCode = new Map(first.results.map((r) => [r.testCode, r.value]));
check(first.results[0]?.sampleId === 'ZC2608030162', `first message barcode is ZC2608030162 (got ${first.results[0]?.sampleId})`);
check(byCode.get('pH') === '7.41', `pH = 7.41 (got ${byCode.get('pH')})`);
check(byCode.get('pCO2') === '45.2', `pCO2 = 45.2 (got ${byCode.get('pCO2')})`);
check(byCode.get('K+') === '4.00', `K+ = 4.00 (got ${byCode.get('K+')})`);
check(byCode.get('Na+') === '139', `Na+ = 139 (got ${byCode.get('Na+')})`);

// ---- ignoreTestCodes must never silence a MEASURED analyte -----------------
// The ABL9 marks each result ^M (measured) or ^C (calculated). Only calculated
// channels may be silenced; the nine measured ones are the ABG itself, and a
// wildcard or a careless entry that swallowed one would drop it from a
// patient report with no warning anywhere.
const MEASURED = ["pH", "pCO2", "Hct", "pO2", "K+", "Na+", "Ca++", "Cl-", "Lac"];
const silenced = new Set(
  toLisResultRows(
    toResultUploads(abl9Cfg, all.msgs[0]!)[0]!,
    [],
    undefined,
    abl9Cfg.testCodeAliases,
    abl9Cfg.ignoreTestCodes,
    abl9Cfg.testCodeScale,
  ).ignored,
);
const lost = MEASURED.filter((c) => silenced.has(c));
check(lost.length === 0, `no measured analyte is silenced by ignoreTestCodes${lost.length ? " — LOST: " + lost.join(", ") : ""}`);
check(
  abl9Cfg.ignoreTestCodes.every((c) => !c.includes("*")),
  "the ABL9 ignore list carries no wildcards — each silenced code is named in full",
);

// ---- 2. one envelope split across many reads ----------------------------------
const split = await run((t) => {
  const e = envelopes[0]!;
  for (let i = 0; i < e.length; i += 7) t.emit('data', e.subarray(i, i + 7));
});
check(split.msgs.length === 1, `an envelope split into 7-byte TCP reads is reassembled (got ${split.msgs.length})`);
check(
  split.msgs[0]?.results[0]?.sampleId === 'ZC2608030162',
  'the reassembled message is identical to the unsplit one',
);

// ---- 3. several envelopes in one read ------------------------------------------
const packed = await run((t) => t.emit('data', Buffer.concat(envelopes.slice(0, 5))));
check(packed.msgs.length === 5, `5 envelopes arriving in a single read are all consumed (got ${packed.msgs.length})`);

// ---- 4. a truncated envelope must not corrupt the next one ---------------------
const torn = await run((t) => {
  const a = envelopes[0]!;
  t.emit('data', a.subarray(0, Math.floor(a.length / 2))); // cut mid-record, no EOT
  t.emit('close'); // analyzer disconnects
  t.emit('data', envelopes[1]!); // reconnects and sends a whole one
});
check(torn.msgs.length === 1, `a torn envelope is dropped, not glued onto the next (got ${torn.msgs.length} message)`);
check(
  torn.msgs[0]?.results[0]?.sampleId === 'ZC2608030177',
  `the message after the tear parses cleanly (got ${torn.msgs[0]?.results[0]?.sampleId})`,
);

// ---- 5. THE REGRESSION GUARD ---------------------------------------------------
// AstmLink is what config.json used to point the ABL9 at. It must parse none of
// this — if it ever does, the SOH…EOT stream has been confused with E1381.
const at = new FakeTransport();
const astm = new AstmLink(at, {
  senderId: 'HMIS-LIS',
  receiverId: 'ABL9',
  ackTimeoutMs: 15000,
  frameMaxData: 240,
  dialect: 'atellica',
  sampleIdFrom: 'patient',
  logger: logger.child({ test: 'astm-control' }),
});
const astmMsgs: ParsedMessage[] = [];
astm.on('message', (m: ParsedMessage) => astmMsgs.push(m));
astm.on('error', () => {});
await astm.start();
at.emit('data', whole);
await new Promise((r) => setImmediate(r));
check(
  astmMsgs.length === 0,
  `AstmLink parses 0 of the 414 envelopes — this is why the ABL9 link was silent (got ${astmMsgs.length})`,
);

console.log(`\nparsed ${all.msgs.length} messages / ${all.msgs.reduce((n, m) => n + m.results.length, 0)} results`);
if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL ABL9 PROTOCOL TESTS PASSED');
