import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { parseAbl800, abl800Ack } from '../src/codec/abl800/parser.js';
import { Abl800Link } from '../src/codec/abl800/link.js';
import { parseMessage, buildOrderMessage, DEFAULT_DELIMS } from '../src/codec/astm/records.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the two machines taken over from the legacy Lab Integration.exe:
// Radiometer ABL800 FLEX (HL7 in SOH…EOT) and Sysmex CS-2500 (ASTM, 'sysmex-cs').
// Fixtures follow the legacy capture's layout; ids and values are made up.
//   Run:  npx tsx test/abl800-cs2500.test.ts

// ============================ ABL800 =========================================
const ABL = [
  'MSH|^~\\&|ABL835^ZYDUS HOSPITAL-AHD|ABL835^ZYDUS HOSPITAL-AHD|||20261112202629||ORU^R31|601|P|2.5|||AL|NE||||||',
  'PID|1||LB2611120001||^||||||||||||||||||||||||||||||||||',
  'PV1|1|U|||||||||||||||^||||||||||||||||||||||||||||||||||||',
  'ORC|NW|||||||||||||||||||||||||||||',
  'OBR|1|||Syringe^|||||||||||BLDA^^^LLFA^^^P|^||||||20261112201500|||F||||||||||||||||||||||||',
  'OBX|1|ST|^^^pO2^M||164|mmHg||H|||F|||20261112201500||^|||20261112201500',
  'NTE|1|L|83^',
  'OBX|2|ST|^^^pCO2^M||39.3|mmHg||N|||F|||||^|||',
  'OBX|3|ST|^^^pH^M||7.293|||N|||F|||||^|||',
  'OBX|4|ST|^^^K+^M||3.1|mmol/L||L|||F|||||^|||',
  'OBX|5|ST|^^^MetHb^M||.....|%||N|||F|||||^|||',
  'OBX|6|ST|^^^Anion gap^C||9.7|mmol/L||N|||F|||||^|||',
].join('\r') + '\r';

{
  const r = parseAbl800(ABL);
  assert.equal(r.barcode, 'LB2611120001', 'barcode from PID-3');
  const m = r.message!;
  assert.equal(m.protocol, 'abl800');
  assert.deepEqual(m.results.map((x) => x.testCode), ['pO2', 'pCO2', 'pH', 'K+', 'Anion gap'], 'code from OBX-3 component 4');
  assert.deepEqual(r.skipped, ['MetHb'], '"....." is not a value');
  const k = m.results.find((x) => x.testCode === 'K+')!;
  assert.deepEqual([k.sampleId, k.value, k.unit, k.abnormalFlag], ['LB2611120001', '3.1', 'mmol/L', 'L']);
  assert.equal(m.results[1]!.completedAt, '20261112201500', 'OBR time fills OBX without one');

  const ack = abl800Ack(r.hl7);
  assert.match(ack, /^MSH\|\^~\\&\|LIS\|\|ABL835\^ZYDUS HOSPITAL-AHD\|/);
  assert.match(ack, /\|ACK\^R31\|601\|P\|2\.5\r/);
  assert.match(ack, /\rMSA\|AA\|601\r$/, 'MSA-2 echoes the message control id');

  const noId = parseAbl800(ABL.replace('PID|1||LB2611120001|', 'PID|1|||'));
  assert.equal(noId.message, null, 'no PID-3 → nothing to file');
  console.log('✓ ABL800 parser: PID-3 barcode, OBX-3.4 code, dots skipped, ACK echoes control id');
}

class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://abl800';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    this.writes.push(d);
  }
}
const tick = () => new Promise((r) => setImmediate(r));

{
  const t = new FakeTransport();
  const link = new Abl800Link(t as never, { logger, ackFraming: 'mllp' });
  const got: ParsedMessage[] = [];
  link.on('message', (m: ParsedMessage) => got.push(m));
  await link.start();
  const frame = Buffer.from(`\x01${ABL}\x04`, 'latin1');
  t.emit('data', frame.subarray(0, 50));
  t.emit('data', Buffer.concat([frame.subarray(50), Buffer.from('\r\n')]));
  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0]!.results.length, 5);
  assert.equal(t.writes.length, 1);
  assert.equal(t.writes[0]![0], 0x0b, 'MLLP ACK starts with VT');
  assert.deepEqual([...t.writes[0]!.subarray(-2)], [0x1c, 0x0d], 'and ends FS CR');

  const t2 = new FakeTransport();
  const l2 = new Abl800Link(t2 as never, { logger, ackFraming: 'soh-eot' });
  await l2.start();
  t2.emit('data', frame);
  await tick();
  assert.equal(t2.writes[0]![0], 0x01);
  assert.equal(t2.writes[0]!.at(-1), 0x04, 'soh-eot ACK framing');
  console.log('✓ ABL800 link: SOH…EOT framing across chunks, one message, ACK framing per setting');
}

