// LIVE test against the production gateway: does an acknowledge carrying
// isTransmitted:true actually retire the pending row?
//
// This MUTATES real state — it retires the order it acknowledges. Run only
// against a barcode you are willing to close out.
//   npx tsx test/ack-live.test.ts
import { HmisAudit } from '../src/hmis/audit.js';
import { HmisClient } from '../src/hmis/client.js';
import { normalizePending } from '../src/hmis/pending.js';
import { logger } from '../src/logger.js';

const SAMPLE = 'LB2609020570';
const EQ_CODE = 'MGAPI1000';

const client = new HmisClient({
  baseUrl: 'https://hims.zhhrpl.in/live/portal',
  pendingPath: '/mirth/pending',
  acknowledgePath: '/mirth/acknowledge',
  resultsPath: '/mirth/labresult',
  timeoutMs: 15000,
  tlsRejectUnauthorized: true,
  logger,
  audit: new HmisAudit('./logs/hmis-acktest.log', logger),
});

const query = async (label: string) => {
  const body = await client.getPending({ sampleId: SAMPLE, eqCode: EQ_CODE });
  const p = normalizePending(body, { sampleId: SAMPLE, eqCode: EQ_CODE });
  console.log(`${label}: found=${p.found} rows=${p.ackItems.length} tests=${JSON.stringify(p.testCodes)}`);
  return p;
};

console.log('=== 1. baseline ===');
const before = await query('before');
if (!before.found) {
  console.log('Nothing pending for this barcode — nothing to test. Stopping.');
  process.exit(0);
}
console.log('ack body to send:', JSON.stringify(before.ackItems, null, 2));

console.log('\n=== 2. acknowledge (isTransmitted:true) ===');
try {
  await client.acknowledge(before.ackItems);
  console.log('acknowledge: accepted, no error raised');
} catch (err) {
  console.log('acknowledge THREW:', err instanceof Error ? err.message : err);
}

console.log('\n=== 3. re-query ===');
const after = await query('after ');

console.log('\n=== VERDICT ===');
if (before.found && !after.found) {
  console.log('CLEARED — the acknowledge retired the row. Defect 1 confirmed and fixed.');
} else {
  console.log('STILL PENDING — isTransmitted:true did not retire the row.');
  console.log('The cause is server-side, not in the acknowledge body.');
}
