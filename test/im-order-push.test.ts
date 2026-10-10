import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hl7Link } from '../src/codec/hl7/link.js';
import { MllpDecoder, wrapMllp } from '../src/codec/hl7/mllp.js';
import { Hl7OrderRejected, buildOrderPush, escapeHl7, readAck } from '../src/codec/hl7/orders.js';
import { parseHl7 } from '../src/codec/hl7/parser.js';
import { loadConfig, type AnalyzerConfig } from '../src/config.js';
import type { HmisClient } from '../src/hmis/client.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import { TcpTransport } from '../src/transport/tcp.js';
import type { Transport } from '../src/transport/types.js';

// =============================================================================
// IM order push — orders read from HMIS and SENT to the instrument middleware
// as HL7 over MLLP, each one confirmed by the receiver's MSA.
//
// What the lab relies on, pinned here against a stand-in for IM:
//
//   1. the message: one ORM^O01 per tube, every test its own ORC/OBR, the
//      barcode in the placer and the filler number, specimen and priority
//      carried, free text escaped
//   2. an order counts as sent only when MSA|AA comes back
//   3. MSA|AE / AR fails the send as a REFUSAL; silence fails it as a timeout;
//      a socket that closes fails it at once
//   4. an acknowledgement is never acknowledged back
//   5. two orders never share the line: the second waits for the first's MSA
//   6. the poll sends each tube once, and only what is new after that
//   7. a refused tube does not stop the tubes behind it and does not open
//      the download breaker
//   8. a dead line (no answer) does open it
//   9. the config block loads, and the same bytes cross a real TCP socket
//
// Run: npx tsx test/im-order-push.test.ts   (npm run im:orders)
// =============================================================================

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' } as any;
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

const PUSH = {
  enabled: true,
  messageType: 'ORM^O01' as const,
  version: '2.3.1',
  receivingApp: 'IM',
  receivingFacility: '',
  processingId: 'P',
  ackTimeoutMs: 150,
};
const BUILD = {
  messageType: 'ORM^O01' as const,
  version: '2.3.1',
  sendingApp: 'HMIS-LIS',
  sendingFacility: 'ZHA',
  receivingApp: 'IM',
  receivingFacility: '',
  processingId: 'P',
  charset: '',
};

/** The acknowledgement IM would send for a message with this control id. */
const ackFor = (controlId: string, code = 'AA', text = '') =>
  `MSH|^~\\&|IM||HMIS-LIS||20260927200000||ACK|IM${controlId}|P|2.3.1\rMSA|${code}|${controlId}${text ? '|' + text : ''}\r`;

