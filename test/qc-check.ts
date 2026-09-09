import { isQcSample } from '../src/mapping/mapper.js';

const v250 = { patientPrefixes: ['ZC'], sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'], sampleIdRegex: null, upload: false };
const others = { patientPrefixes: [], sampleIdPrefixes: ['QC', 'QC-', 'CTRL', 'CONTROL', '$'], sampleIdRegex: null, upload: false };

const cases: Array<[string, typeof v250, boolean]> = [
  ['89772', v250, true],
  ['ZC2608030162', v250, false],
  ['zc2608030162', v250, false],
  ['QC1', v250, true],
  ['', v250, false],
  ['89772', others, false],
  ['ZC2608030162', others, false],
  ['QC1', others, true],
];

let bad = 0;
for (const [id, cfg, want] of cases) {
  const got = isQcSample(id, cfg as never);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  isQc(${JSON.stringify(id)}, ${cfg === v250 ? 'v250' : 'other'}) = ${got}  (want ${want})`);
}
console.log(bad === 0 ? '\nall passed' : `\n${bad} FAILED`);
