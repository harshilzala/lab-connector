// =============================================================================
// Refused values are paced, not re-posted on every pass — OFFLINE.
// StagedFiler + ResultStore driven directly with in-process fake gateways (no
// network at all), plus one GenxLimsClient unit check against a 127.0.0.1 stub.
// Run: LAB_CONNECTOR_ENV=/nonexistent.env npx tsx test/refused-retry.test.ts   (npm run refused)
// =============================================================================
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/logger.js';
import { toLisResultRows } from '../src/mapping/mapper.js';
import { ResultStore } from '../src/results/store.js';
import { StagedFiler } from '../src/results/filer.js';
import { HmisRefusedError } from '../src/hmis/client.js';
import { GenxLimsClient, type GenxLimsOptions } from '../src/hmis/genx-lims.js';
import type { Lane } from '../src/hmis/lanes.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../src/types.js';

for (const k of Object.keys(process.env)) if (k === 'HMIS_BASE_URL' || k.startsWith('GENX_') || k.startsWith('TATVA_')) delete process.env[k];

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRY = 200;
const GIVEUP = 1000;

const root = mkdtempSync(join(tmpdir(), 'refused-'));
const log = logger.child({ test: 'refused' });
log.level = 'silent';
let n = 0;

const orderRow = (barcode: string, identifier: string, id: number): MirthAcknowledgeItem => ({
  sampleID: barcode, equipmentId: 1, identifier, ipAddress: '', isTransmitted: true, labResultId: id, labServiceId: 1, portNo: '', parameterId: id,
});
const upload = (barcode: string, values: Record<string, string>, tag = ''): HmisResultUpload => ({
  equipmentId: 1, eqCode: 'EQ', barcode, isQc: false,
  results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null })),
  messageId: `${barcode}-${Object.values(values).join('|')}${tag}`,
});
const join_ = (u: HmisResultUpload, rows: MirthAcknowledgeItem[], _lane?: Lane) => toLisResultRows(u, rows, undefined, {}, ['*-IM'], {}, []);

type Post = (rows: LisInboundResultRow[]) => { filed: number; message: string; unmatched?: string[] };
const codes = (rows: LisInboundResultRow[]) => rows.map((r) => r.identifier);

function single(lane: Lane, over: { retry?: number; giveUp?: number } = {}) {
  const store = new ResultStore(join(root, `s${n++}`), log);
  const posts: string[][] = [];
  let behave: Post = (rows) => ({ filed: rows.length, message: 'ok' });
  const filer = new StagedFiler({
    store,
    orderRows: async (b) => ['TSH3', 'FT4'].map((c, i) => orderRow(b, c, 100 + i)),
    join: join_,
    postResults: async (rows) => {
      posts.push(codes(rows));
      return behave(rows);
    },
    acknowledge: async () => {},
    log,
    recheckMs: 60_000,
    lane,
    refusedRetryMs: over.retry ?? RETRY,
    refusedGiveUpMs: over.giveUp ?? GIVEUP,
  });
  return { store, posts, filer, setBehave: (b: Post) => (behave = b) };
}
const refuseFt4: Post = (rows) => ({ filed: rows.length - 1, message: 'partial', unmatched: ['FT4'] });
const entry = (store: ResultStore, b: string, lane: string, code = 'FT4') => (store.get(b)!.values[code] as any).lanes?.[lane];