// ---------------------------------------------------------------------------
console.log('\n— the order message');
{
  const text = buildOrderPush(
    {
      sampleId: 'LB2609270123',
      testCodes: ['TSH3', 'B12', 'TVITD'],
      priority: 'S',
      specimenType: 'Serum',
      patient: { patientId: '10032026040311', lastName: 'PATEL', firstName: 'ASHA', middleName: 'R', sex: 'F', birthDate: '19871203' },
    },
    BUILD,
    '202609272000000001',
    new Date(2026, 8, 27, 20, 0, 0),
  );
  const segs = text.split('\r').filter(Boolean);
  assert.equal(segs[0], 'MSH|^~\\&|HMIS-LIS|ZHA|IM||20260927200000||ORM^O01|202609272000000001|P|2.3.1');
  assert.equal(segs[1], 'PID|1||10032026040311||PATEL^ASHA^R||19871203|F');
  assert.equal(segs.filter((s) => s.startsWith('ORC|')).length, 3, 'one ORC per test');
  assert.equal(segs[2], 'ORC|NW|LB2609270123|LB2609270123||||^^^^^S||20260927200000');

  const msg = parseHl7(text);
  const obr = msg.segments.filter((s) => s.name === 'OBR');
  assert.deepEqual(obr.map((s) => s.fields[1]), ['1', '2', '3'], 'OBR set ids count from 1');
  assert.deepEqual(obr.map((s) => s.fields[4]), ['TSH3', 'B12', 'TVITD'], 'OBR-4 is the HMIS identifier, untouched');
  for (const s of obr) {
    assert.equal(s.fields[2], 'LB2609270123', 'barcode in OBR-2 (placer)');
    assert.equal(s.fields[3], 'LB2609270123', 'barcode in OBR-3 (filler)');
    assert.equal(s.fields[5], 'S', 'priority in OBR-5');
    assert.equal(s.fields[15], 'Serum', 'specimen in OBR-15');
    assert.equal(s.fields[27], '^^^^^S', 'priority in OBR-27');
  }
  assert.ok(text.endsWith('\r'), 'every segment, the last included, ends in CR');
  console.log('✓ ORM^O01: MSH, PID, then ORC/OBR per test with barcode, specimen and priority');

  const anon = buildOrderPush({ sampleId: 'HE2609270249', testCodes: ['A1C1'], patient: null }, BUILD, '1');
  assert.ok(anon.split('\r')[1] === 'PID|1', 'PID is sent, empty, when demographics are withheld');
  assert.ok(/\rOBR\|1\|HE2609270249\|HE2609270249\|A1C1\|R\|/.test(anon), 'routine is the default priority');
  console.log('✓ demographics withheld: an empty PID, routine priority');

  const oml = buildOrderPush({ sampleId: 'LB1', testCodes: ['K'], specimenType: 'Urine' }, { ...BUILD, messageType: 'OML^O21', version: '2.5.1', charset: 'UNICODE' }, '7');
  assert.ok(oml.startsWith('MSH|^~\\&|HMIS-LIS|ZHA|IM||'), 'same header');
  assert.ok(oml.includes('|OML^O21^OML_O21|7|P|2.5.1||||||UNICODE\r'), 'OML^O21 names its structure; charset lands in MSH-18');
  assert.ok(oml.includes('\rSPM|1|LB1||Urine\r'), 'OML carries the specimen in an SPM segment');
  assert.equal(parseHl7(oml).charset, 'UNICODE');
  console.log('✓ OML^O21 variant adds SPM and keeps MSH-18 in place');

  assert.equal(escapeHl7('A|B^C&D~E\\F'), 'A\\F\\B\\S\\C\\T\\D\\R\\E\\E\\F');
  const odd = buildOrderPush(
    { sampleId: 'LB2', testCodes: ['GLU'], specimenType: 'Blood(sodium fluoride-R)|x', patient: { lastName: 'DSOUZA^JR', firstName: 'A|B' } },
    BUILD,
    '9',
  );
  const pid = parseHl7(odd).segments.find((s) => s.name === 'PID')!;
  assert.equal(pid.fields.length, 9, 'a "|" inside a name does not add a field');
  assert.equal(pid.fields[5], 'DSOUZA\\S\\JR^A\\F\\B');
  console.log('✓ delimiters inside names and specimen text are escaped');

  assert.throws(() => buildOrderPush({ sampleId: 'LB3', testCodes: ['', '  '] }, BUILD, '1'), /no tests/);
  console.log('✓ an order with no test is refused before it reaches the wire');

  assert.equal(readAck(parseHl7(ackFor('42')))!.accepted, true);
  const no = readAck(parseHl7(ackFor('42', 'AE', 'Unknown test')))!;
  assert.deepEqual([no.accepted, no.code, no.controlId, no.text], [false, 'AE', '42', 'Unknown test']);
  assert.equal(readAck(parseHl7('MSH|^~\\&|A||||1||ORU^R01|1|P|2.3.1\rOBR|1||X\r')), null, 'a result is not an acknowledgement');
  console.log('✓ MSA is read: AA/CA accept, AE/AR refuse, the text is kept');
}

// ---------------------------------------------------------------------------
// A transport double: what the link writes is decoded back into messages, and
// the test plays IM by feeding acknowledgements in.
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake';
  connected = true;
  failWrites = false;
  readonly sent: string[] = [];
  private readonly dec = new MllpDecoder('utf8');
  /** Called for every message the link sends. */
  onMessage: (text: string) => void = () => {};
  async start() {}
  async stop() {}
  async write(data: Buffer) {
    if (this.failWrites) throw new Error('TCP transport: no connected peer to write to');
    for (const m of this.dec.push(data)) {
      this.sent.push(m);
      queueMicrotask(() => this.onMessage(m));
    }
  }
  feed(text: string) {
    this.emit('data', wrapMllp(text, 'utf8'));
  }
}
const controlIdOf = (text: string) => parseHl7(text).controlId;
const typeOf = (text: string) => parseHl7(text).messageType;

