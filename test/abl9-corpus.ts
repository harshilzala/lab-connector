import { existsSync, readFileSync } from 'node:fs';
import { parseMessage } from '../src/codec/astm/records.js';
import { isQcSample, isVoidResult, toResultUploads } from '../src/mapping/mapper.js';
import { loadConfig } from '../src/config.js';

// =============================================================================
// CORPUS REPLAY — run the ENTIRE production capture of the legacy ABL9
// integration through this codec and mapper.
//
//   npx tsx test/abl9-corpus.ts
//
// The ABL9 is the one analyzer here whose barcode does not live where every
// other instrument puts it, and whose "no value" placeholder is neither empty
// nor the word "No Result". This replays a month of real traffic to show what
// the connector would actually derive and file for each message.
//
// The capture lives on the lab machine only, so this SKIPS cleanly elsewhere.
// =============================================================================

const CAPTURE = 'E:/Devices_Cancer/ABL9/Formated.Log';
if (!existsSync(CAPTURE)) {
  console.log(`No ABL9 capture at ${CAPTURE} — skipping.`);
  process.exit(0);
}

const cfg = loadConfig();
const abl9 = cfg.analyzers.find((a) => a.id === 'cancer-abl9');
if (!abl9) throw new Error('cancer-abl9 missing from config.json');

// The legacy logger stripped the CR between records; put the boundaries back.
function records(line: string): string[] {
  const flat = line.slice(line.indexOf('FormateData : ') + 'FormateData : '.length);
  return flat
    .replace(/(?=[PORCL]\|\d+\|)/g, '\u0001')
    .split('\u0001')
    .map((s) => s.trim())
    .filter(Boolean);
}

const lines = readFileSync(CAPTURE, 'latin1').split(/\r?\n/).filter(Boolean);

let parsed = 0;
let noSample = 0;
let filedMessages = 0;
let filedValues = 0;
let voided = 0;
let qc = 0;
const idShapes: Record<string, number> = {};
const voidedAnalytes: Record<string, number> = {};
const sampleIds = new Set<string>();

for (const line of lines) {
  const recs = records(line);
  const msg = parseMessage(recs, recs.join('\r'), abl9.astm.dialect, { sampleIdFrom: abl9.astm.sampleIdFrom });
  parsed++;

  voided += msg.results.filter((r) => isVoidResult(r.value)).length;
  for (const r of msg.results) if (isVoidResult(r.value)) voidedAnalytes[r.testCode] = (voidedAnalytes[r.testCode] ?? 0) + 1;

  const uploads = toResultUploads(abl9, msg);
  if (uploads.length === 0) {
    noSample++;
    continue;
  }
  for (const u of uploads) {
    sampleIds.add(u.barcode);
    const shape = /^ZC\d{10}$/.test(u.barcode)
      ? 'ZC + 10 digits (the tube barcode)'
      : /^\d{14}$/.test(u.barcode)
        ? '14 digits (an MRN typed instead of the barcode)'
        : /^\d+$/.test(u.barcode)
          ? 'bare numeric (short)'
          : /^ZC/.test(u.barcode)
            ? 'ZC + wrong length (mis-scan)'
            : 'other';
    idShapes[shape] = (idShapes[shape] ?? 0) + 1;
    if (isQcSample(u.barcode, abl9.qc)) qc++;
    filedMessages++;
    filedValues += u.results.length;
  }
}

console.log(`ABL9 corpus: ${parsed} messages\n`);
console.log(`  messages that build an upload       ${filedMessages}`);
console.log(`  messages with NO usable sample id   ${noSample}   (dropped at intake, nothing to file against)`);
console.log(`  distinct sample ids                 ${sampleIds.size}`);
console.log(`  values that would be sent           ${filedValues}`);
console.log(`  values dropped as void              ${voided}   ("....."  "?..."  empty)`);
console.log(`  uploads classed as QC by config     ${qc}\n`);

console.log('  sample-id shapes:');
for (const [k, v] of Object.entries(idShapes).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);

console.log('\n  void drops by analyte (top 12):');
for (const [k, v] of Object.entries(voidedAnalytes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12))
  console.log(`    ${String(v).padStart(5)}  ${k}`);
