import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as configModule from '../src/config.js';
import { loadConfig, type AppConfig } from '../src/config.js';

// =============================================================================
// HMIS lanes — the config half (spec section 1, scenario 1).
//
//   hmis.mode "single" | "both", hmis.use "hinai" | "genx", legacy hmis.api,
//   the per-analyzer `hmis` override, the top-level `im` block and its
//   translation into an ordinary analyzer, im.autoCertify.{hinai,genx}, the
//   base-URL rules per lane in use, the GenX order-push guard per analyzer,
//   and the duplicate equipment code rule with an `im` block.
//
// Only loadConfig and lanesFor are used: nothing is started, nothing dials.
//
// Run: npx tsx test/lanes-config.test.ts
// =============================================================================

const dir = mkdtempSync(join(tmpdir(), 'lanes-config-'));
// Never let the repo's .env (a real HMIS URL, GenX credentials) leak into the
// configs under test.
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY', 'AUTOCERTIFY_ORACLE_PASSWORD']) delete process.env[k];

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

// ---- lanesFor: from src/config.ts, else src/hmis/lanes.ts (spec 1a) ----------
type Lane = 'hinai' | 'genx';
type LanesFor = (analyzer: unknown, cfg: AppConfig) => readonly Lane[];
let lanesFor: LanesFor | undefined = (configModule as Record<string, unknown>).lanesFor as LanesFor | undefined;
if (typeof lanesFor !== 'function') {
  const lanesPath = '../src/hmis/lanes.js';
  try {
    lanesFor = ((await import(lanesPath)) as { lanesFor?: LanesFor }).lanesFor;
  } catch {
    /* reported below */
  }
}
if (typeof lanesFor !== 'function') {
  console.error('✗ lanesFor(analyzer, cfg) is exported from neither src/config.ts nor src/hmis/lanes.ts');
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
const lanesOf = (cfg: AppConfig, id: string): Lane[] => {
  const a = cfg.analyzers.find((x) => x.id === id);
  assert.ok(a, `analyzer "${id}" is in the parsed config`);
  return [...lanesFor!(a, cfg)];
};
const sorted = (l: readonly string[]) => [...l].sort();

// ---- building blocks ---------------------------------------------------------
let n = 0;
const load = (raw: Record<string, unknown>): AppConfig => {
  const p = join(dir, `c${++n}.json`);
  writeFileSync(p, JSON.stringify({ logLevel: 'error', spoolDir: join(dir, 'spool'), ...raw }));
  return loadConfig(p);
};
const HINAI = { baseUrl: 'http://127.0.0.1:1/portal', siteIds: ['2'], resultsPath: '/mirth/labresult' };
const GENX = {
  baseUrl: 'http://127.0.0.1:2',
  clientId: 'cid',
  clientSecret: 'secret',
  accessionCacheFile: join(dir, 'genx-acc.json'),
  auditLog: join(dir, 'logs', 'hmis-genx.log'),
  equipmentServices: { EQ0022: ['THY', 'VITB12'] },
};
let port = 21400;
const plain = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  equipmentCode: code,
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: ++port },
  ...extra,
});
/** A directly declared IM analyzer (profile "im"), which pushes orders. */
const imAnalyzer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  profile: 'im',
  equipmentCode: 'EQ0022',
  equipmentId: 46150218,
  transport: { host: '192.0.2.10', port: ++port },
  resultTransport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: ++port },
  ...extra,
});
const hmisBlock = (extra: Record<string, unknown>) => ({ auditLog: join(dir, 'logs', 'hmis.log'), hinai: HINAI, genx: GENX, ...extra });
const AUTO_CERTIFY_ON = {
  enabled: true,
  baseUrl: 'http://his.example:8050',
  siteId: '2',
  equipmentIds: ['111'],
  resultStatus: ['5'],
  parameterResultStatus: ['1'],
  oracle: { user: 'u', password: 'p', connectString: 'db.example:1521/S' },
  logFile: null,
};
const IM_BLOCK = {
  enabled: true,
  id: 'im',
  equipmentCode: 'EQ0022',
  equipmentId: 46150218,
  siteIds: ['2', '13873256', '5866265'],
  orders: { host: '192.0.2.10', port: 21011 },
  results: { host: '0.0.0.0', port: 21012 },
  autoCertify: { hinai: false, genx: false },
};

