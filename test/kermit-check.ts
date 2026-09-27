import {
  DEFAULT_PARAMS,
  KermitDecoder,
  buildTransfer,
  checksum,
  encodePacket,
  parseSendInit,
  quote,
  unquote,
} from '../src/codec/kermit/packets.js';
import { buildOrderRecord, orderFileName, parseResultFile } from '../src/codec/kermit/vitros250.js';
import { KermitLink } from '../src/codec/kermit/link.js';
import { EventEmitter } from 'node:events';

// =============================================================================
// VITROS 250 (Kermit) — golden tests replayed from the PRODUCTION capture of
// the lab's existing integration (E:\API_Integration\Devices\250).
//
// Every expectation below is bytes the analyzer has actually exchanged, not a
// shape inferred from a datasheet. Treat a diff here as a regression in the
// codec, not a reason to edit the expectation.
// =============================================================================

const G = '\x1b[32m✓\x1b[0m';
const B = '\x1b[31m✗\x1b[0m';
let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? G : B} ${label}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const SOH = '\x01';
const CR = '\r';

console.log('\n[1] Packet layer — the captured order transfer for sample SF2608310028');
// Exact bytes logged on 31-08-2026 12:01:06..12:01:10 (SFILE7.D).
const ORDER_PAYLOAD = '   SF260831002810 1.000L3f1;Z.|               SUMANVERMA]';
const WIRE_S = `${SOH}# S8${CR}`;
const WIRE_F = `${SOH}+!FSFILE7.DP${CR}`;
const WIRE_D = `${SOH}\\"D${ORDER_PAYLOAD}\\${CR}`;
const WIRE_Z = `${SOH}##ZB${CR}`;
const WIRE_B = `${SOH}#$B+${CR}`;

const packets = buildTransfer('SFILE7.D', ORDER_PAYLOAD, DEFAULT_PARAMS);
const wire = packets.map((p) => encodePacket(p, DEFAULT_PARAMS).toString('latin1'));
eq('send-init  S', wire[0], WIRE_S);
eq('file head  F', wire[1], WIRE_F);
eq('data       D', wire[2], WIRE_D);
eq('end-of-file Z', wire[3], WIRE_Z);
eq('break      B', wire[4], WIRE_B);
eq('one D packet is enough for this payload', packets.filter((p) => p.type === 'D').length, 1);

console.log('\n[2] Checksums match the analyzer\'s own (type-1, six-bit fold)');
// '+!FSFILE7.D' -> 'P' was verified by hand against the capture.
eq('F packet checksum', checksum('+!FSFILE7.D'), 'P');
eq('S packet checksum', checksum('# S'), '8');
eq('Z packet checksum', checksum('##Z'), 'B');
eq('B packet checksum', checksum('#$B'), '+');

console.log('\n[3] Order records rebuild the captured payloads byte-for-byte');
const order = (sampleId: string, codes: number[], name: string) => ({
  sampleId,
  testCodes: codes.map(String),
  priority: 'R' as const,
  patient: { patientId: null, lastName: name, firstName: null, middleName: null, sex: null, birthDate: null },
  specimenType: null,
});
// Test codes are single BYTES: 76='L', 51='3', 102='f', 49='1', 59=';', 90='Z', 46='.'
eq('SF2608310028 (7 assays)', buildOrderRecord(order('SF2608310028', [76, 51, 102, 49, 59, 90, 46], 'SUMANVERMA')), ORDER_PAYLOAD);
eq('SF2608310031 (3 assays)', buildOrderRecord(order('SF2608310031', [76, 90, 46], 'MEERAANKITVAIDYA')),
   '   SF260831003110 1.000LZ.|         MEERAANKITVAIDYA]');
// Assay code 32 is a SPACE — the test list must never be trimmed.
eq('SF2608310010 (assay 32 = space)', buildOrderRecord(order('SF2608310010', [32], 'PIYUSHDEDHIA')),
   '   SF260831001010 1.000 |             PIYUSHDEDHIA]');
eq('name is flattened and right-aligned in 25',
   buildOrderRecord(order('SF2608310026', [76], 'MOTIBHAI M CHAUDHARY')),
   '   SF260831002610 1.000L|       MOTIBHAIMCHAUDHARY]');