async function linkWith(onMessage: (t: FakeTransport, text: string) => void, push = PUSH) {
  const t = new FakeTransport();
  t.onMessage = (text) => onMessage(t, text);
  const link = new Hl7Link(t as unknown as Transport, { logger: quiet, sendingApp: 'HMIS-LIS', charset: '', orderPush: push });
  await link.start();
  return { t, link };
}
const tube = (sampleId: string, ...testCodes: string[]) => ({ sampleId, testCodes });

console.log('\n— the link');
{
  const { t, link } = await linkWith((tr, text) => tr.feed(ackFor(controlIdOf(text))));
  await link.sendOrders([tube('LB2609270001', 'TSH3', 'B12')]);
  assert.equal(t.sent.length, 1);
  assert.equal(typeOf(t.sent[0]!), 'ORM^O01');
  console.log('✓ an order resolves once IM answers MSA|AA');

  await link.sendOrders([tube('LB2609270002', 'K'), tube('LB2609270003', 'NA')]);
  assert.equal(t.sent.length, 3, 'one message per tube');
  assert.equal(new Set(t.sent.map(controlIdOf)).size, 3, 'every message has its own control id');
  assert.ok(t.sent.every((m) => typeOf(m) === 'ORM^O01'), 'nothing but orders was written — the ACKs were not answered');
  console.log('✓ one message per tube, unique control ids, and an ACK is never acknowledged back');
}
{
  const { link } = await linkWith((tr, text) => tr.feed(ackFor(controlIdOf(text), 'AE', 'Unknown test code XYZ')));
  await assert.rejects(
    link.sendOrders([tube('LB2609270004', 'XYZ')]),
    (e: unknown) => e instanceof Hl7OrderRejected && e.code === 'AE' && /Unknown test code XYZ/.test(e.message) && e.linkAlive === true,
  );
  console.log('✓ MSA|AE fails the send as a refusal, with IM\'s reason');
}
{
  const { t, link } = await linkWith(() => {});
  const started = Date.now();
  await assert.rejects(link.sendOrders([tube('LB2609270005', 'K')]), /no acknowledgement from the receiver within 150 ms/);
  assert.ok(Date.now() - started >= 140, 'it waited the whole timeout');
  // The line is free again afterwards.
  t.onMessage = (text) => t.feed(ackFor(controlIdOf(text)));
  await link.sendOrders([tube('LB2609270005', 'K')]);
  console.log('✓ no answer fails the send after ackTimeoutMs, and the next send works');
}
{
  const { t, link } = await linkWith((tr) => tr.emit('close'), { ...PUSH, ackTimeoutMs: 5000 });
  const started = Date.now();
  await assert.rejects(link.sendOrders([tube('LB2609270006', 'K')]), /connection closed before the receiver acknowledged/);
  assert.ok(Date.now() - started < 1000, 'a closed socket fails at once, not after the timeout');
  t.failWrites = true;
  await assert.rejects(link.sendOrders([tube('LB2609270006', 'K')]), /no connected peer/);
  console.log('✓ a socket that closes, or cannot be written, fails the send at once');
}
{
  // IM answers the first order late. The second must not be written until it has.
  const order: string[] = [];
  const { t, link } = await linkWith((tr, text) => {
    order.push('sent ' + parseHl7(text).segments.find((s) => s.name === 'OBR')!.fields[2]);
    setTimeout(() => {
      order.push('acked ' + parseHl7(text).segments.find((s) => s.name === 'OBR')!.fields[2]);
      tr.feed(ackFor(controlIdOf(text)));
    }, 30);
  });
  await Promise.all([link.sendOrders([tube('A1', 'K')]), link.sendOrders([tube('A2', 'K')])]);
  assert.deepEqual(order, ['sent A1', 'acked A1', 'sent A2', 'acked A2']);
  assert.equal(t.sent.length, 2);
  console.log('✓ two sends at once go one after the other');
}
{
  // An acknowledgement for something else, and a result arriving mid-wait.
  const messages: unknown[] = [];
  const { t, link } = await linkWith((tr, text) => {
    // Only the order is answered: the double also sees the ACK the link
    // writes for the result, and IM says nothing to that.
    if (typeOf(text) !== 'ORM^O01') return;
    tr.feed(ackFor('SOMETHING-ELSE'));
    tr.feed('MSH|^~\\&|IM||||20260927||ORU^R01|R1|P|2.3.1\rOBR|1||LB9\rOBX|1|NM|TSH3^TSH3||2.1|uIU/mL|||||F\r');
    tr.feed(ackFor(controlIdOf(text)));
  });
  link.on('message', (m) => messages.push(m));
  await link.sendOrders([tube('LB9', 'TSH3')]);
  assert.equal(messages.length, 1, 'the result still went down the results path');
  assert.deepEqual(t.sent.map(typeOf), ['ORM^O01', 'ACK^R01'], 'the result was acknowledged, the stray ACK was not');
  console.log('✓ a stray ACK is ignored and a result arriving mid-wait is still filed');
}
{
  // Order push off: the old behaviour, untouched.
  const t = new FakeTransport();
  const link = new Hl7Link(t as unknown as Transport, { logger: quiet });
  await link.start();
  await link.sendOrders([tube('LB1', 'K')]);
  assert.equal(t.sent.length, 0);
  console.log('✓ with orderPush off nothing is sent unsolicited, as before');
}