// =============================================================================
console.log('\n— hmis mode / use / legacy api');

check('legacy flat hmis (no api, no mode): single hinai, hmis.api still readable', () => {
  const cfg = load({ hmis: { ...HINAI, auditLog: null }, analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai']);
  assert.equal(cfg.hmis.api, 'mirth', 'hmis.api keeps its old default for old code paths');
});

check('api "mirth" and api "hinai" => single hinai', () => {
  for (const api of ['mirth', 'hinai']) {
    const cfg = load({ hmis: hmisBlock({ api }), analyzers: [plain('a1', 'EQ1')] });
    assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai'], `api "${api}"`);
  }
});

check('api "genx" => single genx (hmis.api still "genx" on the parsed config)', () => {
  const cfg = load({ hmis: hmisBlock({ api: 'genx' }), analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['genx']);
  assert.equal(cfg.hmis.api, 'genx');
});

check('mode "single" + use picks the lane', () => {
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ mode: 'single', use: 'genx' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['genx']);
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ mode: 'single', use: 'hinai' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['hinai']);
});

check('mode "single" without use: use is derived from api', () => {
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ mode: 'single', api: 'genx' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['genx']);
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ mode: 'single', api: 'mirth' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['hinai']);
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ mode: 'single' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['hinai']);
});

check('mode/use win over api', () => {
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ api: 'genx', mode: 'single', use: 'hinai' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['hinai']);
  assert.deepEqual(lanesOf(load({ hmis: hmisBlock({ api: 'hinai', mode: 'single', use: 'genx' }), analyzers: [plain('a1', 'EQ1')] }), 'a1'), ['genx']);
  assert.deepEqual(sorted(lanesOf(load({ hmis: hmisBlock({ api: 'genx', mode: 'both' }), analyzers: [plain('a1', 'EQ1')] }), 'a1')), ['genx', 'hinai']);
});

check('mode "both" => both lanes, hinai first; use alongside it is accepted and ignored', () => {
  const both = lanesOf(load({ hmis: hmisBlock({ mode: 'both' }), analyzers: [plain('a1', 'EQ1')] }), 'a1');
  assert.deepEqual(sorted(both), ['genx', 'hinai']);
  assert.equal(both[0], 'hinai', 'the FIRST lane in both mode is hinai (rows on disk with no source belong to it)');
  const withUse = lanesOf(load({ hmis: hmisBlock({ mode: 'both', use: 'genx' }), analyzers: [plain('a1', 'EQ1')] }), 'a1');
  assert.deepEqual(sorted(withUse), ['genx', 'hinai']);
});

check('an unknown mode or use is refused', () => {
  assert.throws(() => load({ hmis: hmisBlock({ mode: 'triple' }), analyzers: [plain('a1', 'EQ1')] }), /mode/);
  assert.throws(() => load({ hmis: hmisBlock({ mode: 'single', use: 'oracle' }), analyzers: [plain('a1', 'EQ1')] }), /use/);
});

// =============================================================================
console.log('\n— per-analyzer override (spec 1b)');

check('analyzer "hmis" block overrides the top-level setting; absent = top level', () => {
  const cfg = load({
    hmis: hmisBlock({ mode: 'single', use: 'hinai' }),
    analyzers: [
      plain('a1', 'EQ1'),
      plain('a2', 'EQ2', { hmis: { mode: 'both' } }),
      plain('a3', 'EQ3', { hmis: { mode: 'single', use: 'genx' } }),
    ],
  });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai'], 'no override: top level');
  assert.deepEqual(sorted(lanesOf(cfg, 'a2')), ['genx', 'hinai'], 'override to both');
  assert.deepEqual(lanesOf(cfg, 'a3'), ['genx'], 'override to single genx');
});

