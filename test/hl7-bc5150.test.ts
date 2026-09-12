import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { hl7ToParsedMessage, parseHl7 } from '../src/codec/hl7/parser.js';
import { wrapMllp } from '../src/codec/hl7/mllp.js';
import { Hl7Link } from '../src/codec/hl7/link.js';
import { toResultUploads } from '../src/mapping/mapper.js';
import type { AnalyzerConfig } from '../src/config.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the HL7 link against the Mindray BC-5000 / BC-5150.
//
// Fixtures are the messages printed in "BC-5000&BC-5150 HL7 Communication
// Protocol V2.0 EN" (Z-110-002557-002-2.0): the §5.1 sample message with the
// "***.**" placeholders replaced by plausible values, and the same message as
// the §5.3 QC variant (MSH-11 = Q). What the document pins that the H360 test
// does not:
//   • MSH-11 is "P" for a sample and "Q" for a QC result, and the ACK must
//     carry the same value (§4.3.1, §5.4);
//   • a QC message is recognised from MSH-11, not from the barcode — OBR-3 is
//     then a QC FILE NUMBER, which can look exactly like a patient barcode;
//   • an OBX with an empty OBX-3 (the document's own line 29) is skipped;
//   • the 3-part mnemonics (LYM/MID/GRAN) and the 99MRC-coded PCT/PLCR come
//     through as the second component of OBX-3.
//   Run:  npx tsx test/hl7-bc5150.test.ts

const CR = '\r';

function sampleMessage(processingId: 'P' | 'Q', sampleId: string, controlId: string): string {
  return [
    `MSH|^~\\&|||||20260912104344||ORU^R01|${controlId}|${processingId}|2.3.1||||||UNICODE`,
    'PID|1||ChartNo^^^^MR||LastName^FirstName||20040506070809|Male',
    'PV1|1|Neike|Hema^^BN1|||||||||||||||||ChargeType',
    `OBR|1||${sampleId}|00001^Automated Count^99MRC||20260912100000|20260912104300|||Sender|||Cold|20260912101000||||||||20260912104300||HM||||Auditer||||Tester`,
    'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
    'OBX|2|IS|08002^Blood Mode^99MRC||W||||||F',
    'OBX|3|IS|08003^Test Mode^99MRC||CBC||||||F',
    'OBX|4|IS|01002^Ref Group^99MRC||Common||||||F',
    'OBX|5|NM|30525-0^Age^LN||22|yr|||||F',
    'OBX|6|ST|01001^Remark^99MRC||Remark||||||F',
    'OBX|7|NM|6690-2^WBC^LN||7.52|10*9/L|4.00-10.00|N|||F',
    'OBX|8|NM|731-0^LYM#^LN||2.01|10*9/L|0.80-4.00|N|||F',
    'OBX|9|NM|736-9^LYM%^LN||26.7|%|20.0-40.0|N|||F',
    'OBX|10|NM|789-8^RBC^LN||4.51|10*12/L|3.50-5.50|N|||F',
    'OBX|11|NM|718-7^HGB^LN||98|g/L|110-150|L~A|||F',
    'OBX|12|NM|787-2^MCV^LN||78.4|fL|80.0-100.0|L|||F',
    'OBX|13|NM|785-6^MCH^LN||21.7|pg|27.0-34.0|L|||F',
    'OBX|14|NM|786-4^MCHC^LN||277|g/L|320-360|L|||F',
    'OBX|15|NM|788-0^RDW-CV^LN||16.3|%|11.0-16.0|H|||F',
    'OBX|16|NM|21000-5^RDW-SD^LN||45.1|fL|35.0-56.0|N|||F',
    'OBX|17|NM|4544-3^HCT^LN||35.4|%|37.0-54.0|L|||F',
    'OBX|18|NM|777-3^PLT^LN||267|10*9/L|100-300|N|||F',
    'OBX|19|NM|32623-1^MPV^LN||8.8|fL|6.5-12.0|N|||F',
    'OBX|20|NM|32207-3^PDW^LN||15.1||9.0-17.0|N|||F',
    'OBX|21|NM|10002^PCT^99MRC||0.236|%|0.108-0.282|N|||F',
    'OBX|22|NM|10027^MID#^99MRC||0.61|10*9/L|0.10-1.50|N|||F',
    'OBX|23|NM|10029^MID%^99MRC||8.1|%|3.0-15.0|N|||F',
    'OBX|24|NM|10028^GRAN#^99MRC||4.90|10*9/L|2.00-7.00|N|||F',
    'OBX|25|NM|10030^GRAN%^99MRC||65.2|%|50.0-70.0|N|||F',
    'OBX|26|NM|10014^PLCR^99MRC||19.6|%|13.0-43.0|N|||F',
    'OBX|27|IS|12045^Multiple alerts^99MRC||T||||||F',
    'OBX|28|IS|12046^Lym left region alert^99MRC||T||||||F',
    'OBX|29|IS|||T||||||F',
    'OBX|35|NM|15004^WBC Histogram. Meta Length^99MRC||1||||||F',
    'OBX|40|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^AAAAAAAAAAAAAAAAAAAAAA==||||||F',
  ].join(CR) + CR;
}