// ---------------------------------------------------------------------------
console.log('\n— the poll');
const dir = mkdtempSync(join(tmpdir(), 'im-push-'));
const row = (sampleId: string, code: string, labResultId: number, extra: object = {}) => ({
  SampleID: sampleId,
  eqIdntifier: code,
  equipmentCode: 'EQ0022',
  equipmentId: 46150218,
  labResultId,
  labServiceId: 68,
  parameterId: labResultId % 1000,
  ipAddress: '10.11.111.129',
  portNo: '10011',
  specimenName: 'Serum',
  FName: 'ASHA',
  LName: 'PATEL',
  Gender: 2,
  DOB: '03-12-1987',
  mrn: '10032026040311',
  ...extra,
});
let offered: unknown[] = [];
const hmis = {
  defaultSiteIds: [undefined],
  siteId: null,
  async getPending() {
    return { status: 'success', data: offered };
  },
  async acknowledge() {
    throw new Error('an order push must never acknowledge');
  },
  async postResults(rows: unknown[]) {
    return { status: 'success', message: 'ok', successData: rows, filed: rows.length };
  },
} as unknown as HmisClient;

// The real schema builds the block, so the defaults are the shipped ones.
const cfgFile = join(dir, 'config.json');
writeFileSync(
  cfgFile,
  JSON.stringify({
    hmis: { baseUrl: 'http://127.0.0.1:1/x', auditLog: null },
    spoolDir: join(dir, 'spool'),
    analyzers: [
      {
        id: 'im',
        equipmentCode: 'EQ0022',
        protocol: 'hl7',
        transport: { type: 'tcp', mode: 'client', host: '127.0.0.1', port: 1 },
        hostQuery: false,
        sendDemographics: true,
        orderPoll: { enabled: true, intervalMs: 30000, lookbackDays: 0 },
        hl7: { sendingApp: 'HMIS-LIS', charset: '', orderPush: { enabled: true } },
      },
    ],
  }),
);
const loaded = loadConfig(cfgFile);
const imCfg = loaded.analyzers[0]!;
assert.equal(imCfg.hl7.orderPush.enabled, true);
assert.deepEqual(
  [imCfg.hl7.orderPush.messageType, imCfg.hl7.orderPush.version, imCfg.hl7.orderPush.receivingApp, imCfg.hl7.orderPush.processingId],
  ['ORM^O01', '2.3.1', 'IM', 'P'],
);
assert.equal(imCfg.hl7.orderPush.ackTimeoutMs, 15000, 'IM gets 15 s to answer unless the config says otherwise');

