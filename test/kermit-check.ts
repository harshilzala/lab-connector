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

console.log(failures ? `\n${B} ${failures} assertion(s) failed\n` : `\n${G} all assertions passed\n`);
process.exit(failures ? 1 : 0);