{
  const p = PROFILE_LIBRARY['radiometer-abl800'].defaults as Record<string, any>;
  assert.equal(p.protocol, 'abl800');
  assert.deepEqual([p.transport.mode, p.transport.port], ['server', 6001]);
  assert.equal(p.hostQuery, false);
  assert.equal(p.orderPoll.download, false);
  console.log('✓ profile radiometer-abl800');
}

// ============================ CS-2500 ========================================
const D = DEFAULT_DELIMS;
const CS_QUERY = [
  'H|\\^&|||CS-2500^^26899^^^CP^BV981798||||||||E1394-97',
  'Q|1|001162^01^   HE2611120001^M||^^^040^PT-THS\\^^^050^APTT-FS\\^^^060^Fbg-DT\\^^^610^INN-DDi|0|20261112202141',
  'L|1|N',
];
const CS_RESULT = [
  'H|\\^&|||CS-2500^00-16^26899^^^CP^BV981798||||||||E1394-97',
  'P|1||||^^TEST PATIENT',
  'O|1||001161^01^   HE2611120002^M^||R||||||N',
  'R|1|^^^041^PT THS~sec^100.00^9^^^|  10.8|sec||N||||||20261112200426',
  'R|2|^^^044^PT THS~INR^100.00^9^^^|  1.05|||N||||||20261112200426',
  'R|3|^^^051^APTT FS~sec^100.00^9^^^|  23.8|sec||N||||||20261112200246',
  'L|1|N',
];

{
  const q = parseMessage(CS_QUERY, CS_QUERY.join('\r'), 'sysmex-cs');
  assert.equal(q.queries.length, 1);
  assert.equal(q.queries[0]!.sampleId, 'HE2611120001', 'barcode is Q field 3 component 3, not the rack');
  assert.equal(q.queries[0]!.specimenIdField, '001162^01^   HE2611120001^M');

  const r = parseMessage(CS_RESULT, CS_RESULT.join('\r'), 'sysmex-cs');
  assert.deepEqual(
    r.results.map((x) => [x.sampleId, x.testCode, x.value]),
    [
      ['HE2611120002', '041', '10.8'],
      ['HE2611120002', '044', '1.05'],
      ['HE2611120002', '051', '23.8'],
    ],
    'barcode from O field 4, code from component 4',
  );
  console.log('✓ CS-2500 parse: query barcode, result barcode, result codes');
}

{
  // HMIS result codes 041/044/051 in → the legacy reply's order codes out.
  const lines = buildOrderMessage(
    [{ sampleId: 'HE2611120001', testCodes: ['051', '041', '044', '999'], queryReply: true, specimenIdField: '001162^01^   HE2611120001^M', patient: { lastName: 'TEST', firstName: 'PATIENT', birthDate: '19800428', sex: 'M' } }],
    { dialect: 'sysmex-cs', senderId: '', receiverId: '', sendDemographics: true } as never,
    D,
  );
  assert.equal(lines[0], 'H|\\^&|||||||||||E1394-97|');
  assert.equal(lines[1]!.split('|').length, 35, 'P record padded like the legacy one');
  const o = lines[2]!.split('|');
  assert.equal(o.length, 31);
  assert.equal(o[2], '001162^01^ HE2611120001^C', 'rack^pos^ barcode(13)^C');
  assert.equal(o[4], '^^^050^^100.00\\^^^040^^100.00^DF\\^^^040^^100.00^DR', 'APTT 050, PT as the DF+DR pair, unknown 999 dropped');
  assert.equal(o[5], 'R');
  assert.match(o[6]!, /^\d{14}$/);
  assert.equal(o[11], 'N');
  assert.equal(lines[3], 'L|1|N');
  console.log('✓ CS-2500 query reply matches the legacy layout');
}

{
  const p = PROFILE_LIBRARY['sysmex-cs2500'].defaults as Record<string, any>;
  assert.equal(p.protocol, 'astm');
  assert.equal(p.astm.dialect, 'sysmex-cs');
  assert.deepEqual([p.transport.mode, p.transport.port], ['server', 2300]);
  assert.equal(p.hostQuery, true);
  console.log('✓ profile sysmex-cs2500');
}

console.log('abl800-cs2500: all checks passed');
