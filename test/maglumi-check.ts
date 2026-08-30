import { buildOrderMessage, parseMessage } from '../src/codec/astm/records.js';

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
