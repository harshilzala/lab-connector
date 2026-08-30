import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';
import { parseAdviaRecord, isAdviaHeader } from '../src/codec/advia/parser.js';
import { xorChecksum, buildFrame, extractFrames } from '../src/codec/advia/frames.js';
import { Advia2120Link } from '../src/codec/advia/link.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Offline self-test for the ADVIA 2120i codec. Uses REAL records captured from
// the legacy caretech middleware log.  Run:  npx tsx test/advia-parser.test.ts

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'advia-2120i-sample.txt'), 'latin1');
const lines = fixture.split(/\r\n/);

// ---- 1) pure parser on the first record ------------------------------------
const headerIdx = lines.findIndex(isAdviaHeader);
const rec = parseAdviaRecord(lines[headerIdx]!, [lines[headerIdx + 1]!]);
assert(rec, 'record should parse');
assert.equal(rec!.sampleId, '02026040200471', 'sampleId from header');
assert.equal(rec!.completedAt, '20260403021444', 'completedAt YYYYMMDDHHMMSS');
const byField = new Map(rec!.results.map((r) => [r.testCode, r.value]));
assert.equal(byField.get('1'), '7.81');
assert.equal(byField.get('191'), '71.11');
assert.equal(byField.get('192'), '67.19');
assert.equal(byField.get('37'), '+');
assert.equal(rec!.results.length, 52, 'all 52 cells parsed');
console.log(`✓ parser: ${rec!.results.length} results, sample ${rec!.sampleId}`);

// ---- 1b) rack-position header variant (from live logs) ---------------------
const rackRec = parseAdviaRecord('6R 02026070400298 019-06           07/04/26 14:15:59', ['  1 6.96   2 4.74']);
assert.equal(rackRec!.sampleId, '02026070400298', 'sample id extracted despite rack field');
assert.equal(rackRec!.completedAt, '20260704141559', 'completedAt despite rack field');
console.log('✓ rack-position header variant parses');

// ---- 2) FRAME LAYER — checksum validated against a REAL captured frame ------
// Live capture was:  02 59 53 20×10 0D 0A 0D 03  (STX 'Y' 'S' 10sp CR LF <cksum> ETX)
const tokenPayload = 'Y' + 'S' + ' '.repeat(10) + '\r\n';
assert.equal(xorChecksum(Buffer.from(tokenPayload, 'latin1')), 0x0d, 'XOR checksum must equal the captured 0x0D');
const frame = buildFrame(tokenPayload);
assert.equal(frame[0], 0x02, 'frame starts with STX');
assert.equal(frame[frame.length - 1], 0x03, 'frame ends with ETX');
assert.equal(frame[frame.length - 2], 0x0d, 'checksum byte before ETX = 0x0D');
const { frames: rt } = extractFrames(frame);
assert.equal(rt.length, 1);
assert.equal(rt[0]!.type, 'S');
assert(rt[0]!.checksumOk, 'roundtrip checksum verifies');
console.log('✓ frame layer: XOR checksum matches the real captured token frame (0x0D)');

// ---- 3) protocol link: feed an R frame, expect a result + a token reply -----
class FakeSerial extends EventEmitter {
  readonly kind = 'serial' as const;
  connected = true;
  readonly describe = 'serial://FAKE@9600';
  writes: Buffer[] = [];
  async start() {}
  async stop() {}
  async write(b: Buffer) {
    this.writes.push(Buffer.from(b));
  }
  feed(b: Buffer) {
    this.emit('data', b);
  }
}

const transport = new FakeSerial();
const link = new Advia2120Link(transport as never, { logger: logger.child({ test: 'advia' }), keepaliveMs: 100000 });
const messages: ParsedMessage[] = [];
link.on('message', (m: ParsedMessage) => messages.push(m));
link.on('error', (e: Error) => { throw e; });
await link.start();

// startup: the host announces itself with StartComm = STX "0I \r\n" XOR ETX
assert(transport.writes.length >= 1, 'link sends StartComm on start');
assert.deepEqual([...transport.writes[0]!], [0x02, 0x30, 0x49, 0x20, 0x0d, 0x0a, 0x5e, 0x03], 'StartComm frame bytes match vendor source');
console.log('✓ StartComm frame: 02 30 49 20 0d 0a 5e 03');

// Feed a REAL captured record wrapped as an R frame (STX payload XOR ETX).
const rFrame = buildFrame(lines[headerIdx]! + '\r\n' + lines[headerIdx + 1]! + '\r\n');
for (let i = 0; i < rFrame.length; i += 20) transport.feed(rFrame.subarray(i, i + 20));

assert.equal(messages.length, 1, 'R frame produced one result message');
assert.equal(messages[0]!.results[0]!.sampleId, '2026040200471', 'sample id zero-truncated (vendor ZeroTruncation)');
const rm = new Map(messages[0]!.results.map((r) => [r.testCode, r.value]));
assert.equal(rm.get('1'), '7.81', 'WBC parsed from framed result');
assert.equal(rm.get('10'), '335', 'PLT parsed from framed result');

// host must FIRST echo the seq char ('2' = 0x32), then send a ValidResult ('Z')
const echoed = transport.writes.some((w) => w.length === 1 && w[0] === 0x32);
assert(echoed, 'link echoed the seq char as per-frame ACK');
const validResult = transport.writes.some((w) => w[0] === 0x02 && [...w].includes(0x5a) && w[w.length - 1] === 0x03);
assert(validResult, 'link sent a ValidResult (Z) frame');
console.log(`✓ link: echo-seq + parsed R (sample ${messages[0]!.results[0]!.sampleId}) + ValidResult`);

await link.stop();
console.log('\nALL ADVIA CODEC TESTS PASSED (protocol is provisional — bench-verify against the live analyzer)');
