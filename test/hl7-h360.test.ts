import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { Hl7Link } from '../src/codec/hl7/link.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the HL7/MLLP codec against the Erba H360.
//
// The fixture is a byte-exact ORU^R01 lifted from the production wire log of the
// legacy middleware (E:\API_Integration\Devices\H360\H360.txt) — MLLP framing
// and all — so this exercises the same bytes the analyzer actually sends.
//   Run:  npx tsx test/hl7-h360.test.ts

const here = dirname(fileURLToPath(import.meta.url));
const wire = readFileSync(join(here, 'fixtures', 'h360-oru.hl7'));

// The 22 numeric analytes the legacy middleware filed for this sample
// (verified against InsertData_Param.txt / arrOBX.log).
const EXPECTED: Record<string, string> = {
  WBC: '8.52',
  'LYM%': '23.7',
  'GRAN%': '51.7',
  'MID%': '24.6',
  'LYM#': '2.02',
  'GRAN#': '4.40',
  'MID#': '2.10',
  RBC: '4.01',
  HGB: '10.9',
  HCT: '31.5',
  MCV: '78.4',
  MCH: '27.2',
  MCHC: '34.6',
  'RDW-CV': '13.0',
  'RDW-SD': '41.2',
  PLT: '267',
  MPV: '8.8',
  'PDW-SD': '10.7',
  'PDW-CV': '15.1',
  PCT: '0.236',
  'P-LCR': '19.6',
  'P-LCC': '52',
};

// ---- 1) MLLP deframing, including bytes split across chunk boundaries ------
{
  const dec = new MllpDecoder('utf8');
  const out: string[] = [];
  for (let i = 0; i < wire.length; i += 13) out.push(...dec.push(wire.subarray(i, i + 13)));
  assert.equal(out.length, 1, 'one message reassembled from 13-byte chunks');
  assert.equal(dec.pending, 0, 'trailer fully consumed');
  assert.ok(out[0]!.startsWith('MSH|^~\\&|H360|Erba'), 'VT/FS stripped');

  // Two messages back to back in a single chunk.
  const pair = new MllpDecoder('utf8');
  assert.equal(pair.push(Buffer.concat([wire, wire])).length, 2, 'two framed messages in one chunk');

  // A peer that sends no VT (raw HL7 terminated by FS) must still parse.
  const bare = new MllpDecoder('utf8');
  assert.equal(bare.push(wire.subarray(1)).length, 1, 'unframed message recovered');
}

// ---- 2) message parse: MSH metadata, barcode, analytes ---------------------
const msg = parseHl7(wire.toString('utf8'));
assert.equal(msg.messageType, 'ORU^R01');
assert.equal(msg.triggerEvent, 'R01');
assert.equal(msg.controlId, '20260609_225044_797');
assert.equal(msg.sendingApp, 'H360');
assert.equal(msg.sendingFacility, 'Erba');
assert.equal(msg.version, '2.3.1');
assert.equal(msg.charset, 'UNICODE', 'MSH-18 survives the MSH-1 re-insertion');

const parsed = hl7ToParsedMessage(msg);
assert.ok(parsed, 'message produced results');
assert.equal(parsed!.protocol, 'hl7');
assert.equal(parsed!.results.length, Object.keys(EXPECTED).length, 'only the numeric analytes are filed');

for (const r of parsed!.results) {
  assert.equal(r.sampleId, '22', 'barcode comes from OBR-3');
  assert.ok(r.testCode in EXPECTED, `unexpected analyte ${r.testCode}`);
  assert.equal(r.value, EXPECTED[r.testCode], `${r.testCode} value`);
  assert.equal(r.status, 'F');
  assert.equal(r.completedAt, '20260609225044', 'falls back to OBR-7 when OBX-14 is empty');
}

// Abnormal flags: OBX-8 repeats — "~N" is normal, "H~A" is high.
const byCode = new Map(parsed!.results.map((r) => [r.testCode, r]));
assert.equal(byCode.get('WBC')!.abnormalFlag, 'N');
assert.equal(byCode.get('MID%')!.abnormalFlag, 'H');
assert.equal(byCode.get('HGB')!.abnormalFlag, 'L');
assert.equal(byCode.get('WBC')!.unit, '10*3/uL');
assert.equal(byCode.get('WBC')!.referenceRange, '3.50-9.50');

