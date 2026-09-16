import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParameterCatalogue } from '../src/orders/parameters.js';
import { logger } from '../src/logger.js';
import type { MirthAcknowledgeItem } from '../src/types.js';

// The parameter catalogue against an HMIS master in flux.
//
// After the lab's 2026-09-12 rename, ZHPN001's CBC service offers "WBC" on
// two parameters — the count (2123) and the smear-review row (2166) — and
// "PCT" on the smear PLATELET row (2162). The catalogue used to take "the
// newest reply is authoritative" literally: every poll re-keyed WBC between
// 2123 and 2166 (thousands of warnings on 2026-09-16) and would have rebuilt
// a PCT row pointing at the smear line. This pins the rules:
//   • rows in excludeParameterIds are never learned and never rebuilt;
//   • an identifier offered on two parameters in ONE reply is ambiguous: it
//     is dropped from the catalogue, not guessed, and warned about once;
//   • a genuine re-key (one id in one reply, another in the next) is still
//     followed, and warned about once.
//   Run:  npx tsx test/catalogue-ambiguity.test.ts

const row = (identifier: string, parameterId: number, sampleID = 'S1'): MirthAcknowledgeItem => ({
  sampleID,
  equipmentId: 224302864,
  identifier,
  ipAddress: '10.20.4.50',
  isTransmitted: true,
  labResultId: 93000001,
  labServiceId: 3141,
  portNo: '5100',
  parameterId,
  resultType: 'PARAMETER',
});

const warnings: string[] = [];
const spy = { ...logger, warn: (_ctx: unknown, msg?: string) => warnings.push(String(msg ?? _ctx)), child: () => spy } as unknown as typeof logger;

const dir = mkdtempSync(join(tmpdir(), 'lab-connector-catalogue-'));

// The reply as HMIS sends it now: smear rows first, so "first wins" would be wrong.
const REPLY = [row('WBC', 2166), row('RBC', 2152), row('PCT', 2162), row('WBC', 2123), row('RBC', 2124), row('HGB', 2130), row('MCV', 2127), row('MCH', 2129), row('MCHC', 2128), row('HCT', 2131)];

// ---- 1) with the block's exclusions: unambiguous, nothing points at a smear row
{
  const cat = new ParameterCatalogue(join(dir, 'a', 'parameters.json'), spy);
  warnings.length = 0;
  for (let poll = 0; poll < 5; poll++) cat.learn(REPLY, { excludeParameterIds: [2166, 2152, 2162] });
  const c = JSON.parse(readFileSync(join(dir, 'a', 'parameters.json'), 'utf8'));
  const p = c.services['3141'].parameters;
  assert.equal(p.WBC.parameterId, 2123, 'WBC → the count row, not the smear row');
  assert.equal(p.RBC.parameterId, 2124);
  assert.equal(p.PCT, undefined, 'PCT is not catalogued: its only row is the excluded smear line');
  assert.equal(warnings.length, 0, 'five polls, no warnings');
  console.log('✓ with excludeParameterIds: WBC=2123, RBC=2124, PCT not learned, no warning spam');

  // and synthesize never offers an excluded row even if one had been stored
  c.services['3141'].parameters.PCT = { parameterId: 2162, identifier: 'PCT' };
  writeFileSync(join(dir, 'a', 'parameters.json'), JSON.stringify(c));
  const known = [row('HGB', 2130), row('MCV', 2127), row('MCH', 2129), row('MCHC', 2128), row('HCT', 2131)];
  const syn = cat.synthesize(known, ['PCT', 'WBC'], (id) => id, { excludeParameterIds: [2166, 2152, 2162] });
  assert.deepEqual(syn.unknown, ['PCT'], 'a PCT row pointing at 2162 is never rebuilt');
  assert.equal(syn.rows.find((r) => r.identifier === 'WBC')?.parameterId, 2123, 'WBC is rebuilt on the count row');
  console.log('✓ synthesize: excluded parameter never rebuilt');
}

// ---- 2) without exclusions: ambiguity is refused, not guessed, warned once ---
{
  const cat = new ParameterCatalogue(join(dir, 'b', 'parameters.json'), spy);
  warnings.length = 0;
  for (let poll = 0; poll < 5; poll++) cat.learn(REPLY);
  const c = JSON.parse(readFileSync(join(dir, 'b', 'parameters.json'), 'utf8'));
  const p = c.services['3141'].parameters;
  assert.equal(p.WBC, undefined, 'WBC on two parameters in one reply → not catalogued');
  assert.equal(p.RBC, undefined);
  assert.equal(p.HGB.parameterId, 2130, 'unambiguous rows still learned');
  const amb = warnings.filter((w) => /more than one parameter/.test(w));
  assert.equal(amb.length, 2, 'one warning per ambiguous identifier (WBC, RBC), not one per poll');
  const known = [row('HGB', 2130), row('MCV', 2127), row('MCH', 2129), row('MCHC', 2128), row('HCT', 2131)];
  const syn = cat.synthesize(known, ['WBC']);
  assert.deepEqual(syn.unknown, ['WBC'], 'an ambiguous parameter is never rebuilt');
  console.log('✓ without exclusions: ambiguous identifiers dropped, warned once, never rebuilt');
}

// ---- 3) a genuine re-key across replies is followed, warned once -----------
{
  const cat = new ParameterCatalogue(join(dir, 'c', 'parameters.json'), spy);
  warnings.length = 0;
  cat.learn([row('PDW', 7002)]);
  for (let poll = 0; poll < 3; poll++) cat.learn([row('PDW', 7099)]);
  const c = JSON.parse(readFileSync(join(dir, 'c', 'parameters.json'), 'utf8'));
  assert.equal(c.services['3141'].parameters.PDW.parameterId, 7099, 'newest reply wins for a real re-key');
  assert.equal(warnings.filter((w) => /re-keyed/.test(w)).length, 1, 'warned once, not per poll');
  console.log('✓ genuine re-key followed, one warning');
}

console.log('catalogue-ambiguity: all checks passed');