eq('file names cycle SFILE1..8', [1, 7, 8, 9].map(orderFileName), ['SFILE1.D', 'SFILE7.D', 'SFILE8.D', 'SFILE1.D']);

console.log('\n[4] Result file — the captured upload for SF2608310014');
// Legacy Result_Flow.log recorded exactly: test=90 result=76, test=46 result=.7
// (assay 76 came back "NO RESULT" and must NOT be filed).
const RESULT = '1131410831               SF2608310014   10%41.000LNO RESULT060MENSPF}Z   76.   000}.     .7  000}|**250*    ]';
const parsed = parseResultFile(RESULT, new Date('2026-08-31T12:00:00'));
eq('results', parsed.results.map((r) => [r.sampleId, r.testCode, r.value, r.abnormalFlag]), [
  ['SF2608310014', '90', '76', null],
  ['SF2608310014', '46', '.7', null],
]);
eq('"NO RESULT" is not filed', parsed.results.some((r) => r.value.includes('RESULT')), false);
eq('completedAt carries the year the record omits', parsed.results[0]!.completedAt, '20260831113141');

console.log('\n[5] Result file — alarm flags and multiple records in one transfer');
const FLAGGED = '0904270831TP             G2905          10!01.000)  114.2  000}    84.5  0C0NQ}$  113.0  0C0NQ}|**250*    ]';
const f = parseResultFile(FLAGGED, new Date('2026-08-31T12:00:00'));
eq('flagged results', f.results.map((r) => [r.testCode, r.value, r.abnormalFlag]), [
  ['41', '114.2', null],
  ['32', '84.5', '0C0NQ'],
  ['36', '113.0', '0C0NQ'],
]);
const TWO = '1131400831               SF2608310017   10#41.000Z   12.   000}|**250*    ]'
          + '1131410831               SF2608310020   10$41.000.    3.4  000}|**250*    ]';
eq('two records in one file', parseResultFile(TWO, new Date('2026-08-31T12:00:00')).results.map((r) => [r.sampleId, r.testCode, r.value]),
   [['SF2608310017', '90', '12'], ['SF2608310020', '46', '3.4']]);

console.log('\n[6] Control quoting — the trap that shifts every later field');
// A sequence of 3 IS the quote character, so it travels as "##". Skipping the
// unquote step moved the dilution field from "1.000" to "41.00" on 202 of the
// captured records.
eq('literal # round-trips', unquote(quote('10#41.000')), '10#41.000');
eq('# is doubled on the wire', quote('#'), '##');
eq('control chars are quoted', quote('\x01\x0d'), '#A#M');
eq('and come back', unquote('#A#M'), '\x01\r');
eq('a record with a quoted sequence parses to the right dilution',
   unquote('SF2608310007   10##41.000').slice(15), '10#41.000');

console.log('\n[7] Send-init negotiation with the analyzer\'s own announcement');
// The VITROS answers with "~* @-#N1".
const p = parseSendInit('~* @-#N1');
eq('maxl / eol / qctl / chkt', [p.maxl, p.eol, p.qctl, p.chkt], [94, 13, '#', '1']);
eq('an empty send-init keeps the defaults', parseSendInit('').maxl, DEFAULT_PARAMS.maxl);

console.log('\n[8] Round trip through the decoder, including a payload that must split');
const big = 'X'.repeat(500) + '#' + '\x01';
const rt = buildTransfer('SFILE1.D', big, { ...DEFAULT_PARAMS, maxl: 40 });
const dec = new KermitDecoder();
const seen = rt.flatMap((pk) => dec.push(encodePacket(pk, { ...DEFAULT_PARAMS, maxl: 40 })));
eq('every packet decodes with a valid checksum', seen.every((s) => s.valid), true);
eq('payload survives chunking + quoting', unquote(seen.filter((s) => s.packet.type === 'D').map((s) => s.packet.data).join('')), big);
eq('no D packet exceeds the negotiated MAXL', seen.filter((s) => s.packet.type === 'D').every((s) => s.packet.data.length + 3 <= 40), true);