// The IS-typed run modes / alarms are deliberately not filed…
assert.ok(!byCode.has('Take Mode') && !byCode.has('Increased Mid Cells'), 'IS segments excluded by default');
// …but they are available when the deployment wants them.
const all = hl7ToParsedMessage(parseHl7(wire.toString('utf8')), { valueTypes: [] })!;
assert.ok(all.results.some((r) => r.testCode === 'Increased Mid Cells'), 'valueTypes:[] accepts every type');
// "Age" has an empty OBX-5 and must never be filed, whatever the value types.
assert.ok(!all.results.some((r) => r.testCode === 'Age'), 'empty OBX-5 is skipped');

console.log(`✓ parsed ${parsed!.results.length} analytes for sample ${parsed!.results[0]!.sampleId}`);

// ---- 3) link: emits the message and ACKs byte-for-byte like the reference --
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://h360';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    this.writes.push(d);
  }
  feed(b: Buffer): void {
    this.emit('data', b);
  }
}

const transport = new FakeTransport();
const link = new Hl7Link(transport as never, { logger });
const messages: ParsedMessage[] = [];
link.on('message', (m: ParsedMessage) => messages.push(m));
link.on('error', (e: Error) => {
  throw e;
});
await link.start();

for (let i = 0; i < wire.length; i += 11) transport.feed(wire.subarray(i, i + 11));
await new Promise((r) => setTimeout(r, 20));
await link.stop();

assert.equal(messages.length, 1, 'link emitted one transmission');
assert.equal(messages[0]!.results.length, 22);

assert.equal(transport.writes.length, 1, 'exactly one ACK');
const ack = transport.writes[0]!;
assert.equal(ack[0], 0x0b, 'ACK starts with VT');
assert.equal(ack[ack.length - 2], 0x1c, 'ACK ends with FS CR');
assert.equal(ack[ack.length - 1], 0x0d);

const ackText = ack.subarray(1, ack.length - 2).toString('utf8');
const [ackMsh, ackMsa] = ackText.split('\r');
const mshFields = ackMsh!.split('|');
assert.equal(mshFields[0], 'MSH');
assert.equal(mshFields[1], '^~\\&');
assert.equal(mshFields[2], 'LIS', 'MSH-3 sending application');
assert.deepEqual(mshFields.slice(3, 6), ['', '', ''], 'MSH-4..6 blank, as the reference sends');
assert.match(mshFields[6]!, /^\d{14}$/, 'MSH-7 timestamp');
assert.equal(mshFields[7], '');
assert.equal(mshFields[8], 'ACK^R01', 'MSH-9 mirrors the inbound trigger');
assert.equal(mshFields[9], '20260609_225044_797', 'MSH-10 echoes the inbound control id');
assert.equal(mshFields[10], 'P');
assert.equal(mshFields[11], '2.3.1');
assert.equal(mshFields[17], 'UNICODE', 'MSH-18 charset');
assert.equal(ackMsa, 'MSA|AA|20260609_225044_797');

// The exact shape the H360 has accepted in production, modulo the timestamp.
const reference = 'MSH|^~\\&|LIS||||<ts>||ACK^R01|20260609_225044_797|P|2.3.1||||||UNICODE\rMSA|AA|20260609_225044_797\r';
assert.equal(ackText.replace(/\|\d{14}\|/, '|<ts>|'), reference, 'ACK matches the legacy middleware byte-for-byte');
console.log(`✓ link ACKed: ${ackText.replace(/\r/g, ' / ')}`);

// ---- 4) round-trip our own framing --------------------------------------
{
  const dec = new MllpDecoder('utf8');
  assert.deepEqual(dec.push(wrapMllp('MSH|^~\\&|A\rMSA|AA|1\r')), ['MSH|^~\\&|A\rMSA|AA|1']);
}

console.log('\nALL HL7 / H360 CODEC TESTS PASSED');
