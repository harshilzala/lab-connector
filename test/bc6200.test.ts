import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { Hl7Link, isMindrayOrderQuery, mindrayTestMode } from '../src/codec/hl7/link.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { wrapMllp } from '../src/codec/hl7/mllp.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Mindray BC-6200 via LabXpert: ORM^O01 "RF" query → ORR^O02 reply, and the
// standard-style link left untouched. Layout from the legacy capture at
// Ahmedabad; ids and names are made up.
//   Run:  npx tsx test/bc6200.test.ts

const QUERY = 'MSH|^~\\&|LabXpert|Mindray|||20261112152504||ORM^O01|7335|P|2.3.1||||||UNICODE\rORC|RF||HE2611120001|BL\r';
const RESULT = [
  'MSH|^~\\&|LabXpert|Mindray|||20261112194701||ORU^R01|7422|P|2.3.1||||||UNICODE',
  'PID|1||10000000000001^^^^MR||^TEST PATIENT|||Male',
  'PV1|1|HM',
  'OBR|1||HE2611120001|00001^Automated Count^99MRC||20060506000000|20261112194700|||TECH',
  'OBX|1|IS|08001^Take Mode^99MRC||A||||||F',
  'OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F',
  'OBX|12|NM|6690-2^WBC^LN||21.64|10*3/uL|1.00-45.00|N|||F',
  'OBX|13|NM|751-8^NEU#^LN||19.13|10*3/uL|1.00-15.00|H~N|||F',
].join('\r') + '\r';

class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://bc6200';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    this.writes.push(d);
  }
}
const tick = () => new Promise((r) => setImmediate(r));
const text = (b: Buffer) => b.toString('latin1').replace(/^\x0b/, '').replace(/\x1c\r$/, '');

async function link(style: 'standard' | 'mindray-orm', noOrder: string | null = 'CBC+DIFF') {
  const t = new FakeTransport();
  const l = new Hl7Link(t as never, { logger, hostQuery: true, ack: true, valueTypes: ['NM'], charset: 'UNICODE', queryStyle: style, mindrayNoOrderTestMode: noOrder });
  const got: ParsedMessage[] = [];
  l.on('message', (m: ParsedMessage) => got.push(m));
  await l.start();
  return { t, l, got };
}

// ---- 1) query detection ---------------------------------------------------
assert.equal(isMindrayOrderQuery(parseHl7(QUERY)), true);
assert.equal(isMindrayOrderQuery(parseHl7(QUERY.replace('ORC|RF|', 'ORC|NW|'))), false, 'only RF is a query');
assert.equal(mindrayTestMode(['WBC', 'HGB', 'NEU%']), 'CBC+DIFF');
assert.equal(mindrayTestMode(['WBC', 'HGB', 'PLT']), 'CBC');
console.log('✓ ORM^O01 RF recognised; Test Mode rule');

// ---- 2) query → ORR^O02 with the order -------------------------------------
{
  const { t, l, got } = await link('mindray-orm');
  t.emit('data', wrapMllp(QUERY));
  await tick();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.queries.map((q) => q.sampleId), ['HE2611120001']);
  assert.equal(t.writes.length, 0, 'the reply waits for the order lookup');

  await l.sendOrders([
    { sampleId: 'HE2611120001', testCodes: ['WBC', 'HGB', 'PLT'], queryReply: true, patient: { patientId: '10000000000001', firstName: 'TEST', lastName: 'PATIENT', sex: 'M', birthDate: '19900101' } },
  ]);
  const segs = text(t.writes[0]!).split('\r').filter(Boolean);
  assert.match(segs[0]!, /^MSH\|\^~\\&\|LIS\|\|LabXpert\|Mindray\|\d{14}\|\|ORR\^O02\|7335\|P\|2\.3\.1\|\|\|\|\|\|UNICODE$/);
  assert.equal(segs[1], 'MSA|AA|7335');
  assert.equal(segs[2], 'PID|1||10000000000001^^^^||^PATIENT TEST|||Male');
  assert.equal(segs[3], 'PV1|1|HM^001|||||||||||||||||');
  assert.equal(segs[4], 'ORC|AF|HE2611120001|||');
  assert.match(segs[5]!, /^OBR\|1\|HE2611120001\|\|\|\|20060506\|/);
  assert.equal(segs[8], 'OBX|3|IS|08003^Test Mode^99MRC||CBC||||||F', 'no differential pending → CBC');
  assert.match(segs[10]!, /^OBX\|5\|NM\|30525-0\^Age\^LN\|\|\d+\|yr\|/);
  console.log('✓ query → ORR^O02 in the legacy layout, Test Mode from the order');
}

// ---- 3) no order → default Test Mode, or AR when configured -----------------
{
  const { t, l } = await link('mindray-orm');
  t.emit('data', wrapMllp(QUERY));
  await tick();
  await l.sendOrders([]);
  const segs = text(t.writes[0]!).split('\r');
  assert.equal(segs[1], 'MSA|AA|7335');
  assert.equal(segs[4], 'ORC|AF|HE2611120001|||', 'the queried barcode is echoed');
  assert.ok(segs.includes('OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F'));

  const r = await link('mindray-orm', null);
  r.t.emit('data', wrapMllp(QUERY));
  await tick();
  await r.l.sendOrders([]);
  assert.match(text(r.t.writes[0]!), /\rMSA\|AR\|7335\r$/);
  console.log('✓ no order: CBC+DIFF by default, MSA AR when mindrayNoOrderTestMode is null');
}

// ---- 4) results still go the normal way and are ACKed -----------------------
{
  const { t, got } = await link('mindray-orm');
  t.emit('data', wrapMllp(RESULT));
  await tick();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.results.map((r) => [r.sampleId, r.testCode, r.value]), [
    ['HE2611120001', 'WBC', '21.64'],
    ['HE2611120001', 'NEU#', '19.13'],
  ]);
  assert.match(text(t.writes[0]!), /ACK\^R01\|7422\|.*\rMSA\|AA\|7422/);
  console.log('✓ ORU^R01 results parsed and ACKed');
}

// ---- 5) a standard-style link does not treat the ORM as a query -------------
{
  const { t, got } = await link('standard');
  t.emit('data', wrapMllp(QUERY));
  await tick();
  assert.equal(got.filter((m) => m.queries.length).length, 0, 'standard style: no query emitted');
  console.log('✓ standard query style unchanged');
}

// ---- 6) profile ----------------------------------------------------------------
{
  const p = PROFILE_LIBRARY['mindray-bc6200'].defaults as Record<string, any>;
  assert.equal(p.hl7.queryStyle, 'mindray-orm');
  assert.equal(p.hostQuery, true);
  assert.deepEqual([p.transport.mode, p.transport.port], ['server', 3010]);
  assert.equal((PROFILE_LIBRARY['mindray-bc6000'].defaults as any).hl7.queryStyle, undefined, 'BC-6000 profile untouched');
  console.log('✓ profile mindray-bc6200');
}

console.log('bc6200: all checks passed');
