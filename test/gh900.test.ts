import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { GH900_CODES, HEADER_LENGTH, parseGh900Sample } from '../src/codec/gh900/parser.js';
import { Gh900Link } from '../src/codec/gh900/link.js';
import { PROFILE_LIBRARY } from '../src/profiles/index.js';
import type { ParsedMessage } from '../src/types.js';
import { logger } from '../src/logger.js';

// Self-test for the Lifotronic GH900 Plus codec.
//
// Pins (a) the layout as CONFIRMED on the wire at Shela, 2026-09-12 — the real
// block is replayed below — (b) the synthetic fixture built field-by-field
// from the operator's manual, Appendix B.3, with the two corrections the wire
// made (sample id sized by "Code length", ratios ##.#), and (c) that a block
// whose length disagrees with that layout is REFUSED rather than sliced at
// the wrong offsets.
//   Run:  npx tsx test/gh900.test.ts

const STX = '\x02';
const ETX = '\x03';

/** Right-align into `w` characters, zero-padded like a fixed-width numeric field. */
const num = (v: string, w: number) => v.padStart(w, '0');



interface Fixture {
  sampleId: string;
  bloodType: string;
  errorCode: string;
  curve: number;
  hba1c?: string;
}

function block(f: Fixture): string {
  const ratios = { HbA1a: '01.2', HbA1b: '00.8', HbF: '00.6', LA1c: '01.1', HbA1c: f.hba1c ?? '06.4', HbA0: '89.9' };
  const fr = ['HbA1a', 'HbA1b', 'HbF', 'LA1c', 'HbA1c', 'HbA0'] as const;
  let s = 'S';
  s += num('7', 2); // version — "07" on the wire
  s += '--'; // number of parameters — "--" on the wire
  s += '--'; // parameter description format — "--" on the wire
  s += num(String(f.sampleId.length), 2); // code length = width of the sample id that follows
  s += f.sampleId;
  s += num('350', 4); // temperature ×10 — 35.0 °C on the wire
  s += num('3', 2); // rack position
  s += num('42', 4); // series no
  s += f.bloodType;
  s += '26' + '09' + '12' + '13' + '05' + '30'; // yy mm dd hh mm ss
  for (const _ of fr) s += num('12', 2); // appearance times
  for (const _ of fr) s += '0.1234'; // absorbances  #.####
  for (const _ of fr) s += '12.345'; // peak areas   ##.###
  for (const x of fr) s += ratios[x]; // ratios       ##.#  (wire; the manual shows ##.##)
  s += '046.4'; // HbA1c IFCC  ###.#
  s += '07.8'; // eAG mmol/L  ##.#
  s += '140.5'; // eAG mg/dL   ###.#
  s += num(String(f.curve), 3); // curve count
  for (let i = 0; i < f.curve; i++) s += '0.0100'; // curve values #.####
  s += f.errorCode;
  return s;
}

// ---- 0) the layout adds up the way the manual reads --------------------------
assert.equal(HEADER_LENGTH, 156, 'header width excluding the S specifier and the variable-width sample id');