// The same thing written the way a site writes it: the profile carries the
// protocol, the client dial, the poll and the push; the block names the
// address and the equipment code.
writeFileSync(
  join(dir, 'config.profile.json'),
  JSON.stringify({
    hmis: { baseUrl: 'http://127.0.0.1:1/x', auditLog: null },
    spoolDir: join(dir, 'spool'),
    analyzers: [{ id: 'im-live', profile: 'im', equipmentCode: 'EQ0022', equipmentId: 46150218, transport: { host: '10.11.4.231' } }],
  }),
);
const viaProfile = loadConfig(join(dir, 'config.profile.json')).analyzers[0]!;
assert.equal(viaProfile.protocol, 'hl7');
assert.deepEqual(viaProfile.transport, { type: 'tcp', mode: 'client', host: '10.11.4.231', port: 10011 }, 'the connector dials IM on 10011');
assert.equal(viaProfile.hl7.orderPush.enabled, true, 'the profile turns the push on');
assert.equal(viaProfile.hl7.orderPush.receivingApp, 'IM');
assert.equal(viaProfile.hl7.charset, '', 'no charset is declared to IM');
assert.equal(viaProfile.hostQuery, false, 'IM is sent orders, it never asks');
assert.equal(viaProfile.orderPoll.enabled, true);
assert.equal(viaProfile.orderPoll.download, true);
assert.equal(viaProfile.sendDemographics, true, "IM's worklist shows a name");
assert.equal(viaProfile.filing.mode, 'staged');
console.log('✓ profile "im" gives a whole machine from an address and an equipment code');
const plain = loadConfig(cfgFile.replace('config.json', 'config.json')).analyzers[0]!;
assert.equal(plain.hl7.ack, true, 'the rest of the hl7 block keeps its defaults');
console.log('✓ the config block loads; defaults are ORM^O01, 2.3.1, to "IM"');

type Inner = {
  pollOrders(): Promise<void>;
  transport: Transport;
  link: Hl7Link;
  orders: { get(b: string): { downloaded: string[]; testCodes: string[] } | null };
  downloadFailStreak: number;
  downloadPausedUntil: number;
  refusedUntil: Map<string, number>;
};

function runtime(id: string, decide: (text: string) => string | null) {
  const fake = new FakeTransport();
  fake.onMessage = (text) => {
    const answer = decide(text);
    if (answer !== null) fake.feed(answer);
  };
  const rt = new AnalyzerRuntime({ ...imCfg, id } as AnalyzerConfig, hmis, join(dir, 'spool'), quiet);
  const inner = rt as unknown as Inner;
  // Swap the transport under the runtime and its link for the double.
  const link = new Hl7Link(fake as unknown as Transport, { logger: quiet, sendingApp: 'HMIS-LIS', charset: '', orderPush: { ...imCfg.hl7.orderPush, ackTimeoutMs: 150 } });
  inner.transport = fake as unknown as Transport;
  inner.link = link;
  return { rt, inner, fake, link };
}
const barcodesSent = (fake: FakeTransport) => fake.sent.map((m) => parseHl7(m).segments.find((s) => s.name === 'OBR')!.fields[2]);
const testsSent = (text: string) => parseHl7(text).segments.filter((s) => s.name === 'OBR').map((s) => s.fields[4]);