// The 21 numeric analytes the document defines for this instrument, as the
// second component of OBX-3 — the analyzer's own mnemonic.
const EXPECTED: Record<string, string> = {
  WBC: '7.52',
  'LYM#': '2.01',
  'LYM%': '26.7',
  RBC: '4.51',
  HGB: '98',
  MCV: '78.4',
  MCH: '21.7',
  MCHC: '277',
  'RDW-CV': '16.3',
  'RDW-SD': '45.1',
  HCT: '35.4',
  PLT: '267',
  MPV: '8.8',
  PDW: '15.1',
  PCT: '0.236',
  'MID#': '0.61',
  'MID%': '8.1',
  'GRAN#': '4.90',
  'GRAN%': '65.2',
  PLCR: '19.6',
  // NM-typed non-results. The parser keeps every NM; the analyzer's
  // allowTestCodes is what drops these at filing time.
  Age: '22',
  'WBC Histogram. Meta Length': '1',
};

// ---- 1) sample message: MSH-11 P, analytes, flags, empty OBX-3 ------------
{
  const msg = parseHl7(sampleMessage('P', 'SF2609120011', '17'));
  assert.equal(msg.messageType, 'ORU^R01');
  assert.equal(msg.controlId, '17');
  assert.equal(msg.processingId, 'P', 'MSH-11 read');
  assert.equal(msg.charset, 'UNICODE');

  const parsed = hl7ToParsedMessage(msg);
  assert.ok(parsed, 'sample produced results');
  assert.equal(parsed!.isQc, false, 'MSH-11 P is not QC');
  assert.equal(parsed!.results.length, Object.keys(EXPECTED).length, 'NM analytes only');
  for (const r of parsed!.results) {
    assert.equal(r.sampleId, 'SF2609120011', 'barcode from OBR-3');
    assert.ok(r.testCode in EXPECTED, `unexpected analyte ${r.testCode}`);
    assert.equal(r.value, EXPECTED[r.testCode], `${r.testCode} value`);
  }
  const byCode = new Map(parsed!.results.map((r) => [r.testCode, r]));
  assert.equal(byCode.get('HGB')!.abnormalFlag, 'L', 'first repeat of "L~A"');
  assert.equal(byCode.get('HGB')!.unit, 'g/L');
  assert.equal(byCode.get('WBC')!.unit, '10*9/L', 'ISO unit spelling from §5.9');
  assert.equal(byCode.get('PCT')!.referenceRange, '0.108-0.282');
  assert.ok(byCode.has('Age'), 'Age is NM: kept by the parser, dropped later by allowTestCodes');
  assert.ok(!byCode.has(''), 'empty OBX-3 (document line 29) skipped');
  console.log(`✓ sample message: ${parsed!.results.length} analytes, MSH-11=${msg.processingId}`);
}

