import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { parseClinitekMessage } from '../src/codec/clinitek/parser.js';
import { ClinitekAdvantusLink } from '../src/codec/clinitek/link.js';
import { frame } from '../src/codec/astm/checksum.js';
import { ENQ, EOT, ETX } from '../src/codec/astm/control.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the CLINITEK Advantus codec.
//
// The field layout mirrors the production caretech middleware
// (CLINITEK_ADVANTUS.cs, FormateData): O record specimen id at pipe-field 2,
// R record test code at field 3 and value at field 5, URO's value split on '^',
// P record ("1") sample id at field 4, L clears the id.
//   Run:  npx tsx test/clinitek-parser.test.ts

// ---- 1) record-layer parse (exact field positions) -------------------------
const records = [
  'H|\\^&|||CLINITEK^Advantus|||||||P|1',
  'P|1|||00058|||',
  'O|1|00058||^^^UA|R',
  'R|1||GLU||NEG||||F',
  'R|2||KET||TRACE||||F',
  'R|3||SG||1.020||||F',
  'R|4||BLO||+++||||F',
  'R|5||PH||6.0||||F',
  'R|6||PRO||30||||F',
  'R|7||URO||norm^EU/dL||||F',
  'R|8||NIT||POS||||F',
  'R|9||LEU||+||||F',
  'L|1|N',
];

const parsed = parseClinitekMessage(records);
assert.equal(parsed.sampleId, '00058', 'sample id recovered from O/P record');
const m = new Map(parsed.results.map((r) => [r.testCode, r.value]));
assert.equal(m.get('GLU'), 'NEG');
assert.equal(m.get('KET'), 'TRACE');
assert.equal(m.get('SG'), '1.020');
assert.equal(m.get('BLO'), '+++');
assert.equal(m.get('PH'), '6.0');
assert.equal(m.get('PRO'), '30');
assert.equal(m.get('NIT'), 'POS');
assert.equal(m.get('LEU'), '+');
assert.equal(m.get('URO'), 'norm', 'URO value takes only the first caret component');
assert.equal(parsed.results.length, 9, 'nine R records → nine results');
assert(parsed.results.every((r) => r.sampleId === '00058'), 'every result carries the sample id');
assert(parsed.results.every((r) => r.instrument === 'CLINITEK-ADVANTUS'));
console.log(`✓ parsed ${parsed.results.length} urine results, sample ${parsed.sampleId}`);

// P record supplies the sample id when there is no O record.
const pOnly = parseClinitekMessage(['P|1|||77123|||', 'R|1||GLU||NEG||||F', 'L|1|N']);
assert.equal(pOnly.results[0]!.sampleId, '77123', 'P-field-4 used as sample id');
console.log('✓ P record sample-id fallback works');

// ---- 2) full link: real ASTM framing over a fake serial --------------------
class FakeSerial extends EventEmitter {
  readonly kind = 'serial' as const;
  connected = true;
  readonly describe = 'serial://FAKE@9600';
  writes: Buffer[] = [];
  async start() {}
  async stop() {}
  async write(b: Buffer) {
    this.writes.push(b);
  }
  feed(buf: Buffer) {
    this.emit('data', buf);
  }
}

const transport = new FakeSerial();
const link = new ClinitekAdvantusLink(transport as never, { logger: logger.child({ test: 'clinitek' }) });
const messages: ParsedMessage[] = [];
link.on('message', (msg: ParsedMessage) => messages.push(msg));
link.on('error', (e: Error) => {
  throw e;
});
await link.start();

// Drive the ASTM session: ENQ, one framed block per record, EOT — bytes split
// across arbitrary chunk boundaries to exercise reassembly.
const session: Buffer[] = [Buffer.from([ENQ])];
let fn = 1;
for (const rec of records) {
  session.push(frame(fn, rec + '\r', ETX));
  fn = (fn + 1) % 8;
}
session.push(Buffer.from([EOT]));
const wire = Buffer.concat(session);
for (let i = 0; i < wire.length; i += 7) transport.feed(wire.subarray(i, i + 7));

await new Promise((r) => setTimeout(r, 20));
await link.stop();

assert.equal(messages.length, 1, `expected 1 transmission, got ${messages.length}`);
assert.equal(messages[0]!.protocol, 'clinitek-advantus');
assert.equal(messages[0]!.results.length, 9, 'link emitted all nine results');
assert.equal(messages[0]!.results[0]!.sampleId, '00058');

// The link must ACK the ENQ and every block (10 records + ENQ = 11 ACKs).
const ackCount = transport.writes.filter((b) => b.length === 1 && b[0] === 0x06).length;
assert.equal(ackCount, records.length + 1, `expected ${records.length + 1} ACKs, got ${ackCount}`);
console.log(`✓ link emitted ${messages.length} transmission with ${messages[0]!.results.length} results, ${ackCount} ACKs`);

console.log('\nALL CLINITEK CODEC TESTS PASSED');
