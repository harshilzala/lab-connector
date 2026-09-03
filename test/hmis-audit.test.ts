// Exercises the HMIS transaction log against the real gateway: a query that
// finds orders, a query that finds none, and a result upload the server does
// not match. Run with:  npx tsx test/hmis-audit.test.ts
import { readFileSync, rmSync } from 'node:fs';
import { HmisAudit } from '../src/hmis/audit.js';
import { HmisClient } from '../src/hmis/client.js';
import { logger } from '../src/logger.js';

const FILE = './logs/hmis-audit-test.log';
rmSync(FILE, { force: true });

const client = new HmisClient({
  baseUrl: 'https://hims.zhhrpl.in/live/portal',
  pendingPath: '/mirth/pending',
  acknowledgePath: '/mirth/acknowledge',
  resultsPath: '/mirth/labresult',
  timeoutMs: 15000,
  tlsRejectUnauthorized: true,
  logger,
  audit: new HmisAudit(FILE, logger),
});

// 1) a barcode with a live order, 2) one with none
await client.getPending({ sampleId: 'LB2609020570', eqCode: 'MGAPI1000' });
await client.getPending({ sampleId: 'LB2608310636', eqCode: 'MGAPI1000' });

// 3) a result the gateway cannot match — the silent-drop case
try {
  await client.postResults([
    {
      sampleId: 'ZC2609020042',
      labServiceId: null,
      labResultId: null,
      equipmentId: 222127293,
      ipAddress: '10.11.100.101',
      portNo: '4001',
      identifier: 'TG II',
      resultValue: '4996',
      isLoaded: false,
      uniqueIdentifier: 'TG II',
      parameterId: null,
    },
  ]);
} catch (err) {
  console.log('postResults threw as expected:', err instanceof Error ? err.message : err);
}

console.log('\n--- ' + FILE + ' ---');
for (const line of readFileSync(FILE, 'utf8').trim().split('\n')) {
  const e = JSON.parse(line);
  console.log(
    [e.ts, e.kind.padEnd(11), String(e.sampleId).padEnd(14), e.outcome.padEnd(13), 'http=' + e.httpStatus, 'rows=' + e.rows, e.durationMs + 'ms'].join('  '),
  );
}
console.log('\n--- full entry for the result upload ---');
const last = readFileSync(FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.kind === 'result');
console.log(JSON.stringify(last, null, 2));
