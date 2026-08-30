import { loadConfig } from '../src/config.js';
import { HmisClient } from '../src/hmis/client.js';
import { formatApiDate, normalizePending } from '../src/hmis/pending.js';
import { logger } from '../src/logger.js';

// =============================================================================
// Verify the three /mirth/* endpoints are live and shaped as expected.
//
//   npm run ping -- <barcode> [analyzerId]
//   npm run ping -- ZH2200418                          # read-only: pending + normalize
//   npm run ping -- ZH2200418 eq1 --ack                # also acknowledge the rows
//   npm run ping -- ZH2200418 eq1 --post GLU 105       # also file a result
//
// [1] and [2] are READ-ONLY. --ack and --post WRITE to the sample, so they are
// opt-in. The endpoints are unauthenticated, so a 401/403 here means something
// in front of the HMIS is guarding them, not that a secret is wrong.
// =============================================================================

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const X = '\x1b[0m';

const barcode = process.argv[2] || 'PING-TEST';
const analyzerId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;

const cfg = loadConfig();
const analyzer = analyzerId ? cfg.analyzers.find((a) => a.id === analyzerId) : cfg.analyzers[0];
if (!analyzer) {
  console.error(`No analyzer "${analyzerId ?? '(first)'}" in config. Have: ${cfg.analyzers.map((a) => a.id).join(', ')}`);
  process.exit(1);
}

const lookup = barcode.trim().toUpperCase();

console.log(`\nHMIS:      ${cfg.hmis.baseUrl}`);
console.log(`Analyzer:  ${analyzer.id} — eqCode "${analyzer.equipmentCode}"${analyzer.equipmentId !== undefined ? ` (equipmentId ${analyzer.equipmentId})` : ''}`);
console.log(`Barcode:   ${barcode}${lookup === barcode ? '' : ` → looked up as ${lookup}`}`);

const client = new HmisClient({
  baseUrl: cfg.hmis.baseUrl,
  pendingPath: cfg.hmis.pendingPath,
  acknowledgePath: cfg.hmis.acknowledgePath,
  resultsPath: cfg.hmis.resultsPath,
  timeoutMs: cfg.hmis.timeoutMs,
  tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
  logger: logger.child({ mod: 'ping' }),
});

// --- [1] Load pending (read-only) -------------------------------------------
console.log(`\n[1] GET ${cfg.hmis.pendingPath}?sampleId=${lookup}&eqCode=${analyzer.equipmentCode}`);
let raw: unknown = null;
try {
  raw = await client.getPending({
    sampleId: lookup,
    eqCode: analyzer.equipmentCode,
    siteId: analyzer.siteId,
    showCulture: analyzer.showCulture,
    date: analyzer.sendDate ? formatApiDate(new Date()) : undefined,
  });
  console.log(`    ${G}✓ HTTP 200${X}`);
  console.log(`    raw body: ${JSON.stringify(raw)?.slice(0, 800) ?? 'null'}`);
} catch (e) {
  console.log(`    ${R}✗ ${(e as Error).message}${X}`);
  console.log(`    Check hmis.baseUrl and that the Mirth channel for ${cfg.hmis.pendingPath} is deployed.`);
  process.exit(1);
}

// --- [2] Normalize (read-only) ----------------------------------------------
console.log(`\n[2] Normalized order (src/hmis/pending.ts)`);
const pending = normalizePending(raw, {
  sampleId: lookup,
  eqCode: analyzer.equipmentCode,
  equipmentId: analyzer.equipmentId ?? null,
  ipAddress: analyzer.ipAddress ?? (analyzer.transport.type === 'tcp' ? analyzer.transport.host : ''),
  portNo: analyzer.portNo ?? (analyzer.transport.type === 'tcp' ? String(analyzer.transport.port) : ''),
});
console.log(`    found:        ${pending.found ? `${G}yes${X}` : `${Y}no${X}`}`);
console.log(`    testCodes:    ${JSON.stringify(pending.testCodes)}`);
console.log(`    priority:     ${pending.priority}`);
console.log(`    specimenType: ${pending.specimenType ?? '(none)'}`);
console.log(`    patient:      ${JSON.stringify(pending.patient)}`);
console.log(`    ackItems:     ${pending.ackItems.length}`);
for (const it of pending.ackItems) console.log(`      ${JSON.stringify(it)}`);

if (!pending.found) {
  console.log(`\n    ${Y}found=false just means nothing is pending for this barcode on this eqCode.${X}`);
  console.log(`    If the raw body above DOES contain rows, a column name is unmapped —`);
  console.log(`    add it to the *_KEYS arrays at the top of src/hmis/pending.ts.`);
}

// --- [3] Acknowledge (opt-in; WRITES) ---------------------------------------
if (process.argv.includes('--ack')) {
  console.log(`\n[3] POST ${cfg.hmis.acknowledgePath} — ${pending.ackItems.length} row(s)  ${Y}(WRITES: rows stop being offered)${X}`);
  if (pending.ackItems.length === 0) {
    console.log(`    ${Y}nothing to acknowledge — skipped${X}`);
  } else {
    try {
      await client.acknowledge(pending.ackItems);
      console.log(`    ${G}✓ acknowledged${X}`);
    } catch (e) {
      console.log(`    ${R}✗ ${(e as Error).message}${X}`);
    }
  }
}

// --- [4] Result upload (opt-in; WRITES) -------------------------------------
const postIdx = process.argv.indexOf('--post');
if (postIdx !== -1) {
  const testCode = process.argv[postIdx + 1] || 'PINGTEST';
  const value = process.argv[postIdx + 2] || '0';
  console.log(`\n[4] POST ${cfg.hmis.resultsPath} — filing ${testCode}=${value} for ${lookup}  ${Y}(WRITES TO THE SAMPLE)${X}`);
  try {
    const resp = await client.postResults({
      equipmentId: analyzer.equipmentId ?? null,
      eqCode: analyzer.equipmentCode,
      barcode: lookup,
      messageId: `ping-${lookup}-${testCode}-${value}`,
      results: [{ testCode, value }],
      raw: 'ping-test upload',
    });
    console.log(`    ${G}✓${X} ${JSON.stringify(resp)}`);
  } catch (e) {
    console.log(`    ${R}✗ ${(e as Error).message}${X}`);
  }
}

console.log('');
process.exit(0);