console.log('\n[9] Idle line noise must not break framing');
// The VITROS 250's RS-232 line is NOT quiet between transfers: listening on
// COM2 with nothing running produces a steady 0x80/0x00 dribble (~16 bytes/s),
// and the legacy integration logged the same junk for months. A decoder that
// treats stray bytes as an error, or that lets them accumulate, would never
// see a real packet.
const NOISE = Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 2 ? 0x00 : 0x80)));
const noisy = new KermitDecoder();
eq('noise alone yields no packets', noisy.push(NOISE).length, 0);
eq('noise does not stall the decoder', noisy.push(NOISE).length, 0);
// A real packet arriving after (and between) noise still decodes.
const real = Buffer.from(WIRE_F, 'latin1');
const framed = noisy.push(Buffer.concat([NOISE, real, NOISE]));
eq('a packet buried in noise still decodes', framed.map((f) => [f.packet.type, unquote(f.packet.data), f.valid]), [['F', 'SFILE7.D', true]]);
// Split across chunk boundaries, the way a serial read actually delivers it.
const split = new KermitDecoder();
const halves = [Buffer.concat([NOISE, real.subarray(0, 5)]), Buffer.concat([real.subarray(5), NOISE])];
eq('a packet split across reads still decodes',
   halves.flatMap((h) => split.push(h)).map((f) => [f.packet.type, f.valid]), [['F', true]]);

