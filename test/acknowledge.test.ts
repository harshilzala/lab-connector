// Acknowledge path: the body must ASSERT isTransmitted:true, and the response
// must be judged rather than discarded. Runs against a local stub gateway.
// Run with:  npx tsx test/acknowledge.test.ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HmisClient } from '../src/hmis/client.js';
import { normalizePending } from '../src/hmis/pending.js';
import { logger } from '../src/logger.js';

let reply: { status: number; body: string } = { status: 200, body: '' };
let lastBody: unknown = null;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const client = new HmisClient({
  baseUrl: `http://127.0.0.1:${port}`,
  pendingPath: '/mirth/pending',
  acknowledgePath: '/mirth/acknowledge',
  resultsPath: '/mirth/labresult',
  timeoutMs: 5000,
  tlsRejectUnauthorized: true,
  logger,
});

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// --- 1. the body the connector builds ----------------------------------------
// A fresh pending row from the real gateway: isTransmitted absent.
const pending = normalizePending(
  {
    data: [
      {
        SampleID: 'LB2609020570',
        equipmentCode: 'MGAPI1000',
        equipmentId: 222127293,
        eqIdntifier: 'tTG IgA',
        labResultId: 92624563,
        labServiceId: 1908,
        parameterId: null,
        ipAddress: '10.11.100.101',
        portNo: '4001',
      },
    ],
  },
  { sampleId: 'LB2609020570', eqCode: 'MGAPI1000' },
);
check('pending row normalises', pending.found && pending.ackItems.length === 1);
check(
  'ack body asserts isTransmitted:true',
  pending.ackItems[0].isTransmitted === true,
  `got ${pending.ackItems[0].isTransmitted}`,
);
check('ack body keeps the filing keys', pending.ackItems[0].labResultId === 92624563 && pending.ackItems[0].labServiceId === 1908);

// --- 2. response validation ---------------------------------------------------
async function ack(): Promise<string> {
  try {
    await client.acknowledge(pending.ackItems);
    return 'ok';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

reply = { status: 200, body: JSON.stringify({ status: 'success', message: 'ok', successData: [{ labResultId: 92624563 }] }) };
check('accepts a real success', (await ack()) === 'ok');

reply = { status: 200, body: JSON.stringify({ status: 'success', message: 'data transmitted successfully', successData: [] }) };
const zero = await ack();
check('rejects 200 + success + zero rows', zero.includes('retired 0 of 1'), zero);

reply = { status: 200, body: JSON.stringify({ status: 'failure', message: 'bad payload' }) };
const failed = await ack();
check('rejects a declared failure', failed.includes('rejected the acknowledge'), failed);

reply = { status: 200, body: '' };
check('tolerates an empty body', (await ack()) === 'ok');

reply = { status: 200, body: 'OK' };
check('tolerates a non-JSON body', (await ack()) === 'ok');

reply = { status: 200, body: JSON.stringify({ acknowledged: 1 }) };
check('tolerates an unrecognised shape', (await ack()) === 'ok');

reply = { status: 500, body: 'boom' };
const server500 = await ack();
check('rejects a 500', server500.includes('HTTP 500'), server500);

// --- 3. what actually went on the wire ---------------------------------------
reply = { status: 200, body: JSON.stringify({ status: 'success', successData: [{}] }) };
await ack();
const sent = (lastBody as Array<{ isTransmitted: boolean; sampleID: string }>)[0];
check('wire body carries isTransmitted:true', sent.isTransmitted === true, JSON.stringify(sent));

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
