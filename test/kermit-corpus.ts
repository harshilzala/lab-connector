import { existsSync, readFileSync } from 'node:fs';
import { KermitDecoder, checksum, tochar, unquote } from '../src/codec/kermit/packets.js';
import { buildOrderRecord, parseOrderRecord, parseResultFile } from '../src/codec/kermit/vitros250.js';

// =============================================================================
// CORPUS REPLAY — run the ENTIRE production capture of the legacy VITROS 250
// integration through this codec.
//
// The golden tests in kermit-check.ts pin a handful of messages. This one is
// the breadth check: every packet the analyzer and the legacy host exchanged,
// every order round-tripped back through our builder, every result record
// parsed. It is what turns "the samples I looked at work" into "the capture
// works".
//
//   npm run kermit:corpus
//
// The logs live on the lab machine only, so this SKIPS cleanly elsewhere —
// it is a verification aid, not a gate for other environments.
// =============================================================================

const TX_LOG = 'E:/API_Integration/Devices/250/Vitros250_String.txt';
const RX_LOG = 'E:/API_Integration/Devices/250/Vitros250_String_save.txt';
const TS = /^DateTime: \d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}/;

if (!existsSync(TX_LOG) || !existsSync(RX_LOG)) {
  console.log(`\n  SKIP — legacy capture not present on this machine.\n         expected ${TX_LOG}\n`);
  process.exit(0);
}

const G = '\x1b[32m✓\x1b[0m';
const B = '\x1b[31m✗\x1b[0m';
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? G : B} ${label}${detail ? `  ${detail}` : ''}`);
};

interface Run { file: string; payload: string }

/**
 * Rebuild transmissions from the legacy log. Outbound lines carry the whole
 * packet including SOH and LEN, so those are fed through the real decoder —
 * that exercises framing and checksums end to end. Inbound lines were logged
 * from the sequence number onward, so LEN is recomputed before checking.
 */
function readRuns(file: string, direction: 'TX' | 'RX') {
  const decoder = new KermitDecoder();
  const runs: Run[] = [];
  let cur: { file: string; parts: string[] } | null = null;
  let packets = 0;
  let badChecksums = 0;

  for (const line of readFileSync(file, 'latin1').split(/\r?\r?\n/)) {
    if (!TS.test(line)) continue;
    const rest = line.replace(TS, '');
    const outbound = rest.startsWith('INTERFACEPC:');
    if ((direction === 'TX') !== outbound) continue;

    let seq: number, type: string, data: string;
    if (outbound) {
      const raw = rest.slice('INTERFACEPC:'.length).replace(/^ +/, '');
      const decoded = decoder.push(Buffer.from(raw, 'latin1'));
      decoder.reset();
      if (decoded.length !== 1) continue;
      if (!decoded[0]!.valid) badChecksums++;
      ({ seq, type, data } = decoded[0]!.packet as { seq: number; type: string; data: string });
    } else {
      const body = rest.replace(/^ {2}/, '');
      if (body.length < 3) continue;
      type = body[1]!;
      if (!'SFDZBYNE'.includes(type)) continue;
      seq = body.charCodeAt(0) - 32;
      data = body.slice(2, -1);
      const covered = tochar(data.length + 3) + body.slice(0, -1);
      if (checksum(covered) !== body.slice(-1)) badChecksums++;
    }
    packets++;

    if (type === 'S') cur = { file: '', parts: [] };
    else if (!cur) continue;
    else if (type === 'F') cur.file = unquote(data);
    else if (type === 'D') cur.parts.push(unquote(data));
    else if (type === 'B') {
      if (cur.parts.length) runs.push({ file: cur.file, payload: cur.parts.join('') });
      cur = null;
    }
  }
  return { runs, packets, badChecksums };
}

console.log('\n=== VITROS 250 corpus replay ===\n');

// ---- Outbound: every captured order must rebuild byte-for-byte -------------
const tx = readRuns(TX_LOG, 'TX');
console.log(`[orders]  ${tx.runs.length} transmissions, ${tx.packets} packets`);
check('every outbound packet framed + checksummed by our decoder', tx.badChecksums === 0, `bad=${tx.badChecksums}`);

let rebuilt = 0;
const mismatches: string[] = [];
for (const run of tx.runs) {
  const parsed = parseOrderRecord(run.payload);
  if (!parsed) { mismatches.push(`unparseable: ${JSON.stringify(run.payload)}`); continue; }
  const again = buildOrderRecord({
    sampleId: parsed.sampleId,
    testCodes: parsed.testCodes,
    priority: 'R',
    patient: { patientId: null, lastName: parsed.name, firstName: null, middleName: null, sex: null, birthDate: null },
    specimenType: null,
  });
  if (again === run.payload) rebuilt++;
  else if (mismatches.length < 3) mismatches.push(`got  ${JSON.stringify(again)}\n      want ${JSON.stringify(run.payload)}`);
}
check('every captured order rebuilds byte-for-byte', rebuilt === tx.runs.length, `${rebuilt}/${tx.runs.length}`);
for (const m of mismatches.slice(0, 3)) console.log(`      ${m}`);

// ---- Inbound: every captured result record must parse ----------------------
const rx = readRuns(RX_LOG, 'RX');
console.log(`\n[results] ${rx.runs.length} transmissions, ${rx.packets} packets`);
check('every inbound packet checksums', rx.badChecksums === 0, `bad=${rx.badChecksums}`);

let records = 0, values = 0, flagged = 0, noResult = 0;
const samples = new Set<string>();
for (const run of rx.runs) {
  const msg = parseResultFile(run.payload);
  records += run.payload.split(']').filter((c) => c.length > 48).length;
  for (const r of msg.results) {
    values++;
    if (r.abnormalFlag) flagged++;
    samples.add(r.sampleId);
    if (!/\d/.test(r.value)) noResult++;
  }
}
check('parsed results from every transmission', values > 0, `${values} results across ${samples.size} samples`);
check('no non-numeric value was filed', noResult === 0, `bad=${noResult}`);
console.log(`      ${records} records, ${values} results, ${flagged} carrying alarm flags`);

console.log(failures ? `\n${B} corpus replay FAILED (${failures})\n` : `\n${G} corpus replay clean\n`);
process.exit(failures ? 1 : 0);