// ---- 2) QC message: MSH-11 Q marks the run as QC whatever the barcode ------
{
  // A QC file number that would pass every patient-barcode rule.
  const msg = parseHl7(sampleMessage('Q', 'SF2609120099', '18'));
  assert.equal(msg.processingId, 'Q');
  const parsed = hl7ToParsedMessage(msg);
  assert.ok(parsed);
  assert.equal(parsed!.isQc, true, 'MSH-11 Q → isQc');

  const analyzer = {
    equipmentCode: 'ZHPN001',
    equipmentId: null,
    qc: { sampleIdPrefixes: ['QC'], patientPrefixes: [], sampleIdRegex: '', upload: false },
  } as unknown as AnalyzerConfig;
  const uploads = toResultUploads(analyzer, parsed!);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.isQc, true, 'upload carries the protocol QC flag even though the barcode looks like a patient');

  const sample = toResultUploads(analyzer, hl7ToParsedMessage(parseHl7(sampleMessage('P', 'SF2609120099', '19')))!);
  assert.equal(sample[0]!.isQc, false, 'same barcode with MSH-11 P is a patient');
  console.log('✓ QC message: isQc from MSH-11, independent of the barcode');
}

// ---- 3) link: ACK echoes MSH-10 AND MSH-11 --------------------------------
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://bc5150';
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
const link = new Hl7Link(transport as never, { logger, charset: 'UNICODE' });
const messages: ParsedMessage[] = [];
link.on('message', (m: ParsedMessage) => messages.push(m));
link.on('error', (e: Error) => {
  throw e;
});
await link.start();

// The instrument's 0x02 keep-alive, seen on the wire every 3 s at 10.20.4.50,
// must be discarded as noise in front of the real frame.
transport.feed(Buffer.from([0x02]));
transport.feed(Buffer.from([0x02]));
transport.feed(wrapMllp(sampleMessage('P', 'SF2609120011', '21')));
transport.feed(Buffer.from([0x02]));
transport.feed(wrapMllp(sampleMessage('Q', '3', '22')));
await new Promise((r) => setTimeout(r, 20));
await link.stop();

assert.equal(messages.length, 2, 'both messages delivered despite the STX keep-alives');
assert.equal(messages[0]!.isQc, false);
assert.equal(messages[1]!.isQc, true);
assert.equal(transport.writes.length, 2, 'one ACK each');

const ackFields = (b: Buffer) => b.subarray(1, b.length - 2).toString('utf8').split(CR);
{
  const [msh, msa] = ackFields(transport.writes[0]!);
  const f = msh!.split('|');
  assert.equal(f[8], 'ACK^R01');
  assert.equal(f[9], '21', 'MSH-10 echoed');
  assert.equal(f[10], 'P', 'MSH-11 echoed for a sample');
  assert.equal(f[17], 'UNICODE');
  assert.equal(msa, 'MSA|AA|21');
}
{
  const [msh, msa] = ackFields(transport.writes[1]!);
  const f = msh!.split('|');
  assert.equal(f[9], '22');
  assert.equal(f[10], 'Q', 'MSH-11 echoed for a QC result (§5.4)');
  assert.equal(msa, 'MSA|AA|22');
}
// The document's §5.2 reference, modulo timestamp:
//   MSH|^~\&|LIS||||<ts>||ACK^R01|<id>|P|2.3.1||||||UNICODE  MSA|AA|<id>
const ref = 'MSH|^~\\&|LIS||||<ts>||ACK^R01|21|P|2.3.1||||||UNICODE\rMSA|AA|21\r';
const got = transport.writes[0]!.subarray(1, transport.writes[0]!.length - 2).toString('utf8');
assert.equal(got.replace(/\|\d{14}\|/, '|<ts>|'), ref, 'ACK matches the document §5.2 shape');
console.log('✓ link: STX keep-alives ignored, ACK echoes MSH-10 and MSH-11');