// ---- 0b) the first live block, Shela 2026-09-12, verbatim from the wire log ---
// Firmware version "07", sample id "WBR5" (code length 04), 35.0 °C, rack 01,
// series 0007, venous, clock 2026-09-11 20:53:33, 200 curve points, no error.
{
  const live =
    'S07----04WBR5035001000702609112053331318263552880.00130.00300.00140.00230.00570.2414' +
    '00.01600.08800.04200.09400.72313.26200.100.600.300.705.193.2032.005.5099.1200' +
    '0.0000'.repeat(10) +
    '0.0001'.repeat(5) +
    '0.00030.00060.00080.00100.00120.00120.00110.00120.00130.00150.00140.00150.00230.00290.00280.00230.00180.00140.00110.0009' +
    '0.00100.00110.00110.00120.00120.00130.00130.00120.00120.00130.00130.00130.00110.00120.00140.00170.00200.00220.00230.0023' +
    '0.00230.00220.00210.00210.00220.00210.00200.00180.00170.00160.00160.00160.00160.00150.00160.00160.00160.00170.00200.0024' +
    '0.00290.00350.00430.00490.00540.00560.00570.00560.00530.00500.00470.00440.00400.00360.00330.00300.00270.00260.00250.0023' +
    '0.00220.00200.00180.00190.00190.00190.00180.00170.00160.00170.00190.00200.00230.00260.00310.00410.00570.00650.00640.0064' +
    '0.00810.01080.01220.01120.00970.00920.00950.01110.01340.01450.01510.01580.01740.01980.02640.04480.08880.13170.17350.2050' +
    '0.23650.23570.17620.10940.06020.04280.03220.02400.01820.01610.01480.01370.01230.01120.00990.00880.00820.00750.00590.0046' +
    '0.00360.00310.00270.00240.00230.00220.00210.00200.00180.00180.00170.00180.00180.00170.00150.00140.00130.00120.00110.0010' +
    '0.00100.00100.00100.00100.00100.00090.00100.00100.00100.00100.00100.00100.00100.00100.00110.00110.00100.00100.00110.0010' +
    '0.00110.00110.00110.00110.0011' +
    '0';
  assert.equal(live.length, 1362, 'the capture is 1362 characters between STX and ETX');
  const s = parseGh900Sample(live);
  assert.equal(s.sampleId, 'WBR5');
  assert.equal(s.fields.version, '07');
  assert.equal(s.fields.parameterCount, '--');
  assert.equal(s.fields.codeLength, '04');
  assert.equal(s.fields.temperatureX10, '0350');
  assert.equal(s.fields.rackPosition, '01');
  assert.equal(s.fields.seriesNo, '0007');
  assert.equal(s.bloodType, 'venous');
  assert.equal(s.testedAt, '20260911205333');
  assert.equal(s.fields['HbA1c.appearanceTime'], '52');
  assert.equal(s.fields['HbA0.peakArea'], '13.262');
  assert.equal(s.curveCount, 200);
  assert.equal(s.errorCode, '0');
  const by = new Map(s.results.map((r) => [r.testCode, r.value]));
  assert.equal(by.get(GH900_CODES.HBA1C), '5.1');
  assert.equal(by.get(GH900_CODES.HBA1C_IFCC), '32.0');
  assert.equal(by.get(GH900_CODES.EAG_MMOL), '5.5');
  assert.equal(by.get(GH900_CODES.EAG_MGDL), '99.1');
  assert.equal(by.get(GH900_CODES.HBF), '0.3');
  assert.equal(by.get(GH900_CODES.HBA1A), '0.1');
  assert.equal(by.get(GH900_CODES.HBA1B), '0.6');
  assert.equal(by.get(GH900_CODES.LA1C), '0.7');
  assert.equal(by.get(GH900_CODES.HBA0), '93.2');
  // The six ratios are percentages of one chromatogram: they must sum to 100.
  const sum = ['HbA1a', 'HbA1b', 'HbF', 'LA1c', 'HbA1c', 'HbA0'].reduce((n, f) => n + Number(s.fields[`${f}.ratio`]), 0);
  assert.equal(sum.toFixed(1), '100.0', 'ratio boundaries are right: the six fractions sum to 100.0 %');
  console.log('✓ live Shela block: WBR5 HbA1c 5.1 % / 32.0 mmol/mol, eAG 99.1 mg/dL, 200 curve points');
}

// ---- 1) a venous sample parses into the connector's codes ------------------
{
  const b = block({ sampleId: 'SF2609120042', bloodType: '0', errorCode: '0', curve: 3 });
  const s = parseGh900Sample(b);
  assert.equal(s.sampleId, 'SF2609120042', 'sample id read at the width the code-length field states');
  assert.equal(s.bloodType, 'venous');
  assert.equal(s.testedAt, '20260912130530');
  assert.equal(s.errorCode, '0');
  assert.equal(s.error, '');
  assert.equal(s.curveCount, 3);
  const by = new Map(s.results.map((r) => [r.testCode, r]));
  assert.equal(by.get(GH900_CODES.HBA1C)!.value, '6.4', 'HbA1c % from the HbA1c peak-area ratio, leading zero stripped');
  assert.equal(by.get(GH900_CODES.HBA1C)!.unit, '%');
  assert.equal(by.get(GH900_CODES.HBA1C_IFCC)!.value, '46.4');
  assert.equal(by.get(GH900_CODES.HBA1C_IFCC)!.unit, 'mmol/mol');
  assert.equal(by.get(GH900_CODES.EAG_MGDL)!.value, '140.5');
  assert.equal(by.get(GH900_CODES.EAG_MMOL)!.value, '7.8');
  assert.equal(by.get(GH900_CODES.HBF)!.value, '0.6');
  assert.equal(by.get(GH900_CODES.HBA0)!.value, '89.9');
  assert.equal(s.results.length, 9);
  for (const r of s.results) {
    assert.equal(r.sampleId, 'SF2609120042');
    assert.equal(r.completedAt, '20260912130530');
    assert.equal(r.status, 'F');
  }
  console.log(`✓ sample block: HbA1c ${by.get('HBA1C')!.value}% / ${by.get('HBA1C-IFCC')!.value} mmol/mol, eAG ${by.get('EAG-MGDL')!.value} mg/dL`);
}

