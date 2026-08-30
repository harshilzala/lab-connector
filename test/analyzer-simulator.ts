import { EventEmitter } from 'node:events';
import { logger } from '../src/logger.js';
import type { Transport } from '../src/transport/types.js';
import type { ParsedMessage } from '../src/types.js';
import { AstmLink } from '../src/codec/astm/link.js';
import { frame } from '../src/codec/astm/checksum.js';
import { ETX, STX } from '../src/codec/astm/control.js';
import { parseMessage } from '../src/codec/astm/records.js';

// =============================================================================
// Loopback simulator + assertions. No hardware, no HMIS — exercises the ASTM
// codec end to end (ENQ/ACK/frames/checksum/EOT) and the record parser.
//
//   npm run simulator
// =============================================================================

// In-memory paired transport: bytes written to one surface as 'data' on the peer.
class FakeTransport extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  connected = true;
  peer!: FakeTransport;
  constructor(readonly describe = 'fake') {
    super();
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(data: Buffer): Promise<void> {
    // Deliver asynchronously to mimic the wire and avoid reentrancy.
    setImmediate(() => this.peer.emit('data', Buffer.from(data)));
  }
}

function pair(): [FakeTransport, FakeTransport] {
  const a = new FakeTransport('A');
  const b = new FakeTransport('B');
  a.peer = b;
  b.peer = a;
  return [a, b];
}

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  else {
    failures++;
    console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
  }
}

const log = logger.child({ mod: 'sim' });

// --- Test 1: frame() checksum round-trips ------------------------------------
function testFraming(): void {
  console.log('\nFraming + checksum');
  const f = frame(1, 'H|\\^&|||test\r', ETX);
  assert(f[0] === STX, 'frame starts with STX');
  assert(f[f.length - 2] === 0x0d && f[f.length - 1] === 0x0a, 'frame ends with CR LF');
  // recompute checksum over body (after STX up to & incl terminator)
  const len = f.length;
  const body = f.subarray(1, len - 4);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  const cs = sum.toString(16).toUpperCase().padStart(2, '0');
  assert(f.subarray(len - 4, len - 2).toString('latin1') === cs, 'embedded checksum matches recomputed');
}

// --- Test 2: parse a canned Atellica-style result message --------------------
function testResultParse(): void {
  console.log('\nResult record parsing');
  const records = [
    'H|\\^&|||Atellica^1||||||||LIS2-A2|20240701120000',
    'P|1||UHID123||DOE^JOHN^A||19800101|M',
    'O|1|SAMPLE0001||^^^GLU|R||20240701113000',
    'R|1|^^^GLU^Glucose|105|mg/dL|70-110|N||F||tech1|20240701113500|ATELLICA',
    'R|2|^^^ALT^Alanine|42|U/L|10-40|H||F||tech1|20240701113500|ATELLICA',
    'L|1|N',
  ];
  const msg = parseMessage(records, records.join('\r\n'));
  assert(msg.results.length === 2, 'two results parsed');
  assert(msg.results[0]?.sampleId === 'SAMPLE0001', 'result carries specimen id from O record');
  assert(msg.results[0]?.testCode === 'GLU', 'GLU test code extracted');
  assert(msg.results[0]?.value === '105', 'GLU value = 105');
  assert(msg.results[1]?.abnormalFlag === 'H', 'ALT flagged High');
  assert(msg.patient?.lastName === 'DOE' && msg.patient?.sex === 'M', 'patient demographics parsed');
}

// --- Test 3: two links, full ENQ/frame/EOT handshake over fake wire ----------
async function testLoopback(): Promise<void> {
  console.log('\nEnd-to-end link handshake');
  const [ta, tb] = pair();
  const opts = { senderId: 'LIS', receiverId: 'SIM', ackTimeoutMs: 2000, frameMaxData: 240, logger: log };
  const host = new AstmLink(ta, opts); // acts as sender (order download)
  const analyzer = new AstmLink(tb, opts); // acts as receiver

  const received = new Promise<ParsedMessage>((res) => analyzer.on('message', res));
  let linkError: Error | null = null;
  host.on('error', (e) => (linkError = e));
  analyzer.on('error', (e) => (linkError = e));

  await host.start();
  await analyzer.start();

  await host.sendOrders([{ sampleId: 'SAMPLE0001', testCodes: ['GLU', 'ALT'], priority: 'R' }]);

  const msg = await Promise.race([
    received,
    new Promise<ParsedMessage>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
  ]).catch((e) => {
    assert(false, `analyzer received the order download (${(e as Error).message})`);
    return null;
  });

  assert(linkError === null, 'no protocol errors on either side');
  if (msg) {
    assert(msg.raw.includes('SAMPLE0001'), 'received message carries the barcode');
    assert(msg.raw.includes('GLU') && msg.raw.includes('ALT'), 'received message carries both test codes');
  }

  await host.stop();
  await analyzer.stop();
}

async function run(): Promise<void> {
  testFraming();
  testResultParse();
  await testLoopback();
  console.log('');
  if (failures > 0) {
    console.log(`\x1b[31m${failures} assertion(s) failed\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mAll checks passed\x1b[0m');
  process.exit(0);
}

run();