check('top level both, one analyzer narrowed to single hinai', () => {
  const cfg = load({
    hmis: hmisBlock({ mode: 'both' }),
    analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2', { hmis: { mode: 'single', use: 'hinai' } })],
  });
  assert.deepEqual(sorted(lanesOf(cfg, 'a1')), ['genx', 'hinai']);
  assert.deepEqual(lanesOf(cfg, 'a2'), ['hinai']);
});

// =============================================================================
console.log('\n— base URLs and the GenX guard, per lane actually in use');

check('mode both with no genx.baseUrl is refused', () => {
  assert.throws(
    () => load({ hmis: hmisBlock({ mode: 'both', genx: { ...GENX, baseUrl: '' } }), analyzers: [plain('a1', 'EQ1')] }),
    /genx\.baseUrl/,
  );
});

check('one analyzer overridden to genx needs genx.baseUrl even when the top level is hinai', () => {
  assert.throws(
    () =>
      load({
        hmis: hmisBlock({ mode: 'single', use: 'hinai', genx: { ...GENX, baseUrl: '' } }),
        analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2', { hmis: { mode: 'single', use: 'genx' } })],
      }),
    /genx\.baseUrl/,
  );
});

check('mode both with no hinai base URL is refused (hmis.baseUrl)', () => {
  assert.throws(
    () => load({ hmis: { auditLog: null, mode: 'both', genx: GENX }, analyzers: [plain('a1', 'EQ1')] }),
    /hmis\.baseUrl/,
  );
});

check('an analyzer overridden to hinai needs hmis.baseUrl even when the top level is genx', () => {
  assert.throws(
    () =>
      load({
        hmis: { auditLog: null, mode: 'single', use: 'genx', genx: GENX },
        analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2', { hmis: { mode: 'single', use: 'hinai' } })],
      }),
    /hmis\.baseUrl/,
  );
});