{
  const { inner, fake, link } = runtime('im-a', (text) => ackFor(controlIdOf(text)));
  await link.start();
  offered = [row('LB2609270123', 'TSH3', 93000001), row('LB2609270123', 'B12', 93000002), row('HE2609270249', 'A1C1', 93000003, { specimenName: 'EDTA' })];
  await inner.pollOrders();
  assert.deepEqual(barcodesSent(fake), ['LB2609270123', 'HE2609270249']);
  assert.deepEqual(testsSent(fake.sent[0]!), ['TSH3', 'B12']);
  const first = parseHl7(fake.sent[0]!);
  assert.equal(first.segments.find((s) => s.name === 'PID')!.fields[5], 'PATEL^ASHA', 'demographics go when sendDemographics is on');
  assert.equal(first.segments.find((s) => s.name === 'PID')!.fields[7], '19871203');
  assert.equal(first.segments.find((s) => s.name === 'PID')!.fields[8], 'F');
  assert.equal(parseHl7(fake.sent[1]!).segments.find((s) => s.name === 'OBR')!.fields[15], 'EDTA', "each tube carries its own specimen");
  assert.deepEqual(inner.orders.get('LB2609270123')!.downloaded, ['TSH3', 'B12']);
  console.log('✓ the poll sends each tube HMIS lists, with its tests, specimen and patient');

  await inner.pollOrders();
  assert.equal(fake.sent.length, 2, 'the same rows on the next poll send nothing');
  offered = [...offered, row('LB2609270123', 'TVITD', 93000004)];
  await inner.pollOrders();
  assert.equal(fake.sent.length, 3);
  assert.deepEqual(testsSent(fake.sent[2]!), ['TVITD'], 'only the test added since');
  console.log('✓ a tube is sent once; a test added later goes on its own');
}
{
  // IM refuses the first tube and accepts the rest.
  const { inner, fake, link } = runtime('im-b', (text) =>
    testsSent(text).includes('XYZ') ? ackFor(controlIdOf(text), 'AR', 'Test XYZ not defined') : ackFor(controlIdOf(text)),
  );
  await link.start();
  offered = [
    row('LB2609270201', 'XYZ', 93000011),
    row('LB2609270202', 'K', 93000012),
    row('LB2609270203', 'NA', 93000013),
    row('LB2609270204', 'CL', 93000014),
    row('LB2609270205', 'MG', 93000015),
  ];
  await inner.pollOrders();
  assert.deepEqual(barcodesSent(fake), ['LB2609270201', 'LB2609270202', 'LB2609270203', 'LB2609270204', 'LB2609270205']);
  assert.deepEqual(inner.orders.get('LB2609270201')!.downloaded, [], 'the refused tube is not marked sent');
  assert.deepEqual(inner.orders.get('LB2609270205')!.downloaded, ['MG'], 'the tubes behind it went');
  assert.equal(inner.downloadFailStreak, 0, 'a refusal is not a link failure');
  assert.equal(inner.downloadPausedUntil, 0, 'and does not open the breaker');
  console.log('✓ a refused tube does not stop the others or pause the link');

  await inner.pollOrders();
  assert.equal(fake.sent.length, 5, 'the refused tube is not repeated on the very next poll');
  inner.refusedUntil.set('LB2609270201', Date.now() - 1); // the wait is over
  await inner.pollOrders();
  assert.equal(fake.sent.length, 6, 'it is offered again once the wait is over');
  assert.equal(barcodesSent(fake)[5], 'LB2609270201');
  console.log('✓ a refused tube is offered again after the wait, not on every poll');
}
{
  // IM holds the socket and answers nothing.
  const { inner, fake, link } = runtime('im-c', () => null);
  await link.start();
  offered = [1, 2, 3, 4, 5].map((n) => row(`LB260927030${n}`, 'K', 93000020 + n));
  await inner.pollOrders();
  assert.equal(fake.sent.length, 3, 'three unanswered sends, then it stops trying this tick');
  assert.ok(inner.downloadPausedUntil > Date.now(), 'the breaker is open');
  assert.deepEqual(inner.orders.get('LB2609270301')!.downloaded, [], 'nothing is marked sent');
  console.log('✓ a line that answers nothing opens the breaker after three tubes');
}

// ---------------------------------------------------------------------------
console.log('\n— over a real socket');
{
  // A stand-in IM: an MLLP listener that acknowledges every order.
  const got: string[] = [];
  const server = net.createServer((sock) => {
    const dec = new MllpDecoder('utf8');
    sock.on('data', (chunk) => {
      for (const text of dec.push(chunk)) {
        got.push(text);
        sock.write(wrapMllp(ackFor(controlIdOf(text)), 'utf8'));
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;

  const transport = new TcpTransport({ mode: 'client', host: '127.0.0.1', port, logger: quiet });
  const link = new Hl7Link(transport, { logger: quiet, sendingApp: 'HMIS-LIS', charset: '', orderPush: { ...PUSH, ackTimeoutMs: 3000 } });
  await link.start();
  for (let i = 0; i < 200 && !transport.connected; i++) await tick(10);
  assert.ok(transport.connected, 'the connector dialled the listener');

  await link.sendOrders([
    { sampleId: 'LB2609270123', testCodes: ['TSH3', 'B12'], specimenType: 'Serum', priority: 'R' },
    { sampleId: 'HE2609270249', testCodes: ['A1C1', 'EAG'], specimenType: 'EDTA', priority: 'S' },
  ]);
  assert.equal(got.length, 2);
  assert.deepEqual(testsSent(got[1]!), ['A1C1', 'EAG']);
  assert.equal(parseHl7(got[0]!).sendingApp, 'HMIS-LIS');
  await link.stop();
  await new Promise<void>((r) => server.close(() => r()));
  console.log('✓ two orders crossed a TCP socket in MLLP frames and were acknowledged');
}

rmSync(dir, { recursive: true, force: true });
console.log('\nIM order push: all checks passed');
process.exit(0);
