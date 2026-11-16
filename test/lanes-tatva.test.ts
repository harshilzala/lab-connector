import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, lanesFor, type AppConfig } from '../src/config.js';
import { resolveLanes, laneLabel, describeLanes, LANES } from '../src/hmis/lanes.js';

// =============================================================================
// Tatva as the third HMIS lane — config / lane logic only.
//
//   resolveLanes with use "tatva"; `both` pairs in canonical order; `both`
//   absent => ["hinai","genx"]; per-analyzer override naming only `both`;
//   validation: `both` needs exactly two different lanes, hmis.tatva.enabled
//   is rejected, tatva.baseUrl is required when a lane uses Tatva; a plain
//   single-HINAI config uses no GenX and no Tatva lane.
//
// Offline: only loadConfig / lanesFor / resolveLanes. Nothing is started and
// nothing dials; every URL below is a config string on 127.0.0.1.
//
// Run: npx tsx test/lanes-tatva.test.ts
// =============================================================================

const dir = mkdtempSync(join(tmpdir(), 'lanes-tatva-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY', 'AUTOCERTIFY_ORACLE_PASSWORD']) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith('TATVA_')) delete process.env[k];

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
};

let n = 0;
const load = (raw: Record<string, unknown>): AppConfig => {
  const p = join(dir, `c${++n}.json`);
  writeFileSync(p, JSON.stringify({ logLevel: 'error', spoolDir: join(dir, 'spool'), ...raw }));
  return loadConfig(p);
};
const rejects = (raw: Record<string, unknown>, re: RegExp) => assert.throws(() => load(raw), re);

const HINAI = { baseUrl: 'http://127.0.0.1:1/portal', siteIds: ['2'], resultsPath: '/mirth/labresult' };
const GENX = {
  baseUrl: 'http://127.0.0.1:2',
  clientId: 'cid',
  clientSecret: 'secret',
  accessionCacheFile: join(dir, 'genx-acc.json'),
  auditLog: join(dir, 'logs', 'hmis-genx.log'),
  equipmentServices: {},
};
const TATVA = {
  baseUrl: 'http://127.0.0.1:3',
  clientId: 'tid',
  clientSecret: 'tsecret',
  accessionCacheFile: join(dir, 'tatva-acc.json'),
  auditLog: join(dir, 'logs', 'hmis-tatva.log'),
};
let port = 21500;
const plain = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  equipmentCode: code,
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: ++port },
  ...extra,
});
const hmis = (extra: Record<string, unknown>) => ({ auditLog: join(dir, 'logs', 'hmis.log'), hinai: HINAI, genx: GENX, tatva: TATVA, ...extra });
const lanesOf = (cfg: AppConfig, id: string) => [...lanesFor(cfg.analyzers.find((a) => a.id === id)!, cfg)];

// ---- resolveLanes (pure) -----------------------------------------------------
check('resolveLanes: use "tatva" => single tatva; labels', () => {
  assert.deepEqual(resolveLanes(null, { mode: 'single', use: 'tatva' }), ['tatva']);
  assert.deepEqual(resolveLanes({ use: 'tatva' }, { mode: 'both' }), ['tatva'], 'override use wins over top-level both');
  assert.deepEqual([...LANES], ['hinai', 'genx', 'tatva']);
  assert.equal(laneLabel('tatva'), 'Tatva');
  assert.equal(describeLanes(['hinai', 'tatva']), 'HINAI + Tatva (both)');
});

check('resolveLanes: both pairs come out in canonical order whatever the config order', () => {
  assert.deepEqual(resolveLanes(null, { mode: 'both', both: ['tatva', 'hinai'] }), ['hinai', 'tatva']);
  assert.deepEqual(resolveLanes(null, { mode: 'both', both: ['tatva', 'genx'] }), ['genx', 'tatva']);
  assert.deepEqual(resolveLanes(null, { mode: 'both', both: ['genx', 'hinai'] }), ['hinai', 'genx']);
});

check('resolveLanes: both mode with no `both` => ["hinai","genx"] (backward compatible)', () => {
  assert.deepEqual(resolveLanes(null, { mode: 'both' }), ['hinai', 'genx']);
  assert.deepEqual(resolveLanes({ mode: 'both' }, { mode: 'single', use: 'tatva' }), ['hinai', 'genx']);
});

