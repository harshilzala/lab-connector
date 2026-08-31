import { existsSync, readFileSync } from 'node:fs';
import { MllpDecoder } from '../src/codec/hl7/mllp.js';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';

// =============================================================================
// CORPUS REPLAY — run the ENTIRE production capture of the legacy Erba H360
// integration through this codec.
//
// hl7-h360.test.ts pins one message byte-for-byte. This is the breadth check:
// every MLLP block the analyzer ever sent the legacy middleware, deframed and
// parsed, cross-checked against what that middleware actually filed
// (InsertData_Param.txt). It is what turns "the sample I looked at works" into
// "the capture works".
//
//   npm run h360:corpus
//
// The logs live on the lab machine only, so this SKIPS cleanly elsewhere —
// it is a verification aid, not a gate for other environments.
// =============================================================================

const WIRE_LOG = 'E:/API_Integration/Devices/H360/H360.txt';
const FILED_LOG = 'E:/API_Integration/Devices/H360/InsertData_Param.txt';

if (!existsSync(WIRE_LOG)) {
  console.log(`\n  SKIP — legacy capture not present on this machine.\n         expected ${WIRE_LOG}\n`);
  process.exit(0);
}

const G = '\x1b[32m✓\x1b[0m';
const B = '\x1b[31m✗\x1b[0m';
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? G : B} ${label}${detail ? `  ${detail}` : ''}`);
};

// The capture is one log line per direction: "<ts>:<ip> : <port>: (R):<MLLP block>".
// Feed the inbound blocks straight into the decoder — framing bytes and all —
// exactly as they arrived off the socket.
const raw = readFileSync(WIRE_LOG).toString('latin1');
const inbound: Buffer[] = [];
for (const line of raw.split('\n')) {
  const at = line.indexOf('(R):');
  if (at === -1) continue;
  inbound.push(Buffer.from(line.slice(at + 4), 'latin1'));
}

console.log(`\nH360 corpus — ${inbound.length} inbound blocks from ${WIRE_LOG}\n`);

// ---- 1) deframe + parse every block ----------------------------------------
const decoder = new MllpDecoder('latin1');
const samples = new Map<string, Map<string, string>>(); // barcode → code → value
let blocks = 0;
let parsedOk = 0;
let noResults = 0;
const errors: string[] = [];
const messageTypes = new Map<string, number>();

for (const chunk of inbound) {
  for (const text of decoder.push(chunk)) {
    blocks++;
    try {
      const msg = parseHl7(text);
      messageTypes.set(msg.messageType, (messageTypes.get(msg.messageType) ?? 0) + 1);
      const parsed = hl7ToParsedMessage(msg);
      if (!parsed) {
        noResults++;
        continue;
      }
      parsedOk++;
      for (const r of parsed.results) {
        const bySample = samples.get(r.sampleId) ?? new Map<string, string>();
        bySample.set(r.testCode, r.value);
        samples.set(r.sampleId, bySample);
      }
    } catch (err) {
      errors.push(`${(err as Error).message} :: ${text.slice(0, 60)}`);
    }
  }
}

check('every block deframed', blocks === inbound.length, `${blocks}/${inbound.length}`);
check('no parse errors', errors.length === 0, errors.length ? errors[0]! : '');
check('every message carried results', noResults === 0, `${parsedOk} with results, ${noResults} without`);
check(
  'only ORU^R01 in the capture',
  [...messageTypes.keys()].every((t) => t === 'ORU^R01'),
  [...messageTypes].map(([t, n]) => `${t}×${n}`).join(' '),
);
// The log terminates each line with its own CR LF after the MLLP trailer, so a
// stray CR is left over at the very end. What matters is that no PARTIAL
// message is stranded — flushUnframed only yields something if it starts MSH.
check(
  'decoder stranded no partial message',
  decoder.flushUnframed().length === 0,
  `${decoder.pending} byte(s) of log line-terminator left`,
);

// ---- 2) analyte set matches what the legacy middleware filed ---------------
const seenCodes = new Set<string>();
for (const bySample of samples.values()) for (const code of bySample.keys()) seenCodes.add(code);

if (existsSync(FILED_LOG)) {
  const filed = new Set(
    readFileSync(FILED_LOG, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('@p_test_ID'))
      .map((l) => l.split(':')[1]!.trim()),
  );
  const extra = [...seenCodes].filter((c) => !filed.has(c));
  const missing = [...filed].filter((c) => !seenCodes.has(c));
  check('no analyte the legacy system never filed', extra.length === 0, extra.join(', '));
  check('every analyte the legacy system filed', missing.length === 0, missing.join(', '));
} else {
  console.log(`  – skipped analyte cross-check (${FILED_LOG} absent)`);
}

// ---- 3) shape of what we would upload --------------------------------------
const perSample = [...samples.values()].map((m) => m.size);
const min = Math.min(...perSample);
const max = Math.max(...perSample);
check('every sample yielded analytes', min > 0, `${min}..${max} per sample`);
check('no barcode is blank', ![...samples.keys()].some((k) => k.trim() === ''));

console.log(
  `\n  ${samples.size} distinct barcodes, ${seenCodes.size} distinct analytes, ` +
    `${perSample.reduce((a, b) => a + b, 0)} results total`,
);
console.log(`  analytes: ${[...seenCodes].sort().join(' ')}`);

console.log(failures === 0 ? '\nH360 CORPUS REPLAY PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
