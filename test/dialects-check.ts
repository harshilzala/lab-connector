import { buildOrderMessage, parseMessage, ASTM_DIALECT_NAMES } from '../src/codec/astm/records.js';

// Replays the real Snibe Maglumi wire logs (g:\doc) through the codec.
const G = '\x1b[32m✓\x1b[0m';
const B = '\x1b[31m✗\x1b[0m';
const eq = (label: string, got: unknown, want: unknown) =>
  console.log(`  ${JSON.stringify(got) === JSON.stringify(want) ? G : B} ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

console.log('\n[1] Maglumi host-query  (Q|1|^1234567||ALL||||||||O)');
const q = parseMessage(
  ['H|\\^&||PSWD|Maglumi 1000|||||Lis||P|E1394-97|20100323', 'Q|1|^1234567||ALL||||||||O', 'L|1|N'],
  'raw',
);
eq('sender', q.sender, 'Maglumi 1000');
eq('query sampleId', q.queries.map((x) => x.sampleId), ['1234567']);

console.log('\n[2] Maglumi result upload  (spec 16.4.3)');
const r = parseMessage(
  [
    'H|\\^&||PSWD|Maglumi 1000|||||Lis||P|E1394-97|20100326',
    'P|1',
    'O|1|1234567||^^^CYFRA211',
    'R|1|^^^CYFRA211|0||0 to 7|N||||||20100326172956',
    'L|1|N',
  ],
  'raw',
);
eq('results', r.results.map((x) => [x.sampleId, x.testCode, x.value, x.unit, x.referenceRange, x.abnormalFlag, x.completedAt]),
   [['1234567', 'CYFRA211', '0', null, '0 to 7', 'N', '20100326172956']]);

console.log('\n[3] Maglumi result upload  (real log, results.txt — value with unit + ">" flag)');
const r2 = parseMessage(
  ['H|\\^&||PSWD|Maglumi User|||||Lis||P|E1394-97|20150824', 'P|1', 'O|1|C60||^^^HBcAb IgG',
   'R|1|^^^HBcAb IgG|500|index/mL|0 to 100|>||||||20140825100415|', 'L|1|N'],
  'raw',
);
eq('results', r2.results.map((x) => [x.sampleId, x.testCode, x.value, x.unit, x.abnormalFlag, x.completedAt]),
   [['C60', 'HBcAb IgG', '500', 'index/mL', '>', '20140825100415']]);

console.log('\n[4] Maglumi multi-analyte upload (2-Maglumi to LIS log example.txt)');
const r3 = parseMessage(
  ['H|\\^&||PSWD|Maglumi User|||||Lis||P|E1394-97|20140613', 'P|1', 'O|1|146||^^^TSH\\^^^FT4\\^^^FT3',
   'R|1|^^^TSH|1.22|uIU/mL|0.4 to 4.5|N||||||20131228162937',
   'R|2|^^^FT4|11.06|pg/mL|7.2 to 17.2|N||||||20131228161701',
   'R|3|^^^FT3|1.743|pg/mL|1.21 to 4.18|N||||||20131228162319', 'L|1|N'],
  'raw',
);
eq('testCodes', r3.results.map((x) => x.testCode), ['TSH', 'FT4', 'FT3']);
eq('sampleIds', [...new Set(r3.results.map((x) => x.sampleId))], ['146']);

console.log('\n[5] ORDER DOWNLOAD — maglumi dialect vs the spec (§16.4.2, all 8 assays)');
const TESTS = ['CA125', 'CA153', 'CYFRA211', 'FT3', 'FT4', 'T3', 'TG', 'TGA'];
const mag = buildOrderMessage(
  [{ sampleId: '1234567', testCodes: TESTS, priority: 'R', patient: null, specimenType: 'Serum' }],
  { senderId: 'Maglumi 1000', receiverId: 'Lis', sendDemographics: false, dialect: 'maglumi' },
);
// The spec's H record ends in the message date; ours stamps the current time.
const specMag = [
  'H|\\^&||PSWD|Maglumi 1000|||||Lis||P|E1394-97|20100319',
  'P|1',
  ...TESTS.map((t, i) => `O|${i + 1}|1234567||^^^${t}|R`),
  'L|1|N',
];
const stamp = (l: string) => l.replace(/^H\|.*\|\d{8,14}$/, (m) => m.replace(/\|\d{8,14}$/, '|<ts>'));
eq('records', mag.map(stamp), specMag.map(stamp));
// The Snibe spec and all three captured logs stamp H field 14 with an 8-digit
// DATE — the atellica dialect keeps the full YYYYMMDDHHMMSS.
eq('H stamp is an 8-digit date', mag[0]!.split('|').pop()!.length, 8);
for (const l of mag) console.log('      ' + l);

console.log('\n[6] ORDER DOWNLOAD — atellica dialect must be byte-identical to before');
const atl = buildOrderMessage(
  [{ sampleId: 'LAB-2026-0000016', testCodes: ['GluH_3', 'NA'], priority: 'R', patient: null, specimenType: 'Serum' }],
  { senderId: 'HMIS-LIS', receiverId: 'ANALYZER', sendDemographics: false },
);
eq('records', atl.map(stamp), [
  'H|\\^&|||HMIS-LIS|||||ANALYZER||P|LIS2-A2|<ts>',
  'P|1|||||||',
  'O|1|LAB-2026-0000016||^^^GluH_3^^^1\\^^^NA^^^1|R|||||||O|||Serum',
  'L|1|N',
].map(stamp));
eq('H stamp keeps full datetime', atl[0]!.split('|').pop()!.length, 14);

console.log('\n[7] Maglumi order with demographics (sendDemographics=true)');
const magP = buildOrderMessage(
  [{ sampleId: '1234567', testCodes: ['TSH'], priority: 'S',
     patient: { patientId: 'UH100', lastName: 'Doe', firstName: 'Jane', middleName: null, sex: 'F', birthDate: '19880314' },
     specimenType: 'Serum' }],
  { senderId: 'Maglumi 1000', receiverId: 'Lis', sendDemographics: true, dialect: 'maglumi' },
);
for (const l of magP) console.log('      ' + l);
console.log('');


// =============================================================================
// [8]-[11]  VITROS ECi / ECiQ — golden tests replayed from the PRODUCTION wire
// log of the lab's existing integration (E:\API_Integration\Devices\ECiQ,
// Logs/2026-08-31/ASTM.log). These are bytes the analyzer has actually
// accepted, not a shape inferred from a datasheet — treat any diff here as a
// regression in the dialect, not a reason to edit the expectation.
// =============================================================================

console.log('\n[8] VITROS ECiQ ORDER DOWNLOAD — byte-identical to the production log');
const vit = buildOrderMessage(
  [{
    sampleId: 'SF2608310003',
    testCodes: ['075', '035', '032', '074'],
    priority: 'R',
    patient: { patientId: '10062026002906', lastName: 'JIGISHBHATT', firstName: null, middleName: null, sex: 'M', birthDate: null },
    specimenType: 'Serum',
  }],
  { senderId: 'HOST', receiverId: '', sendDemographics: true, dialect: 'vitros-eciq' },
);
eq('records', vit.map(stamp), [
  'H|\\^&|||HOST|||||||||<ts>',
  'P|1|10062026002906|||JIGISHBHATT^^|||M|||||||||||||||||||||||||||',
  'O|1|SF2608310003||^^^1.0+075+1\\035+1\\032+1\\074+1|R||||||N||||4||||||||||O||||||',
  'L|1|N',
].map(stamp));
eq('H carries no receiver, no processing id and no version', vit[0]!.split('|').slice(5, 13).join(''), '');
for (const l of vit) console.log('      ' + l);

console.log('\n[9] VITROS ECiQ RESULT UPLOAD — the assay code is the middle "+" group');
const vr = parseMessage(
  [
    'H|\\^&|||VITROS|||||||||20260831103026',
    'P|1',
    'O|1|240683^02^0||^^^1.000000+032+1\\038+1\\075+1\\074+1\\035+1|R||||||N||||4||||||||||F',
    'R|1|^^^1.000000+032+1|356|pg/mL||^0^||V|||20260831100701|20260831103018|',
    'R|2|^^^1.000000+038+1|28.2|U/mL||^0^||V|||20260831093141|20260831100838|',
    'R|3|^^^1.000000+075+1|3.15|ng/mL||^0^||V|||20260831093221|20260831095538|',
    'L|1|N',
  ],
  'raw',
  'vitros-eciq',
);
eq('sender', vr.sender, 'VITROS');
// The analyzer echoes a DIFFERENT manual dilution ("1.000000") than the "1.0"
// we send, so the decoder must not key off the value it wrote.
eq('results', vr.results.map((x) => [x.sampleId, x.testCode, x.value, x.unit, x.abnormalFlag, x.status, x.completedAt]), [
  ['240683', '032', '356', 'pg/mL', '^0^', 'V', '20260831103018'],
  ['240683', '038', '28.2', 'U/mL', '^0^', 'V', '20260831100838'],
  ['240683', '075', '3.15', 'ng/mL', '^0^', 'V', '20260831095538'],
]);

console.log('\n[10] A dialect must not leak into another dialect\'s decoding');
// The same "1.000000+032+1" under the atellica dialect stays whole — proof the
// VITROS unwrapping is dialect-scoped and not a global rule.
const cross = parseMessage(['H|\\^&|||X', 'O|1|S1||^^^x', 'R|1|^^^1.000000+032+1|5||||||||||', 'L|1|N'], 'raw', 'atellica');
eq('atellica keeps the whole component', cross.results.map((x) => x.testCode), ['1.000000+032+1']);

console.log('\n[12] Sysmex U-WAM result upload — the Ahmedabad capture of 2026-09-17 (ZC2609170035, trimmed)');
// logs/wire-sysmex-uwam-2026-09-17.log, second message: the strip (UC-3500)
// and particle (UF-4000) halves of one sample in one message, every value
// twice (RAW / MAINFORMAT), the judgement items, one of the seven image
// records. Lines dropped here are of the same shapes.
const UWAM_RECORDS = [
  'H|\\^&|||U-WAM^00-22_Build003^A1494^^^^AU501736||||||||LIS2-A2|20260917161725',
  'P|1||10032026040311||^ATULBHAI ASHOKBHAI J||19871203|M',
  "O|1|ZC2609170035||^^^C-URO\\^^^C-BLD\\^^^C-BIL\\^^^C-GLU\\^^^C-LEU\\^^^C-S.G.(Ref)\\^^^C-COLOR\\^^^C-Error Code\\^^^RBC\\^^^X'TAL\\^^^MUCUS\\^^^RBC-Info.\\^^^SF_DSS_PxSF_FSC_P\\|R||20260917110245||||N|||20260917110245|*||||||||||F",
  'R|1|^^^C-URO^A^1^S^  0009^01|normal^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|2|^^^C-URO^A^1^S^  0009^01|normal^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|3|^^^C-BLD^A^1^S^  0009^01|-^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|4|^^^C-BLD^A^1^S^  0009^01|-^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|5|^^^C-BIL^A^1^S^  0009^01|^RAW|mg/dL||N||||^^device||20260917105802|UC-3500',
  'R|6|^^^C-BIL^A^1^S^  0009^01|-^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|9|^^^C-GLU^A^1^S^  0009^01|4+^RAW|||H||||^^device||20260917105802|UC-3500',
  'R|10|^^^C-GLU^A^1^S^  0009^01|4+^MAINFORMAT|||H||||^^device||20260917105802|UC-3500',
  'R|17|^^^C-LEU^A^1^S^  0009^01|-^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|18|^^^C-LEU^A^1^S^  0009^01|^MAINFORMAT|c/µL||N||||^^device||20260917105802|UC-3500',
  // Grades identical in both halves, including the trace "+-" (C-BLD ×21,
  // C-GLU ×15, C-PRO ×17 on 2026-09-17/18).
  'R|7|^^^C-KET^A^1^S^  0009^01|1+^RAW|||H||||^^device||20260917105802|UC-3500',
  'R|8|^^^C-KET^A^1^S^  0009^01|1+^MAINFORMAT|||H||||^^device||20260917105802|UC-3500',
  'R|11|^^^C-PRO^A^1^S^  0009^01|+-^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|12|^^^C-PRO^A^1^S^  0009^01|+-^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|19|^^^C-S.G.(Ref)^A^1^S^  0009^01|1.010^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|20|^^^C-S.G.(Ref)^A^1^S^  0009^01|1.010^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|21|^^^C-COLOR^A^1^S^  0009^01|STRAW     02^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|22|^^^C-COLOR^A^1^S^  0009^01|STRAW     02^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|23|^^^C-ColorRANK^A^1^S^  0009^01|^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|24|^^^C-ColorRANK^A^1^S^  0009^01|^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|27|^^^C-Error Code^A^1^S^  0009^01|0000^RAW|||N||||^^device||20260917105802|UC-3500',
  'R|28|^^^C-Error Code^A^1^S^  0009^01|0000^MAINFORMAT|||N||||^^device||20260917105802|UC-3500',
  'R|29|^^^RBC^A^1^S^  0009^01|8.0^RAW|/µl||N||||^^device||20260917110354|UF-4000',
  'R|30|^^^RBC^A^1^S^  0009^01|1.4^MAINFORMAT|/HPF||N||||^^device||20260917110354|UF-4000',
  "R|49|^^^X'TAL^A^1^S^  0009^01|0.0^RAW|/µl||N||||^^device||20260917110354|UF-4000",
  "R|50|^^^X'TAL^A^1^S^  0009^01|0.0^MAINFORMAT|/LPF||N||||^^device||20260917110354|UF-4000",
  'R|55|^^^MUCUS^A^1^S^  0009^01|0.14^RAW|/µl||N||||^^device||20260917110354|UF-4000',
  'R|56|^^^MUCUS^A^1^S^  0009^01|0.02^MAINFORMAT|/HPF||N||||^^device||20260917110354|UF-4000',
  'R|59|^^^RBC-Info.^A^1^S^  0009^01|0^RAW|||||||^^device||20260917110354|UF-4000',
  'R|60|^^^RBC-Info.^A^1^S^  0009^01|0^MAINFORMAT|||||||^^device||20260917110354|UF-4000',
  'R|65|^^^SF_DSS_PxSF_FSC_P^A^1^IF^  0009^01|20260917&R&PNG&E&R&E&[UF-4000&S&11308]&E&[20260917_110354]&E&R&E&[          ZC2609170035]_[SF_DSS_PxSF_FSC_P].png^RAW|||||||^^device||20260917110354|UF-4000',
  'L|1|N',
];
const uwam = parseMessage(UWAM_RECORDS, 'raw', 'sysmex');
eq('sender', uwam.sender, 'U-WAM');
eq('patient from the P record', [uwam.patient?.patientId, uwam.patient?.sex, uwam.patient?.birthDate], ['10032026040311', 'M', '19871203']);
eq('no query in a result upload', uwam.queries.length, 0);
eq(
  'one value per parameter, MAINFORMAT preferred, RAW when MAINFORMAT is blank, images dropped',
  uwam.results.map((x) => [x.sampleId, x.testCode, x.value, x.unit, x.abnormalFlag, x.instrument]),
  [
    ['ZC2609170035', 'C-URO', 'normal', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-BLD', '-', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-BIL', '-', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-GLU', '4+', null, 'H', 'UC-3500'],
    ['ZC2609170035', 'C-LEU', '-', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-KET', '1+', null, 'H', 'UC-3500'],
    ['ZC2609170035', 'C-PRO', '+-', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-S.G.(Ref)', '1.010', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-COLOR', 'STRAW     02', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'C-Error Code', '0000', null, 'N', 'UC-3500'],
    ['ZC2609170035', 'RBC', '1.4', '/HPF', 'N', 'UF-4000'],
    ['ZC2609170035', "X'TAL", '0.0', '/LPF', 'N', 'UF-4000'],
    ['ZC2609170035', 'MUCUS', '0.02', '/HPF', 'N', 'UF-4000'],
    ['ZC2609170035', 'RBC-Info.', '0', null, null, 'UF-4000'],
  ],
);
eq('a parameter blank in both formats (C-ColorRANK) is not a result', uwam.results.some((x) => x.testCode === 'C-ColorRANK'), false);
eq('the image record is not a result', uwam.results.some((x) => /png/i.test(x.value) || x.testCode === 'A'), false);

console.log('\n[12b] A strip GRADE wins over a concentration whichever half carries it (C-LEU ↔ C-BIL, 2026-09-18)');
// Measured 2026-09-17/18: C-LEU RAW is the grade and MAINFORMAT is blank or
// 25/75/500 c/µL; C-BIL is the mirror image. A pad must file on one scale.
const MIRROR_RECORDS = [
  'H|\\^&|||U-WAM^00-22_Build003^A1494^^^^AU501736||||||||LIS2-A2|20260918003810',
  'P|1',
  'O|1|LB2609180027||^^^C-BIL\\^^^C-LEU\\^^^C-BLD\\^^^RBC|R||20260918003709|||||||||||||||||F',
  'R|5|^^^C-BIL^A^1^S^  0031^01|0.5^RAW|mg/dL||H||||^^device||20260918003700|UC-3500',
  'R|6|^^^C-BIL^A^1^S^  0031^01|1+^MAINFORMAT|||H||||^^device||20260918003700|UC-3500',
  'R|17|^^^C-LEU^A^1^S^  0031^01|2+^RAW|||H||||^^device||20260918003700|UC-3500',
  'R|18|^^^C-LEU^A^1^S^  0031^01|75^MAINFORMAT|c/µL||H||||^^device||20260918003700|UC-3500',
  'R|3|^^^C-BLD^A^1^S^  0031^01|10^RAW|c/µL||N||||^^device||20260918003700|UC-3500',
  'R|4|^^^C-BLD^A^1^S^  0031^01|10^MAINFORMAT|c/µL||N||||^^device||20260918003700|UC-3500',
  'R|29|^^^RBC^A^1^S^  0031^01|8.0^RAW|/µl||N||||^^device||20260918003700|UF-4000',
  'R|30|^^^RBC^A^1^S^  0031^01|1.4^MAINFORMAT|/HPF||N||||^^device||20260918003700|UF-4000',
  'L|1|N',
];
const mirror = parseMessage(MIRROR_RECORDS, 'raw', 'sysmex');
eq('grade from either half; numeric-in-both keeps the preferred (MAINFORMAT)',
  mirror.results.map((x) => [x.testCode, x.value, x.unit]),
  [['C-BIL', '1+', null], ['C-LEU', '2+', null], ['C-BLD', '10', 'c/µL'], ['RBC', '1.4', '/HPF']]);
const mirrorRaw = parseMessage(MIRROR_RECORDS, 'raw', 'sysmex', { valueFormat: 'raw' });
eq('valueFormat "raw" changes only the numeric-in-both pairs',
  mirrorRaw.results.map((x) => [x.testCode, x.value, x.unit]),
  [['C-BIL', '1+', null], ['C-LEU', '2+', null], ['C-BLD', '10', 'c/µL'], ['RBC', '8.0', '/µl']]);

console.log('\n[13] Sysmex U-WAM — valueFormat "raw" files the native value, MAINFORMAT when RAW is blank');
const uwamRaw = parseMessage(UWAM_RECORDS, 'raw', 'sysmex', { valueFormat: 'raw' });
eq(
  'raw values',
  uwamRaw.results.filter((x) => ['C-BIL', 'C-LEU', 'RBC', 'MUCUS'].includes(x.testCode)).map((x) => [x.testCode, x.value, x.unit]),
  [['C-BIL', '-', null], ['C-LEU', '-', null], ['RBC', '8.0', '/µl'], ['MUCUS', '0.14', '/µl']],
);

console.log('\n[14] An analyzer that sends one plain value is untouched by the pair handling');
const magX6 = parseMessage(
  ['H|\\^&||PSWD|X6 User|||||Lis||P|E1394-97|20260917', 'P|1', 'O|1|LB2609170565||^^^HIV Combi',
   'R|1|^^^HIV Combi|<0.01|AU/mL|0.000 - 1.000|N||||||20260917155439||', 'L|1|N'],
  'raw',
  'maglumi',
);
eq('maglumi X6 value', magX6.results.map((x) => [x.sampleId, x.testCode, x.value, x.unit]), [['LB2609170565', 'HIV Combi', '<0.01', 'AU/mL']]);

console.log('\n[15] Sysmex query REPLY echoes the specimen field, bare ^^^CODE test ids, report type Q');
// The Q record is NOT yet captured from the U-WAM; this is the ASTM norm the
// connector answers with until it is.
const SYSMEX_SPECIMEN = 'ZC2609170035^A1^3';
const sq = parseMessage(
  ['H|\\^&|||U-WAM^00-22_Build003^A1494^^^^AU501736||||||||LIS2-A2|20260917101500', 'Q|1|' + SYSMEX_SPECIMEN + '||ALL|||||||O', 'L|1|N'],
  'raw',
  'sysmex',
);
eq('query sampleId', sq.queries.map((x) => x.sampleId), ['ZC2609170035']);
eq('query keeps the specimen field verbatim', sq.queries.map((x) => x.specimenIdField), [SYSMEX_SPECIMEN]);
const sysReply = buildOrderMessage(
  [{ sampleId: 'ZC2609170035', testCodes: ['WBC Clumps', 'SPERM'], priority: 'R', patient: null, specimenType: null,
     queryReply: true, specimenIdField: SYSMEX_SPECIMEN }],
  { senderId: 'HMIS-LIS', receiverId: '', sendDemographics: false, dialect: 'sysmex' },
);
eq('records', sysReply.map(stamp), [
  'H|\\^&|||HMIS-LIS||||||||LIS2-A2|<ts>',
  'P|1',
  'O|1|' + SYSMEX_SPECIMEN + '||^^^WBC Clumps\\^^^SPERM|R||||||||||||||||||||Q',
  'L|1|N',
]);
for (const l of sysReply) console.log('      ' + l);

console.log('\n[16] Sysmex unsolicited download uses the bare barcode and report type O');
const sysPush = buildOrderMessage(
  [{ sampleId: 'ZC2609170035', testCodes: ['WBC Clumps', 'SPERM'], priority: 'S', patient: null, specimenType: null }],
  { senderId: 'HMIS-LIS', receiverId: '', sendDemographics: false, dialect: 'sysmex' },
);
eq('O record', sysPush[2], 'O|1|ZC2609170035||^^^WBC Clumps\\^^^SPERM|S||||||||||||||||||||O');


console.log('\n[17] The reply flags change nothing for the other dialects');
const magReply = buildOrderMessage(
  [{ sampleId: '1234567', testCodes: ['TSH'], priority: 'R', patient: null, specimenType: 'Serum',
     queryReply: true, specimenIdField: '^1234567' }],
  { senderId: 'Maglumi 1000', receiverId: 'Lis', sendDemographics: false, dialect: 'maglumi' },
);
eq('maglumi O record unchanged', magReply[2], 'O|1|1234567||^^^TSH|R');

console.log('\n[11] Every dialect in the library builds a well-formed message');
for (const name of ASTM_DIALECT_NAMES) {
  const out = buildOrderMessage(
    [{ sampleId: 'S1', testCodes: ['A', 'B'], priority: 'R', patient: null, specimenType: 'Serum' }],
    { senderId: 'HOST', receiverId: 'ANALYZER', sendDemographics: false, dialect: name },
  );
  const ok = out[0]!.startsWith('H|') && out[out.length - 1] === 'L|1|N' && out.some((l) => l.startsWith('O|'));
  eq(`${name}: H … O … L`, ok, true);
}
console.log('');