check('resolveLanes: an analyzer override naming only `both` means both mode on that pair', () => {
  assert.deepEqual(resolveLanes({ both: ['hinai', 'tatva'] }, { mode: 'single', use: 'genx' }), ['hinai', 'tatva']);
  assert.deepEqual(resolveLanes({ both: ['tatva', 'genx'] }, undefined), ['genx', 'tatva']);
});

// ---- loadConfig / lanesFor ---------------------------------------------------
check('config: use "tatva" => single tatva lane', () => {
  const cfg = load({ hmis: hmis({ mode: 'single', use: 'tatva' }), analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['tatva']);
});

check('config: top-level both pairs, and a per-analyzer override with only `both`', () => {
  const cfg = load({
    hmis: hmis({ mode: 'both', both: ['tatva', 'hinai'] }),
    analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2', { hmis: { both: ['tatva', 'genx'] } }), plain('a3', 'EQ3', { hmis: { use: 'hinai' } })],
  });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai', 'tatva']);
  assert.deepEqual(lanesOf(cfg, 'a2'), ['genx', 'tatva']);
  assert.deepEqual(lanesOf(cfg, 'a3'), ['hinai']);
});

check('config: both mode with no `both` => hinai + genx', () => {
  const cfg = load({ hmis: hmis({ mode: 'both' }), analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai', 'genx']);
});

check('config: `both` with one lane is rejected', () => {
  rejects({ hmis: hmis({ mode: 'both', both: ['hinai'] }), analyzers: [plain('a1', 'EQ1')] }, /exactly two|both/i);
  rejects({ hmis: hmis({ mode: 'single', use: 'hinai' }), analyzers: [plain('a1', 'EQ1', { hmis: { both: ['tatva'] } })] }, /exactly two|both/i);
});

check('config: `both` with duplicate lanes is rejected', () => {
  rejects({ hmis: hmis({ mode: 'both', both: ['hinai', 'hinai'] }), analyzers: [plain('a1', 'EQ1')] }, /different|exactly two|both/i);
  rejects({ hmis: hmis({ mode: 'both', both: ['tatva', 'tatva'] }), analyzers: [plain('a1', 'EQ1')] }, /different|exactly two|both/i);
});

check('config: hmis.tatva.enabled is rejected with a pointer to use/both', () => {
  rejects(
    { hmis: hmis({ mode: 'single', use: 'hinai', tatva: { ...TATVA, enabled: true } }), analyzers: [plain('a1', 'EQ1')] },
    /tatva\.enabled was removed/,
  );
  rejects(
    { hmis: hmis({ mode: 'single', use: 'hinai', tatva: { ...TATVA, enabled: false } }), analyzers: [plain('a1', 'EQ1')] },
    /tatva\.enabled was removed/,
  );
});

check('config: tatva.baseUrl is required when a lane uses Tatva (and not otherwise)', () => {
  const { baseUrl: _omit, ...noUrl } = TATVA;
  void _omit;
  rejects({ hmis: hmis({ mode: 'single', use: 'tatva', tatva: noUrl }), analyzers: [plain('a1', 'EQ1')] }, /baseUrl/);
  rejects({ hmis: hmis({ mode: 'both', both: ['hinai', 'tatva'], tatva: noUrl }), analyzers: [plain('a1', 'EQ1')] }, /baseUrl/);
  rejects({ hmis: hmis({ mode: 'single', use: 'hinai', tatva: noUrl }), analyzers: [plain('a1', 'EQ1', { hmis: { use: 'tatva' } })] }, /baseUrl/);
  const cfg = load({ hmis: hmis({ mode: 'single', use: 'hinai', tatva: noUrl }), analyzers: [plain('a1', 'EQ1')] });
  assert.equal(cfg.hmis.tatva.baseUrl, '', 'no preprod default: baseUrl is empty until configured');
  assert.equal(cfg.hmis.tatva.orders, 'hinai');
});

check('config: a single-HINAI config puts no analyzer on a genx or tatva lane', () => {
  const cfg = load({ hmis: { auditLog: null, ...HINAI }, analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2')] });
  const used = new Set(cfg.analyzers.flatMap((a) => lanesFor(a, cfg)));
  assert.deepEqual([...used], ['hinai'], 'the connector builds a gateway per lane in use: only HINAI here');
  assert.equal(cfg.hmis.tatva.baseUrl, '');
});

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\nlanes-tatva: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nlanes-tatva: all checks passed');
process.exit(0);