check('single genx with no hinai base URL loads (hinai is not in use)', () => {
  const cfg = load({ hmis: { auditLog: null, mode: 'single', use: 'genx', genx: GENX }, analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['genx']);
});

check('single hinai with no genx block at all loads (genx is not in use)', () => {
  const cfg = load({ hmis: { ...HINAI, auditLog: null, mode: 'single', use: 'hinai' }, analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai']);
});

check('GenX guard: an order-pushing analyzer whose OWN lanes include genx needs an equipmentServices entry', () => {
  const noServices = { ...GENX, equipmentServices: {} };
  assert.throws(
    () => load({ hmis: hmisBlock({ mode: 'single', use: 'hinai', genx: noServices }), analyzers: [imAnalyzer('im', { hmis: { mode: 'both' } })] }),
    /pushes orders \(hl7\.orderPush\) but hmis\.genx\.equipmentServices has no entry for EQ0022/,
  );
  assert.throws(
    () => load({ hmis: hmisBlock({ mode: 'both', genx: noServices }), analyzers: [imAnalyzer('im')] }),
    /equipmentServices has no entry for EQ0022/,
    'top-level both applies to the analyzer',
  );
});

check('GenX guard: not applied to an order-pushing analyzer whose lanes are hinai only', () => {
  const noServices = { ...GENX, equipmentServices: {} };
  const a = load({ hmis: hmisBlock({ mode: 'single', use: 'hinai', genx: noServices }), analyzers: [imAnalyzer('im')] });
  assert.deepEqual(lanesOf(a, 'im'), ['hinai']);
  const b = load({ hmis: hmisBlock({ mode: 'both', genx: noServices }), analyzers: [imAnalyzer('im', { hmis: { mode: 'single', use: 'hinai' } })] });
  assert.deepEqual(lanesOf(b, 'im'), ['hinai'], 'top level both, IM narrowed to hinai');
});

// =============================================================================
console.log('\n— new GenX keys');

check('genx.auditLog / autoCertifyPath / autoCertifyMethod / autoCertifyParam defaults', () => {
  const cfg = load({ hmis: { ...HINAI, auditLog: null, genx: { baseUrl: 'http://127.0.0.1:2' } }, analyzers: [plain('a1', 'EQ1')] });
  const g = cfg.hmis.genx as Record<string, unknown>;
  assert.equal(g.auditLog, './logs/hmis-genx.log');
  assert.equal(g.autoCertifyPath, '/integration-service/external/v1/lab/equipment/autocertify');
  assert.equal(g.autoCertifyMethod, 'GET');
  assert.equal(g.autoCertifyParam, 'labresultid');
});

check('the GenX certify keys can be overridden; an unknown method is refused', () => {
  const cfg = load({
    hmis: hmisBlock({ genx: { ...GENX, autoCertifyPath: '/lab/certify', autoCertifyMethod: 'POST', autoCertifyParam: 'sampleLineId' } }),
    analyzers: [plain('a1', 'EQ1')],
  });
  const g = cfg.hmis.genx as Record<string, unknown>;
  assert.deepEqual([g.autoCertifyPath, g.autoCertifyMethod, g.autoCertifyParam], ['/lab/certify', 'POST', 'sampleLineId']);
  assert.throws(
    () => load({ hmis: hmisBlock({ genx: { ...GENX, autoCertifyMethod: 'PUT' } }), analyzers: [plain('a1', 'EQ1')] }),
    /autoCertifyMethod/,
  );
});

check('analyzer key genxAutoCertify: boolean, default false', () => {
  const cfg = load({
    hmis: hmisBlock({ mode: 'both' }),
    analyzers: [plain('a1', 'EQ1'), plain('a2', 'EQ2', { genxAutoCertify: true })],
  });
  assert.equal((cfg.analyzers[0] as Record<string, unknown>).genxAutoCertify, false);
  assert.equal((cfg.analyzers[1] as Record<string, unknown>).genxAutoCertify, true);
});

// =============================================================================
console.log('\n— the top-level im block (spec 1c)');

check('im block becomes an ordinary analyzer appended to analyzers', () => {
  const cfg = load({
    hmis: hmisBlock({ mode: 'single', use: 'hinai' }),
    analyzers: [plain('a1', 'EQ1')],
    im: { ...IM_BLOCK, hmis: { mode: 'both' }, autoCertify: { hinai: false, genx: true } },
  });
  assert.deepEqual(cfg.analyzers.map((a) => a.id), ['a1', 'im'], 'appended after the declared analyzers');
  const im = cfg.analyzers[1]!;
  assert.equal(im.profile, 'im');
  assert.equal(im.protocol, 'hl7', 'the profile applied (translation happens BEFORE profiles)');
  assert.equal(im.equipmentCode, 'EQ0022');
  assert.equal(String(im.equipmentId), '46150218');
  assert.deepEqual(im.siteIds, ['2', '13873256', '5866265']);
  assert.deepEqual(im.transport, { type: 'tcp', mode: 'client', host: '192.0.2.10', port: 21011 }, 'orders => transport, tcp client');
  assert.deepEqual(im.resultTransport, { type: 'tcp', mode: 'server', host: '0.0.0.0', port: 21012 }, 'results => resultTransport, tcp server');
  assert.equal((im as Record<string, unknown>).genxAutoCertify, true, 'autoCertify.genx => genxAutoCertify');
  assert.equal(im.hl7.orderPush.enabled, true);
  assert.equal(im.orderPoll.enabled, true);
  assert.equal(im.hostQuery, false);
  assert.equal(im.sendDemographics, true);
  assert.equal(im.filing.mode, 'staged');
  assert.deepEqual(sorted(lanesOf(cfg, 'im')), ['genx', 'hinai'], 'im.hmis => the analyzer lanes');
  assert.deepEqual(lanesOf(cfg, 'a1'), ['hinai'], 'the other analyzer keeps the top level');
});

check('im block with no hmis takes the top level; with no id it is "im"; genxAutoCertify defaults false', () => {
  const { id: _id, ...noId } = IM_BLOCK;
  const cfg = load({ hmis: hmisBlock({ mode: 'single', use: 'genx' }), im: { ...noId, autoCertify: { hinai: false, genx: false } } });
  assert.deepEqual(cfg.analyzers.map((a) => a.id), ['im'], 'an im block alone is a complete config (no analyzers key)');
  assert.deepEqual(lanesOf(cfg, 'im'), ['genx']);
  assert.equal((cfg.analyzers[0] as Record<string, unknown>).genxAutoCertify, false);
  const named = load({ hmis: hmisBlock({}), im: { ...IM_BLOCK, id: 'im-ahd' } });
  assert.deepEqual(named.analyzers.map((a) => a.id), ['im-ahd']);
});

check('im block single hinai: lanes hinai', () => {
  const cfg = load({ hmis: hmisBlock({ mode: 'both' }), im: { ...IM_BLOCK, hmis: { mode: 'single', use: 'hinai' } } });
  assert.deepEqual(lanesOf(cfg, 'im'), ['hinai']);
});

check('im.enabled false, or no im block: no IM analyzer from it', () => {
  const off = load({ hmis: hmisBlock({}), analyzers: [plain('a1', 'EQ1')], im: { ...IM_BLOCK, enabled: false } });
  assert.deepEqual(off.analyzers.map((a) => a.id), ['a1']);
  const none = load({ hmis: hmisBlock({}), analyzers: [plain('a1', 'EQ1')] });
  assert.deepEqual(none.analyzers.map((a) => a.id), ['a1']);
});

check('im.analyzer escape hatch: raw analyzer keys merged last', () => {
  const cfg = load({
    hmis: hmisBlock({}),
    im: {
      ...IM_BLOCK,
      analyzer: {
        orderPoll: { intervalMs: 30000 },
        sendDemographics: false,
        filing: { passIntervalMs: 20000 },
        hl7: { orderPush: { enabled: true, version: '2.5', ackTimeoutMs: 4000 } },
      },
    },
  });
  const im = cfg.analyzers[0]!;
  assert.equal(im.orderPoll.intervalMs, 30000);
  assert.equal(im.orderPoll.enabled, true, 'the rest of the profile orderPoll stays');
  assert.equal(im.sendDemographics, false);
  assert.equal(im.filing.passIntervalMs, 20000);
  assert.equal(im.filing.mode, 'staged');
  assert.equal(im.hl7.orderPush.version, '2.5');
  assert.equal(im.hl7.orderPush.ackTimeoutMs, 4000);
  assert.equal(im.hl7.sendingApp, 'HMIS-LIS', 'the rest of the profile hl7 block stays');
});

// The spec's own example of the escape hatch is "hl7.orderPush.version". The
// profile merge is one level deep, so a bare { orderPush: { version } } would
// replace the profile's orderPush and switch the push OFF. This pins that the
// example means what it says (version changed, IM still sent orders).
check('im.analyzer { hl7: { orderPush: { version } } } changes the version and leaves the push on', () => {
  const cfg = load({ hmis: hmisBlock({}), im: { ...IM_BLOCK, analyzer: { hl7: { orderPush: { version: '2.5' } } } } });
  const im = cfg.analyzers[0]!;
  assert.equal(im.hl7.orderPush.version, '2.5');
  assert.equal(im.hl7.orderPush.enabled, true, 'orderPush.enabled must survive a version-only override');
});

check('im.autoCertify.hinai adds the IM equipmentId (string, deduplicated) to autoCertify.equipmentIds', () => {
  const cfg = load({
    hmis: hmisBlock({}),
    autoCertify: AUTO_CERTIFY_ON,
    im: { ...IM_BLOCK, autoCertify: { hinai: true, genx: false } },
  });
  assert.deepEqual(sorted(cfg.autoCertify.equipmentIds), ['111', '46150218']);
  assert.ok(cfg.autoCertify.equipmentIds.every((x) => typeof x === 'string'));
  const dup = load({
    hmis: hmisBlock({}),
    autoCertify: { ...AUTO_CERTIFY_ON, equipmentIds: ['46150218'] },
    im: { ...IM_BLOCK, autoCertify: { hinai: true, genx: false } },
  });
  assert.deepEqual(dup.autoCertify.equipmentIds, ['46150218'], 'not listed twice');
  const off = load({ hmis: hmisBlock({}), autoCertify: AUTO_CERTIFY_ON, im: { ...IM_BLOCK, autoCertify: { hinai: false, genx: true } } });
  assert.deepEqual(off.autoCertify.equipmentIds, ['111'], 'hinai:false leaves the list alone');
});

check('im.autoCertify.hinai with autoCertify disabled is a config error naming both keys', () => {
  let message = '';
  try {
    load({
      hmis: hmisBlock({}),
      autoCertify: { enabled: false, logFile: null },
      im: { ...IM_BLOCK, autoCertify: { hinai: true, genx: false } },
    });
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message, 'loadConfig threw');
  assert.match(message, /im\.autoCertify\.hinai/);
  assert.match(message, /autoCertify\.enabled/);
});

// Addendum A2: with no HINAI lane on IM the flag is ignored (a warn at start),
// never an error, and never touches autoCertify.equipmentIds.
check('im.autoCertify.hinai with IM on single genx is ignored: loads, equipmentIds unchanged', () => {
  const off = load({
    hmis: hmisBlock({}),
    autoCertify: { enabled: false, logFile: null },
    im: { ...IM_BLOCK, hmis: { mode: 'single', use: 'genx' }, autoCertify: { hinai: true, genx: false } },
  });
  assert.deepEqual(lanesOf(off, 'im'), ['genx']);
  assert.deepEqual(off.autoCertify.equipmentIds, [], 'autoCertify disabled: still loads, list untouched');
  const on = load({
    hmis: hmisBlock({}),
    autoCertify: AUTO_CERTIFY_ON,
    im: { ...IM_BLOCK, hmis: { mode: 'single', use: 'genx' }, autoCertify: { hinai: true, genx: false } },
  });
  assert.deepEqual(on.autoCertify.equipmentIds, ['111'], 'autoCertify enabled: the IM id is NOT added');
});

check('im.autoCertify.hinai with IM in both mode and autoCertify disabled is a config error', () => {
  assert.throws(
    () =>
      load({
        hmis: hmisBlock({}),
        autoCertify: { enabled: false, logFile: null },
        im: { ...IM_BLOCK, hmis: { mode: 'both' }, autoCertify: { hinai: true, genx: false } },
      }),
    (err: unknown) => /im\.autoCertify\.hinai/.test(String((err as Error).message)) && /autoCertify\.enabled/.test(String((err as Error).message)),
  );
});

check('im block + an analyzer with the same equipment code => duplicate-code error', () => {
  assert.throws(
    () => load({ hmis: hmisBlock({}), analyzers: [imAnalyzer('im-old')], im: IM_BLOCK }),
    /claim equipment code "EQ0022"|lists equipment code "EQ0022" twice/,
  );
});

check('an IM analyzer declared directly in analyzers still loads (single hinai)', () => {
  const cfg = load({ hmis: hmisBlock({}), analyzers: [imAnalyzer('im')] });
  assert.equal(cfg.analyzers[0]!.profile, 'im');
  assert.deepEqual(lanesOf(cfg, 'im'), ['hinai']);
});

check('the hinai block is still lifted (liftHmisBlocks) with mode present', () => {
  const cfg = load({ hmis: hmisBlock({ mode: 'both', baseUrl: 'http://stale.example/x' }), analyzers: [plain('a1', 'EQ1')] });
  assert.equal(cfg.hmis.baseUrl, HINAI.baseUrl);
  assert.deepEqual(cfg.hmis.siteIds, ['2']);
  assert.equal(cfg.hmis.resultsPath, '/mirth/labresult');
});

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\nlanes-config: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nlanes-config: all checks passed');
process.exit(0);