// ---- 4) wire-log noise: bitmaps elided, one line per message, keep-alives silent
// Shape of the first live capture (Shela, 2026-09-12): 70 OBX per message, five
// of them ED-typed Base64 bitmaps of ~32-38 KB each, delivered in 8 KB TCP
// chunks, with a bare 0x02 every 3 s between messages. Before this the wire
// log was 75% keep-alive lines and ~40 chunk-lines of Base64 per result.
{
  const bmp = 'AAAA'.repeat(8000); // 32 000 chars of Base64
  const withBitmaps =
    [
      'MSH|^~\\&|||||20260912145834||ORU^R01|6|P|2.3.1||||||UNICODE',
      'PID|1||^^^^MR',
      'OBR|1||bhavesh|00001^Automated Count^99MRC|||20260911085915|||||||||||||||||HM||||||||Administrator',
      'OBX|5|NM|6690-2^WBC^LN||7.07|10*3/uL|4.00-10.00|N|||F',
      'OBX|39|NM|718-7^HGB^LN||14.3|g/dL|11.0-16.0|N|||F',
      `OBX|56|ED|15008^WBC Histogram. BMP^99MRC||^Application^Octer-stream^Base64^${bmp}||||||F`,
      `OBX|67|ED|15200^WBC DIFF Scattergram. BMP^99MRC||^Application^Octer-stream^Base64^${bmp}||||||F`,
    ].join(CR) + CR;
  const frame = wrapMllp(withBitmaps);

  const t = new FakeTransport();
  const l = new Hl7Link(t as never, { logger, charset: 'UNICODE' });
  const wire: Array<{ direction: string; text: string }> = [];
  const got: ParsedMessage[] = [];
  l.on('wire', (w: { direction: string; text: string }) => wire.push(w));
  l.on('message', (m: ParsedMessage) => got.push(m));
  await l.start();
  // keep-alives, then the message in 8 KB chunks, then more keep-alives
  t.feed(Buffer.from([0x02]));
  t.feed(Buffer.from([0x02]));
  for (let i = 0; i < frame.length; i += 8192) t.feed(frame.subarray(i, i + 8192));
  t.feed(Buffer.from([0x02]));
  await new Promise((r) => setTimeout(r, 10));
  await l.stop();

  assert.equal(got.length, 1, 'message delivered');
  assert.equal(got[0]!.results.length, 2, 'ED segments are not results');
  const inLines = wire.filter((w) => w.direction === 'IN');
  assert.equal(inLines.length, 1, 'ONE wire line for the whole message, none for the keep-alives or the chunks');
  assert.ok(inLines[0]!.text.length < 1500, `wire line is compact (${inLines[0]!.text.length} chars, was ${frame.length})`);
  assert.ok(inLines[0]!.text.includes('chars omitted>'), 'bitmap field elided with a size note');
  assert.ok(inLines[0]!.text.includes('OBX|5|NM|6690-2^WBC^LN||7.07|10*3/uL'), 'numeric segments untouched');
  assert.ok(got[0]!.raw.length < 1500, 'raw kept in the spool is the elided text too');
  assert.ok(!got[0]!.raw.includes(bmp), 'no bitmap in the spool raw');
  assert.equal(wire.filter((w) => w.direction === 'OUT').length, 1, 'still exactly one ACK');
  console.log(`✓ wire log: ${frame.length} bytes on the wire → ${inLines[0]!.text.length}-char line, keep-alives silent`);
}

// ---- 5) profile: Background counts are not patients ------------------------
{
  const { PROFILE_LIBRARY } = await import('../src/profiles/index.js');
  const { isQcSample } = await import('../src/mapping/mapper.js');
  const qc = { ...(PROFILE_LIBRARY['mindray-bc5150'].defaults.qc as object), sampleIdRegex: null, patientPrefixes: [], upload: false } as any;
  assert.equal(isQcSample('Background', qc), true, 'Background run kept out of HMIS');
  assert.equal(isQcSample('SF2609120011', qc), false);
  console.log('✓ profile: "Background" is a control, not a barcode');
}

console.log('hl7-bc5150: all checks passed');