console.log('\n[10] A transfer nobody acknowledges says WHY — silence vs. a wrong-baud answer');
// Shela VITROS 250, 2026-09-16: every send-init timed out, 5 x 10 s, with an
// empty inbound wire log. That log could not tell a dead cable from an
// analyzer answering at the wrong baud rate — now the failure says which.
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://vitros250';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> { this.writes.push(d); }
}
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never;
const silentOrder = { sampleId: 'ZC2609160012', testCodes: ['Z'], priority: 'R', patient: null, specimenType: 'Serum' };
{
  const t = new FakeTransport();
  const link = new KermitLink(t as never, { ackTimeoutMs: 20, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  const wire: string[] = [];
  link.on('wire', (w: { direction: string; text: string }) => wire.push(w.direction + ' ' + w.text));
  await link.start();
  let err = '';
  try { await link.sendOrders([silentOrder]); } catch (e) { err = (e as Error).message; }
  eq('silent analyzer: the error names the cable / host-comms check', /nothing at all was received/.test(err), true);
  eq('silent analyzer: no inbound wire line is invented', wire.filter((w) => w.startsWith('IN')).length, 0);
}
{
  const t = new FakeTransport();
  const link = new KermitLink(t as never, { ackTimeoutMs: 20, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  const wire: string[] = [];
  link.on('wire', (w: { direction: string; text: string }) => wire.push(w.direction + ' ' + w.text));
  await link.start();
  // Answer every packet with what a 9600-baud reply looks like when read at
  // the wrong rate: framing garbage, never an SOH.
  const origWrite = t.write.bind(t);
  t.write = async (d: Buffer) => { await origWrite(d); t.emit('data', Buffer.from([0xf8, 0x00, 0xfe, 0x80, 0x00])); };
  let err = '';
  try { await link.sendOrders([silentOrder]); } catch (e) { err = (e as Error).message; }
  eq('wrong-baud analyzer: the error names the baud/parity check', /not Kermit packets: check baud\/parity/.test(err), true);
  eq('wrong-baud analyzer: the bytes it sent are in the wire log', wire.some((w) => w.startsWith('IN (not Kermit') && w.includes('<F8>')), true);
}

console.log('\n[11] The analyzer\'s idle heartbeat — a bare NAK(0) every ~60 s — is never answered');
// Legacy capture: 51,501 heartbeats, none answered by the host. This link used
// to answer the second one with a Y (as "a repeat of the last acknowledged
// packet"), after which the analyzer refused the next send-init with "0005
// INVALID PACKET USAGE" — 28 of 28 downloads after ≥2 min of quiet, 16–17 Sep.
{
  const t = new FakeTransport();
  const link = new KermitLink(t as never, { ackTimeoutMs: 20, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  await link.start();
  const heartbeat = encodePacket({ seq: 0, type: 'N', data: '' });
  for (let i = 0; i < 4; i++) t.emit('data', heartbeat);
  t.emit('data', encodePacket({ seq: 0, type: 'Y', data: '' })); // a stray ACK is noise too
  eq('four heartbeats and a stray Y: nothing written back', t.writes.length, 0);
}

console.log('\n[12] Our acknowledgement of the analyzer\'s send-init is the legacy host\'s bare "# Y>"');
// Vitros250_String.txt: every one of 1,598 captured receives was opened with
// a Y carrying no parameters (SOH '#' ' ' 'Y' '>'). Matching it exactly.
{
  const t = new FakeTransport();
  const link = new KermitLink(t as never, { ackTimeoutMs: 20, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  await link.start();
  t.emit('data', encodePacket({ seq: 0, type: 'S', data: '~* @-#N1\\' }));
  eq('exactly one packet went back', t.writes.length, 1);
  eq('and it is "# Y>" + CR, byte for byte', t.writes[0]!.toString('latin1'), '\x01# Y>\r');
}

console.log('\n[13] Every wire line carries the packet exchange behind it');
{
  // A full result receive: S F D Z B from the analyzer, our Y to each.
  const t = new FakeTransport();
  const link = new KermitLink(t as never, { ackTimeoutMs: 20, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  const wire: { direction: string; text: string; trace?: string }[] = [];
  link.on('wire', (w: { direction: string; text: string; trace?: string }) => wire.push(w));
  link.on('message', () => {});
  await link.start();
  for (const pk of buildTransfer('R0000007', RESULT)) t.emit('data', encodePacket(pk));
  eq('one IN line for the file', wire.map((w) => w.direction), ['IN']);
  eq('its trace opens with the S and our bare Y', wire[0]!.trace?.startsWith('←S0 →Y0 ←F1(R0000007) →Y1 ←D2['), true);
  eq('and closes with the B and its Y', wire[0]!.trace?.endsWith('←Z4 →Y4 ←B5 →Y5'), true);

  // A download the analyzer acknowledges packet by packet.
  const t2 = new FakeTransport();
  const link2 = new KermitLink(t2 as never, { ackTimeoutMs: 50, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  const wire2: { direction: string; text: string; trace?: string }[] = [];
  link2.on('wire', (w: { direction: string; text: string; trace?: string }) => wire2.push(w));
  await link2.start();
  const origWrite = t2.write.bind(t2);
  t2.write = async (d: Buffer) => {
    await origWrite(d);
    const [{ packet }] = new KermitDecoder().push(d);
    setImmediate(() => t2.emit('data', encodePacket({ seq: packet!.seq, type: 'Y', data: packet!.type === 'S' ? '~* @-#N1\\' : '' })));
  };
  await link2.sendOrders([silentOrder]);
  eq('one OUT line for the download', wire2.map((w) => w.direction), ['OUT']);
  const dLen = buildOrderRecord(silentOrder as never).length;
  eq('its trace shows each packet and its acknowledgement', wire2[0]!.trace, `→S0 ←Y0(~* @-#N1\\) →F1(SFILE1.D) ←Y1 →D2[${dLen}] ←Y2 →Z3 ←Y3 →B4 ←Y4`);

  // A download the analyzer refuses: the refusal is on the same line.
  const t3 = new FakeTransport();
  const link3 = new KermitLink(t3 as never, { ackTimeoutMs: 50, maxRetries: 2, interPacketDelayMs: 0, interTransferDelayMs: 0, logger: quiet });
  const wire3: { direction: string; text: string; trace?: string }[] = [];
  link3.on('wire', (w: { direction: string; text: string; trace?: string }) => wire3.push(w));
  await link3.start();
  const origWrite3 = t3.write.bind(t3);
  t3.write = async (d: Buffer) => {
    await origWrite3(d);
    setImmediate(() => t3.emit('data', encodePacket({ seq: 0, type: 'E', data: '0005 INVALID PACKET USAGE    ' })));
  };
  let refused = '';
  try { await link3.sendOrders([silentOrder]); } catch (e) { refused = (e as Error).message; }
  eq('the error names the analyzer\'s reason', refused, 'VITROS rejected the transfer: 0005 INVALID PACKET USAGE');
  eq('and the wire line records S → E', wire3[0]!.trace, '→S0 ←E0(0005 INVALID PACKET USAGE) ✗ VITROS rejected the transfer: 0005 INVALID PACKET USAGE');
}

console.log(failures ? `\n${B} ${failures} assertion(s) failed\n` : `\n${G} all assertions passed\n`);
process.exit(failures ? 1 : 0);