// ---- 2) a block whose length disagrees with the layout is refused ----------
{
  const b = block({ sampleId: 'X1', bloodType: '0', errorCode: '0', curve: 2 });
  assert.throws(() => parseGh900Sample(b + '0'), /layout says/, 'one byte too long → refused, not mis-sliced');
  assert.throws(() => parseGh900Sample(b.slice(0, -1)), /layout says/, 'one byte too short → refused');
  assert.throws(() => parseGh900Sample('Q' + b.slice(1)), /not a sample block/);
  assert.throws(() => parseGh900Sample('S12'), /too short/);
  console.log('✓ length check: a block that does not add up is refused with the expected/actual widths');
}

// ---- 3) link: framing, QC/calibrator flag, sampling-error drop ---------------
class FakeTransport extends EventEmitter {
  readonly kind = 'tcp' as const;
  readonly describe = 'fake://gh900';
  connected = true;
  writes: Buffer[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async write(d: Buffer): Promise<void> {
    this.writes.push(d);
  }
  feed(s: string): void {
    this.emit('data', Buffer.from(s, 'latin1'));
  }
}

const transport = new FakeTransport();
const link = new Gh900Link(transport as never, { logger });
const messages: ParsedMessage[] = [];
link.on('message', (m: ParsedMessage) => messages.push(m));
link.on('error', (e: Error) => {
  throw e;
});
await link.start();

const patient = STX + block({ sampleId: 'SF2609120042', bloodType: '0', errorCode: '0', curve: 5 }) + ETX;
const control = STX + block({ sampleId: 'LOT7781', bloodType: '2', errorCode: '0', curve: 0 }) + ETX;
const calibrator = STX + block({ sampleId: 'CAL1', bloodType: '3', errorCode: '0', curve: 0 }) + ETX;
const misSampled = STX + block({ sampleId: 'SF2609120043', bloodType: '0', errorCode: '1', curve: 0 }) + ETX;
const qcBlock = STX + 'Q' + 'undocumented qc block' + ETX;

// Stray CR/LF between frames, a frame split mid-way, two frames in one chunk.
transport.feed('\r\n');
transport.feed(patient.slice(0, 50));
transport.feed(patient.slice(50) + '\r\n' + control);
transport.feed(qcBlock + calibrator + misSampled);
await new Promise((r) => setTimeout(r, 10));
await link.stop();

assert.equal(transport.writes.length, 0, 'receive-only: nothing is ever sent to the analyzer');
assert.equal(messages.length, 3, 'patient + control + calibrator delivered; Q block and E1 run dropped');
assert.equal(messages[0]!.protocol, 'gh900');
assert.equal(messages[0]!.isQc, false);
assert.equal(messages[0]!.results[0]!.sampleId, 'SF2609120042');
assert.equal(messages[1]!.isQc, true, 'blood type 0x32 QC material → isQc');
assert.equal(messages[1]!.results[0]!.sampleId, 'LOT7781');
assert.equal(messages[2]!.isQc, true, 'blood type 0x33 calibrator → isQc');
assert.ok(!messages.some((m) => m.results[0]!.sampleId === 'SF2609120043'), 'E1 sampling error not filed');
console.log('✓ link: STX/ETX framing across chunks, QC/calibrator flagged, sampling error dropped, Q block ignored');

// fileOnSamplingError lets a site file E1/E2 runs anyway.
{
  const t2 = new FakeTransport();
  const l2 = new Gh900Link(t2 as never, { logger, fileOnSamplingError: true });
  const got: ParsedMessage[] = [];
  l2.on('message', (m: ParsedMessage) => got.push(m));
  await l2.start();
  t2.feed(misSampled);
  await l2.stop();
  assert.equal(got.length, 1, 'fileOnSamplingError: E1 run is filed');
  console.log('✓ fileOnSamplingError honoured');
}

// ---- 4) the profile matches the manual's B.1 --------------------------------
{
  const p = PROFILE_LIBRARY['lifotronic-gh900plus'].defaults as Record<string, any>;
  assert.equal(p.protocol, 'gh900');
  assert.equal(p.transport.mode, 'server', 'B.1: TCP Communication Mode on PC = TCP Server');
  assert.equal(p.transport.port, 8000, 'B.1: default port 8000');
  assert.equal(p.hostQuery, false);
  assert.equal(p.orderPoll.download, false);
  assert.deepEqual(p.allowTestCodes, ['HBA1C', 'HBA1C-IFCC', 'EAG-MGDL', 'EAG-MMOL', 'HBF']);
  for (const code of p.allowTestCodes) {
    assert.ok(Object.values(GH900_CODES).includes(code), `${code} is a code the parser emits`);
  }
  console.log('✓ profile lifotronic-gh900plus agrees with the codec and the manual');
}

console.log('gh900: all checks passed');
