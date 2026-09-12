// =============================================================================
// Replay of CH2609080028 — the sample that reached HMIS "interfaced" and blank.
//
// Not a unit test with invented rows: this reads the REAL wire frame the
// BC-6000 sent and the REAL pending rows HMIS returned that day, both out of
// logs/, and runs them through the same join the orchestrator runs — once as it
// behaved on the day, once with the parameter catalogue warmed by the other
// samples of that morning, exactly as a running connector's would be.
//
// It reports rather than asserts, because it depends on log files that rotate.
//
// Run: npx tsx test/ch2609080028-replay.ts
// =============================================================================
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { toLisResultRows, toResultUploads } from '../src/mapping/mapper.js';
import { groupPendingByBarcode } from '../src/hmis/pending.js';
import { ParameterCatalogue } from '../src/orders/parameters.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

const BARCODE = 'CH2609080028';
const root = resolve(import.meta.dirname, '..');
const logs = resolve(root, 'logs');
const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as never;

const cfg = loadConfig(resolve(root, 'config.json'));
const analyzer = cfg.analyzers.find((a) => a.id === 'cancer-bc6000');
if (!analyzer) throw new Error('cancer-bc6000 is not configured');

// --- what the analyzer sent --------------------------------------------------
const frame = readdirSync(logs)
  .filter((f) => f.startsWith('wire-cancer-bc6000'))
  .flatMap((f) => readFileSync(join(logs, f), 'utf8').split('\n'))
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as { direction: string; text: string };
    } catch {
      return null;
    }
  })
  .find((e) => e && e.direction === 'IN' && e.text.includes(BARCODE) && e.text.includes('ORU^R01'));
if (!frame) throw new Error(`no ORU frame for ${BARCODE} in the wire logs`);

const parsed = hl7ToParsedMessage(parseHl7(frame.text.replace(/<VT>|<FS>/g, '').trim()), {
  valueTypes: analyzer.hl7.valueTypes,
});
if (!parsed) throw new Error('frame carried no filable result');
const upload = toResultUploads(analyzer, parsed).find((u) => u.barcode === BARCODE);
if (!upload) throw new Error(`${BARCODE} did not survive intake`);

// --- what HMIS offered -------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'replay-'));
const cat = new ParameterCatalogue(ParameterCatalogue.fileFor(dir), quiet);
const ackOpts = { eqCode: analyzer.equipmentCode, equipmentId: analyzer.equipmentId ?? null, ipAddress: '10.12.19.43', portNo: '4001' };

let ours: MirthAcknowledgeItem[] = [];
let polls = 0;
for (const file of readdirSync(logs).filter((f) => /^hmis-.*\.log$/.test(f)).sort()) {
  const text = readFileSync(join(logs, file), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"query"')) continue;
    let entry: { response?: { data?: unknown[] } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const data = entry.response?.data;
    if (!Array.isArray(data) || data.length === 0) continue;
    polls++;
    // Exactly what the order poller does with a reply.
    for (const [, pending] of groupPendingByBarcode(data, ackOpts)) {
      cat.learn(pending.ackItems);
      if (pending.sampleId.toUpperCase() === BARCODE && pending.ackItems.length > ours.length) {
        ours = pending.ackItems;
      }
    }
  }
}

const join_ = (rows: MirthAcknowledgeItem[]) =>
  toLisResultRows(upload, rows, undefined, analyzer.testCodeAliases, analyzer.ignoreTestCodes, analyzer.testCodeScale, analyzer.allowTestCodes);

const before = join_(ours);
const candidates = before.unmatched;
const { rows: rebuilt, unknown } = cat.synthesize(ours, candidates);
const after = join_([...ours, ...rebuilt]);

const counts = cat.counts();
console.log(`sample                ${BARCODE}`);
console.log(`pending polls read    ${polls}`);
console.log(`catalogue learned     ${counts.parameters} parameters across ${counts.services} services`);
console.log(`analyzer values       ${upload.results.length} (after intake dropped placeholders)`);
console.log(`HMIS rows offered     ${ours.length}  [${ours.map((r) => r.identifier).join(', ')}]`);
console.log('');
console.log(`BEFORE  filed ${before.rows.length}   waiting ${before.unmatched.length}   [${before.unmatched.join(', ')}]`);
console.log(`AFTER   filed ${after.rows.length}   waiting ${after.unmatched.length}   [${after.unmatched.join(', ')}]`);
console.log('');
console.log(`rebuilt (${rebuilt.length}): ${rebuilt.map((r) => `${r.identifier}=${r.parameterId}`).join(', ')}`);
console.log(`not in HMIS at all (${unknown.length}): ${unknown.join(', ') || '(none)'}`);
console.log('');
console.log('rows that would now be posted:');
for (const r of after.rows) {
  console.log(`  ${r.identifier.padEnd(8)} ${String(r.resultValue).padEnd(9)} labResultId=${r.labResultId} parameterId=${r.parameterId}`);
}
const placeholders = after.rows.filter((r) => /^[*.]+$/.test(String(r.resultValue).trim()));
console.log('');
console.log(`placeholders in the payload: ${placeholders.length} (must be 0)`);
console.log(`dropped as void: ${after.voided.join(', ') || '(none)'}`);
console.log(`all on one labResultId: ${new Set(after.rows.map((r) => r.labResultId)).size === 1}`);

rmSync(dir, { recursive: true, force: true });