// ---- 1 ----------------------------------------------------------------------
{
  const t = single('genx');
  t.setBehave(refuseFt4);
  t.store.upsert(upload('S1', { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  const s = t.store.get('S1')!;
  check(!!s.values.TSH3!.filedAt && !s.values.FT4!.filedAt, '1: TSH3 filed, FT4 waiting');
  check(entry(t.store, 'S1', 'genx')?.refusals === 1 && entry(t.store, 'S1', 'genx')?.filedAt === null, '1: FT4 refusals=1, lane filedAt null');
  check(JSON.stringify(t.posts) === '[["TSH3","FT4"]]', `1: first post carried both (got ${JSON.stringify(t.posts)})`);
  await t.filer.run('poll');
  check(t.posts.length === 1, '1: immediate second pass does not post');
  check(/did not accept FT4/.test(t.store.get('S1')!.lastError ?? '') && /retried every/.test(t.store.get('S1')!.lastError ?? ''), `1: waiting note (${t.store.get('S1')!.lastError})`);
  await wait(RETRY + 80);
  await t.filer.run('poll');
  check(t.posts.length === 2 && JSON.stringify(t.posts[1]) === '["FT4"]', `1: after retryMs FT4 posted again alone (got ${JSON.stringify(t.posts)})`);
  check(entry(t.store, 'S1', 'genx')?.refusals === 2, '1: refusals incremented to 2');
}

// ---- 2 ----------------------------------------------------------------------
{
  const t = single('genx');
  t.setBehave(() => {
    throw new HmisRefusedError('filed 0', ['FT4']);
  });
  t.store.upsert(upload('S2', { FT4: '1.2' }));
  const r = await t.filer.run('poll');
  check(entry(t.store, 'S2', 'genx')?.refusals === 1, '2: thrown HmisRefusedError recorded as refusal');
  check(!!t.store.get('S2')!.lastError && /filed 0/.test(t.store.get('S2')!.lastError!), `2: lastError set (${t.store.get('S2')!.lastError}); report errors=${r.errors}`);
  await t.filer.run('poll');
  check(t.posts.length === 1, '2: next pass within retryMs makes no post');
}

// ---- 3 give-up --------------------------------------------------------------
{
  const t = single('genx');
  t.setBehave(refuseFt4);
  t.store.upsert(upload('S3', { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  const until = Date.now() + GIVEUP + 100;
  while (Date.now() < until) {
    await wait(RETRY + 30);
    await t.filer.run('poll'); // keeps retrying until give-up
  }
  const before = t.posts.length;
  await wait(RETRY + 50);
  await t.filer.run('poll');
  check(t.posts.length === before, `3: no automatic post after give-up (${before} posts total)`);
  check(/automatic retries stopped/.test(t.store.get('S3')!.lastError ?? ''), `3: lastError says retries stopped (${t.store.get('S3')!.lastError})`);
  await t.filer.run('operator');
  check(t.posts.length === before + 1 && t.posts.at(-1)!.includes('FT4'), `3: operator pass posts FT4 (${JSON.stringify(t.posts.at(-1))})`);
}

// ---- 4 success later --------------------------------------------------------
{
  const t = single('genx');
  t.setBehave(refuseFt4);
  t.store.upsert(upload('S4', { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  t.setBehave((rows) => ({ filed: rows.length, message: 'ok' }));
  await wait(RETRY + 80);
  await t.filer.run('poll');
  const s = t.store.get('S4')!;
  check(!!s.values.FT4!.filedAt && !!entry(t.store, 'S4', 'genx')?.filedAt, '4: FT4 filedAt set after later success');
  const c = t.posts.length;
  await wait(RETRY + 80);
  await t.filer.run('poll');
  check(t.posts.length === c, '4: nothing posted afterwards');
}

// ---- 5 rerun ----------------------------------------------------------------
{
  const t = single('genx');
  t.setBehave(refuseFt4);
  t.store.upsert(upload('S5', { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  t.store.upsert(upload('S5', { TSH3: '2.1', FT4: '1.9' }, 'rerun'));
  check(entry(t.store, 'S5', 'genx') === undefined, '5: rerun clears the lane refusal entry');
  t.setBehave((rows) => ({ filed: rows.length, message: 'ok' }));
  await t.filer.run('poll');
  check(t.posts.length === 2 && t.posts[1]!.includes('FT4'), `5: rerun value posted on next pass without waiting (${JSON.stringify(t.posts)})`);
  check(!!t.store.get('S5')!.values.FT4!.filedAt, '5: rerun FT4 filed');
}

// ---- 6 + 7 both mode --------------------------------------------------------
function both(genxBehave: (barcode: string, rows: LisInboundResultRow[]) => ReturnType<Post>) {
  const store = new ResultStore(join(root, `b${n++}`), log);
  const posts: Record<string, string[][]> = { hinai: [], genx: [] };
  const genxCalls: string[] = [];
  const filer = new StagedFiler({
    store,
    orderRows: async () => [],
    join: join_,
    postResults: async () => ({ filed: 0, message: 'unused' }),
    acknowledge: async () => {},
    log,
    recheckMs: 60_000,
    refusedRetryMs: RETRY,
    refusedGiveUpMs: GIVEUP,
    lanes: {
      names: ['hinai', 'genx'],
      orderRows: async (lane, b) => ['TSH3', 'FT4'].map((c, i) => orderRow(b, c, (lane === 'hinai' ? 100 : 500) + i)),
      postResults: async (lane, rows) => {
        posts[lane]!.push(codes(rows));
        if (lane === 'genx') {
          genxCalls.push(rows[0]!.sampleId);
          return genxBehave(rows[0]!.sampleId, rows);
        }
        return { filed: rows.length, message: 'ok' };
      },
      acknowledge: async () => {},
    },
  });
  return { store, posts, filer, genxCalls };
}
{
  // genx: first (2-value) post -> TSH3 filed, FT4 refused via throw only when FT4 alone is re-sent
  const t = both((_b, rows) => {
    if (rows.length === 2) return { filed: 1, message: 'p', unmatched: ['FT4'] };
    throw new HmisRefusedError('filed 0 of 1', ['FT4']);
  });
  for (const b of ['B1', 'B2', 'B3', 'B4']) t.store.upsert(upload(b, { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  check(t.posts.hinai!.length === 4 && t.posts.genx!.length === 4, `6: pass 1 posted to both lanes for 4 samples (hinai ${t.posts.hinai!.length}, genx ${t.posts.genx!.length})`);
  check(entry(t.store, 'B1', 'genx')?.refusals === 1 && !!entry(t.store, 'B1', 'hinai')?.filedAt, '6: genx refusal recorded, hinai lane filed');
  await t.filer.run('poll');
  check(t.posts.hinai!.length === 4 && t.posts.genx!.length === 4, '6: immediate second pass: neither lane re-posted');
  await wait(RETRY + 80);
  await t.filer.run('poll');
  check(t.posts.hinai!.length === 4, '6: hinai never re-posted');
  check(t.posts.genx!.length === 8 && t.posts.genx!.slice(4).every((p) => p.length === 1 && p[0] === 'FT4'), `6: genx FT4 re-posted alone after retryMs (${JSON.stringify(t.posts.genx!.slice(4))})`);
  check(entry(t.store, 'B1', 'genx')?.refusals === 2, '6: refusals=2 (thrown refusal also recorded)');
}
{
  // refusals thrown as errors for 5 samples in ONE pass: lane must not go down
  const t = both(() => {
    throw new HmisRefusedError('filed 0', ['TSH3', 'FT4']);
  });
  for (const b of ['R1', 'R2', 'R3', 'R4', 'R5']) t.store.upsert(upload(b, { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  check(t.genxCalls.length === 5, `6b: all 5 samples still posted to genx in one pass (refusal != lane failure) — got ${t.genxCalls.length}`);
  check(t.posts.hinai!.length === 5, '6b: hinai filed all');
  await t.filer.run('poll');
  check(t.genxCalls.length === 5 && t.posts.hinai!.length === 5, '6b: second pass posts nothing anywhere');
}
{
  // 7: plain Error still counts as a lane failure
  const t = both(() => {
    throw new Error('fetch failed');
  });
  for (const b of ['E1', 'E2', 'E3', 'E4', 'E5']) t.store.upsert(upload(b, { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  check(t.genxCalls.length === 5, `7: plain error: every sample still tried in the pass (a successful order lookup resets laneFailures per sample, so a post-only failure never marks the lane down) - genx calls ${t.genxCalls.length}`);
  check(entry(t.store, 'E1', 'genx')?.refusals === undefined, '7: plain error records no refusal');
  check(/gateway failing|fetch failed/.test(t.store.get('E1')!.lastError ?? ''), `7: lastError (${t.store.get('E1')!.lastError})`);
  const c = t.genxCalls.length;
  await t.filer.run('poll');
  check(t.genxCalls.length > c, `7: retried on next pass with no pacing (genx calls ${c} -> ${t.genxCalls.length})`);
}

// ---- 8 never give up --------------------------------------------------------
{
  const t = single('genx', { giveUp: 0 });
  t.setBehave(refuseFt4);
  t.store.upsert(upload('S8', { TSH3: '2.1', FT4: '1.2' }));
  await t.filer.run('poll');
  await wait(GIVEUP + 300);
  await t.filer.run('poll');
  check(t.posts.length === 2, `8: refusedGiveUpMs 0 -> still retried after ${GIVEUP + 300} ms (posts ${t.posts.length})`);
  await t.filer.run('poll');
  check(t.posts.length === 2 && !/retries stopped/.test(t.store.get('S8')!.lastError ?? ''), '8: still paced, never "stopped"');
}

// ---- 9 HINAI sanity ---------------------------------------------------------
{
  const t = single('hinai');
  t.store.upsert(upload('S9', { TSH3: '2.1', FT4: '1.2' }));
  const r = await t.filer.run('poll');
  check(r.filed === 1 && t.posts.length === 1 && t.posts[0]!.length === 2 && !!t.store.get('S9')!.values.FT4!.filedAt, '9: HINAI single lane files all, unchanged');
  await t.filer.run('poll');
  check(t.posts.length === 1 && entry(t.store, 'S9', 'hinai')?.refusals === undefined, '9: no refusal bookkeeping, no re-post');
}

// ---- 10 store.markRefused ---------------------------------------------------
{
  const t = single('genx');
  t.store.upsert(upload('S10', { FT4: '1.2' }));
  t.store.markRefused('S10', 'genx', ['FT4']);
  t.store.markRefused('S10', 'genx', ['NOPE']);
  const e = entry(t.store, 'S10', 'genx');
  check(e?.refusals === 1 && e?.refusedFirstAt === e?.refusedLastAt, '10: markRefused sets first/last/refusals; unknown code ignored');
}

// ---- 11 GenxLimsClient "filed 0" is a HmisRefusedError ----------------------
{
  let reply: unknown = {};
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url!.includes('/auth/login') ? { token: 't' } : { success: true, message: 'ok', data: reply }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opts: GenxLimsOptions = {
    baseUrl: base, authBaseUrl: base, auth: 'login', loginPath: '/api/auth/login', username: 'lab', password: 'pw', tokenPath: '/oauth/token',
    clientId: 'c', clientSecret: 's', scope: '', clientAuth: 'basic', apiKeyHeader: 'X-API-Key', moduleCode: 'DS', ordersPath: '/api/connector/orders',
    acknowledgePath: '/api/connector/acknowledge', resultsPath: '/api/connector/results', autoCertifyPath: '/api/lines/auto-certify', barcodeField: 'barcode',
    serviceTests: {}, pendingLineStatuses: [], batchDays: 1, reliabilityPct: null, timeoutMs: 5000, tlsRejectUnauthorized: true, logger: log,
  };
  const row = (identifier: string): LisInboundResultRow => ({
    sampleId: 'LB1', labServiceId: 1, labResultId: 10, equipmentId: null, ipAddress: '', portNo: '', identifier, resultValue: '7.8', isLoaded: false, uniqueIdentifier: identifier, parameterId: null,
  });
  const attempt = async (r: unknown, rows: LisInboundResultRow[]) => {
    reply = r;
    try {
      await new GenxLimsClient(opts).postResults(rows, 'EC013');
      return null;
    } catch (e) {
      return e as Error;
    }
  };
  let e = await attempt({ filed: 0, unmatched: ['wbc'] }, [row('WBC')]);
  check(e instanceof HmisRefusedError && JSON.stringify(e.refused) === '["WBC"]' && /filed 0/.test(e.message), `11: lims filed 0 -> HmisRefusedError refused=${JSON.stringify((e as any)?.refused)}`);
  e = await attempt({ unmatched: ['WBC', 'HGB'] }, [row('WBC'), row('HGB')]);
  check(e instanceof HmisRefusedError && JSON.stringify([...e.refused].sort()) === '["HGB","WBC"]', `11: all unmatched -> refused lists both (${JSON.stringify((e as any)?.refused)})`);
  e = await attempt({ status: 'failure', message: 'nope' }, [row('WBC')]);
  check(e instanceof HmisRefusedError && e.refused.includes('WBC'), `11: status failure -> refused = all sent (${JSON.stringify((e as any)?.refused)})`);
  server.close();
  console.log('SKIP  11b: GenxHmisClient (batch worklist profile) "filed 0" instanceof check not done — needs accession cache + worklist stub');
}

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
