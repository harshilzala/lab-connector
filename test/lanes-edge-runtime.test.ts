import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AnalyzerConfig } from '../src/config.js';
import { HmisUnavailableError } from '../src/hmis/client.js';
import { AnalyzerRuntime } from '../src/session/orchestrator.js';
import type { HostQuery, HmisResultUpload } from '../src/types.js';

// =============================================================================
// HMIS lanes, round 2 — edge cases on one AnalyzerRuntime (addendum B).
//
// Every case builds a runtime from a real config file over two in-memory
// gateway doubles (HINAI shape and GenX shape) and drives the filing pass
// directly, so each check is deterministic and fast. A "restart" is a new
// runtime over the same spool directory.
//
//   B4/C1  spool written by the OLD code: migrated once at the first start
//          (single mode: tagged; both mode: quarantined); never a wrong row
//          or a certify of a migrated line
//   B1  single -> both: nothing already filed goes to the new lane
//   B3  both -> single: a held sample is released; nothing re-posted
//   B2  a code in one lane only; "File now" closes it
//   lookup failure vs hold; File now with the tube in neither lane
//   restart persistence: certified lines, held samples, operator skips
//   acknowledge failing in one lane
//   queue-mode analyzer in both mode: the old queue migrates and files to both
//   QC sample; U-WAM pairing + lanes; ASTM host query; genxAutoCertify off
//   C2  patient id cross-check between the lanes; C4 host query with a lane down
//
// Run: npx tsx test/lanes-edge-runtime.test.ts
// =============================================================================

const warns: string[] = [];
const rec: any = {
  child: () => rec,
  info() {},
  warn(...a: unknown[]) {
    warns.push(JSON.stringify(a));
  },
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  level: 'silent',
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await wait(20);
  }
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
const sorted = (l: readonly string[]) => [...l].sort();

const root = mkdtempSync(join(tmpdir(), 'lanes-edge-rt-'));
process.env.LAB_CONNECTOR_ENV = join(root, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];

let failures = 0;
const risks: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}\n    ${(err instanceof Error ? err.message : String(err)).split('\n').join('\n    ')}`);
  }
}
const risk = (text: string) => {
  risks.push(text);
  console.log(`! RISK ${text}`);
};

// ---- gateway doubles -----------------------------------------------------------
type Lane = 'hinai' | 'genx';
type Posted = { sampleId: string; identifier: string; resultValue: string; labResultId: number | null };
class FakeLane {
  rows: Array<Record<string, unknown>> = [];
  posted: Posted[] = [];
  acked: Array<{ sampleID: string; labResultId: number | null }> = [];
  lookups: string[] = [];
  certified: number[] = [];
  certifyCalls = 0;
  /** Every line id a certify was attempted for, successful or not. */
  certifyIds: number[] = [];
  failLookup = false;
  failPost = false;
  failAck = false;
  failCertify = 0;
  constructor(readonly lane: Lane) {}
  add(barcode: string, code: string, id: number, extra: Record<string, unknown> = {}) {
    this.rows.push(
      this.lane === 'hinai'
        ? { SampleID: barcode, eqIdntifier: code, equipmentCode: 'EQC', labResultId: id, labServiceId: 10, parameterId: id, ...extra }
        : { sampleID: barcode, accessionNumber: 'ACC' + barcode, identifier: code, serviceCode: 'S', labResultId: id, labServiceId: 20, isTransmitted: false, ...extra },
    );
  }
  postedFor(b: string) {
    return this.posted.filter((r) => r.sampleId === b);
  }
  gateway() {
    const self = this;
    const gw: Record<string, unknown> = {
      siteId: null,
      defaultSiteIds: [undefined],
      async getPending(q: { sampleId?: string }) {
        if (self.failLookup) throw new HmisUnavailableError(`${self.lane} lookup -> HTTP 503`);
        if (q.sampleId) self.lookups.push(q.sampleId);
        const rows = q.sampleId ? self.rows.filter((r) => (r.SampleID ?? r.sampleID) === q.sampleId) : self.rows;
        return self.lane === 'hinai' ? { status: 'success', data: rows } : rows;
      },
      async acknowledge(items: Array<{ sampleID: string; labResultId: number | null }>) {
        if (self.failAck) throw new Error(`${self.lane} acknowledge refused`);
        self.acked.push(...items);
      },
      async postResults(rows: Posted[]) {
        if (self.failPost) throw new HmisUnavailableError(`${self.lane} results -> HTTP 503`);
        self.posted.push(...rows);
        return { status: 'success', message: 'ok', successData: rows.map((r) => ({ sampleId: r.sampleId, labResultId: r.labResultId })), filed: rows.length };
      },
    };
    if (this.lane === 'genx') {
      gw.ignoresPollFilters = true;
      gw.autoCertify = async (lineId: number) => {
        self.certifyCalls++;
        self.certifyIds.push(lineId);
        if (self.failCertify > 0) {
          self.failCertify--;
          throw new Error('GenX certify -> HTTP 500');
        }
        self.certified.push(lineId);
      };
    }
    return gw;
  }
}

// ---- runtimes ----------------------------------------------------------------------
type Mode = 'hinai' | 'genx' | 'both';
let cfgN = 0;
function analyzerCfg(mode: Mode, extra: Record<string, unknown> = {}, port = 15999): AnalyzerConfig {
  const file = join(root, `cfg${++cfgN}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      logLevel: 'error',
      // Never used (no Connector is built here), but never the repo's ./spool or ./logs either.
      spoolDir: join(root, 'unused-spool'),
      retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: join(root, 'unused-logs'), includeSpoolPending: true },
      admin: { host: '127.0.0.1', port: 1, authFile: join(root, 'unused-auth.json') },
      autoCertify: { enabled: false, logFile: null },
      hmis: {
        auditLog: null,
        ...(mode === 'both' ? { mode: 'both' } : { mode: 'single', use: mode }),
        hinai: { baseUrl: 'http://127.0.0.1:1/portal' },
        genx: { baseUrl: 'http://127.0.0.1:2', clientId: 'c', clientSecret: 's', auditLog: join(root, 'g.log'), accessionCacheFile: join(root, 'acc.json') },
      },
      analyzers: [{ id: 'chem', equipmentCode: 'EQC', transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port }, filing: { mode: 'staged' }, ...extra }],
    }),
  );
  return loadConfig(file).analyzers[0]!;
}
type StoredValue = {
  value: string;
  filedAt: string | null;
  labResultId: number | null;
  lanes?: Partial<Record<Lane, { filedAt: string | null; labResultId: number | null; skipped?: 'operator' }>>;
};
type Sample = { barcode: string; lastError: string | null; values: Record<string, StoredValue>; certified?: { genx: number[] } };
type Inner = {
  filer: { run(reason: string, only?: string): Promise<unknown>; running: boolean };
  staged: { upsert(u: HmisResultUpload): unknown; get(b: string): Sample | null };
  orders: { get(b: string): { rows: Array<{ identifier: string; labResultId: number | null; source?: Lane }> } | null };
  onMessage(msg: unknown, opts?: unknown): Promise<void>;
  answerQuery(q: HostQuery): Promise<void>;
  link: { sendOrders(o: unknown[]): Promise<void> };
};
function runtime(spool: string, mode: Mode, H: FakeLane, G: FakeLane, extra: Record<string, unknown> = {}, port?: number) {
  const cfg = analyzerCfg(mode, extra, port);
  const gw = mode === 'both' ? { hinai: H.gateway(), genx: G.gateway() } : mode === 'hinai' ? { hinai: H.gateway() } : { genx: G.gateway() };
  const rt = new AnalyzerRuntime(cfg, gw as any, spool, rec);
  return { rt, inner: rt as unknown as Inner };
}
let msgN = 0;
const upload = (barcode: string, values: Record<string, string>, instrument: string | null = null): HmisResultUpload => ({
  equipmentId: 1,
  eqCode: 'EQC',
  barcode,
  isQc: false,
  results: Object.entries(values).map(([testCode, value]) => ({ testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null, instrument })),
  messageId: `${barcode}-${++msgN}`,
});
const stage = (inner: Inner, barcode: string, values: Record<string, string>, instrument: string | null = null) => inner.staged.upsert(upload(barcode, values, instrument));
const pass = (inner: Inner) => inner.filer.run('timer');
const complete = (s: Sample | null) => !!s && Object.values(s.values).every((v) => v.filedAt);
const newSpool = (name: string) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---- what the OLD code wrote (git show HEAD:src/orders/store.ts / src/results/store.ts) ----
// Relative to now: a fixed date ages past retention.days and the runtime's
// start-up sweep discards the old-code spool before the checks look at it.
const T0 = new Date(Date.now() - 60 * 60 * 1000).toISOString();
function writeOldOrder(spool: string, barcode: string, rows: Array<[string, number]>) {
  const dir = join(spool, 'chem', 'orders');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${barcode}.json`),
    JSON.stringify({
      barcode,
      sampleId: barcode,
      rows: rows.map(([identifier, labResultId]) => ({
        sampleID: barcode, equipmentId: 1, identifier, ipAddress: '', isTransmitted: true, labResultId, labServiceId: 10, portNo: '', parameterId: labResultId, resultType: null,
      })),
      testCodes: rows.map(([c]) => c),
      patient: null,
      specimenType: null,
      priority: 'R',
      downloaded: rows.map(([c]) => c),
      firstSeenAt: T0,
      updatedAt: T0,
      source: 'poll',
    }),
  );
}
function writeOldSample(spool: string, barcode: string, values: Array<[string, string, number | null]>) {
  const dir = join(spool, 'chem', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${barcode}.json`),
    JSON.stringify({
      barcode,
      eqCode: 'EQC',
      equipmentId: 1,
      isQc: false,
      firstReceivedAt: T0,
      updatedAt: T0,
      lastAttemptAt: T0,
      lastCheckedAt: T0,
      lastError: null,
      attempts: 1,
      rekeyedFrom: null,
      values: Object.fromEntries(
        values.map(([testCode, value, filedAs]) => [
          testCode,
          {
            testCode, value, unit: null, abnormalFlag: null, status: 'F', completedAt: null, receivedAt: T0,
            filedAt: filedAs === null ? null : T0, instrument: null, identifier: filedAs === null ? null : testCode, labResultId: filedAs, dropped: null,
          },
        ]),
      ),
      raw: null,
    }),
  );
}

// =============================================================================
console.log('\n— B4 / C1: data written by the old code');

// C1: migration runs at runtime START (the test calls start(), which also
// covers an implementation that does it in the constructor).
async function started(spool: string, mode: Mode, H: FakeLane, G: FakeLane, extra: Record<string, unknown> = {}) {
  const r = runtime(spool, mode, H, G, extra, await freePort());
  await r.rt.start();
  await until('the filer to be idle', () => !r.inner.filer.running);
  return r;
}
type DiskRow = { identifier: string; labResultId: number | null; source?: Lane | null; migrated?: boolean; quarantined?: boolean };
const diskOrder = (spool: string, b: string) =>
  JSON.parse(readFileSync(join(spool, 'chem', 'orders', `${b}.json`), 'utf8')) as { rows: DiskRow[] };
const lanesMarker = (spool: string) => {
  const p = join(spool, 'chem', 'orders', '.lanes.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { migratedAt?: string; lanes?: Lane[] }) : null;
};
const quarantineWarns = (from: number) => warns.slice(from).filter((w) => /cannot tell which HMIS/i.test(w)).length;

await check('C1 first start in single hinai: old rows tagged hinai + migrated, .lanes.json written; files exactly as before', async () => {
  const spool = newSpool('c1-single');
  writeOldOrder(spool, 'O1', [['TSH3', 1001], ['B12', 1002]]);
  writeOldSample(spool, 'O1', [['TSH3', '2.1', 1001], ['B12', '400', null]]);
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  const w0 = warns.length;
  const { rt, inner } = await started(spool, 'hinai', H, G);
  try {
    const rows = diskOrder(spool, 'O1').rows;
    assert.ok(rows.every((r) => r.source === 'hinai' && r.migrated === true), `rows tagged hinai + migrated (${JSON.stringify(rows)})`);
    const marker = lanesMarker(spool);
    assert.ok(marker?.migratedAt, `.lanes.json written (${JSON.stringify(marker)})`);
    assert.deepEqual(marker!.lanes, ['hinai']);
    assert.equal(quarantineWarns(w0), 0, 'nothing quarantined in single mode');
    await pass(inner);
    assert.deepEqual(H.posted.map((r) => `${r.identifier}=${r.resultValue}@${r.labResultId}`), ['B12=400@1002'], 'only the waiting value, against the cached row');
    assert.deepEqual(H.acked.map((r) => r.labResultId), [1002]);
    const s = inner.staged.get('O1')!;
    assert.ok(complete(s));
    assert.equal(s.values.TSH3!.filedAt, T0, 'the old filed value is untouched');
    await pass(inner);
    assert.equal(H.posted.length, 1, 'nothing re-posted');
  } finally {
    await rt.stop();
  }
  // A later start, now in both mode: never migrated again, the hinai tag stands.
  const w1 = warns.length;
  const marker = lanesMarker(spool);
  const H2 = new FakeLane('hinai');
  const G2 = new FakeLane('genx');
  G2.add('O1', 'B12', 5002);
  const later = await started(spool, 'both', H2, G2);
  try {
    assert.equal(quarantineWarns(w1), 0, 'no quarantine on a later start');
    assert.deepEqual(lanesMarker(spool), marker, '.lanes.json untouched');
    assert.ok(diskOrder(spool, 'O1').rows.every((r) => r.source === 'hinai' && r.migrated === true && !r.quarantined), 'rows keep the hinai tag');
    stage(later.inner, 'O1', { TSH3: '2.1', B12: '401' }); // a rerun of B12
    await pass(later.inner);
    assert.deepEqual(H2.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@1002'], 'HINAI files against the migrated HINAI row');
    assert.deepEqual(G2.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@5002']);
  } finally {
    await later.rt.stop();
  }
});

await check('C1 first start in both mode: old rows quarantined — never posted, acknowledged or forced; one warn', async () => {
  const spool = newSpool('c1-both');
  writeOldOrder(spool, 'O1', [['TSH3', 1001], ['B12', 1002]]);
  writeOldSample(spool, 'O1', [['TSH3', '2.1', 1001], ['B12', '400', null]]);
  const H = new FakeLane('hinai'); // HINAI does not list the tube right now
  const G = new FakeLane('genx');
  G.add('O1', 'TSH3', 5001);
  G.add('O1', 'B12', 5001);
  const w0 = warns.length;
  const { rt, inner } = await started(spool, 'both', H, G);
  try {
    const rows = diskOrder(spool, 'O1').rows;
    assert.equal(rows.length, 2, 'kept on disk');
    assert.ok(rows.every((r) => r.quarantined === true && r.source === null), `quarantined, source null (${JSON.stringify(rows)})`);
    assert.equal(quarantineWarns(w0), 1, 'exactly one warn for the analyzer');
    assert.ok(lanesMarker(spool)?.migratedAt, '.lanes.json written');
    await pass(inner);
    assert.equal(H.posted.length + G.posted.length, 0, 'the quarantined rows give HINAI no order: held, nothing posted');
    assert.match(inner.staged.get('O1')!.lastError ?? '', /only in GenX/);
    H.add('O1', 'B12', 1102); // HINAI lists the tube again, under its live row
    await pass(inner);
    assert.deepEqual(H.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@1102'], 'HINAI filed against its LIVE row');
    assert.deepEqual(G.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@5001']);
    await rt.stagedForce('O1').catch(() => null);
    const used = [...H.posted, ...G.posted].map((r) => r.labResultId).concat(H.acked.map((r) => r.labResultId), G.acked.map((r) => r.labResultId));
    assert.ok(!used.includes(1001) && !used.includes(1002), `no quarantined row ever posted, acknowledged or forced (${JSON.stringify(used)})`);
  } finally {
    await rt.stop();
  }
});

await check('C1 both mode after a first start: an old filed value does not go to GenX (B1); a waiting one files to both', async () => {
  const spool = newSpool('c1-both-b1');
  writeOldOrder(spool, 'O2', [['TSH3', 1201], ['B12', 1202]]);
  writeOldSample(spool, 'O2', [['TSH3', '2.1', 1201], ['B12', '400', null]]);
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('O2', 'TSH3', 1201);
  H.add('O2', 'B12', 1202);
  G.add('O2', 'TSH3', 5201);
  G.add('O2', 'B12', 5201);
  const { rt, inner } = await started(spool, 'both', H, G);
  try {
    await pass(inner);
    assert.deepEqual(H.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@1202'], 'HINAI: the waiting value, against the live row');
    assert.deepEqual(G.posted.map((r) => `${r.identifier}@${r.labResultId}`), ['B12@5201'], 'GenX: B12 only — TSH3 was complete before (B1)');
    assert.ok(complete(inner.staged.get('O2')));
    await pass(inner);
    assert.equal(H.posted.length + G.posted.length, 2, 'nothing re-posted');
  } finally {
    await rt.stop();
  }
});

// =============================================================================
console.log('\n— B1: single -> both');

await check('B1 a sample filed in single hinai: after the switch nothing goes anywhere; a NEW value files to both', async () => {
  const spool = newSpool('b1');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('S2', 'TSH3', 2001);
  H.add('S2', 'B12', 2002);
  G.add('S2', 'TSH3', 6001);
  G.add('S2', 'B12', 6002);
  const a = runtime(spool, 'hinai', H, G).inner;
  stage(a, 'S2', { TSH3: '1.5' });
  await pass(a);
  assert.equal(H.postedFor('S2').length, 1);
  const b = runtime(spool, 'both', H, G);
  await pass(b.inner);
  await pass(b.inner);
  assert.equal(H.postedFor('S2').length, 1, 'nothing re-posted to HINAI');
  assert.equal(G.postedFor('S2').length, 0, 'nothing old posted to GenX');
  stage(b.inner, 'S2', { TSH3: '1.5', B12: '410' });
  await pass(b.inner);
  assert.deepEqual(H.postedFor('S2').slice(1).map((r) => r.identifier), ['B12']);
  assert.deepEqual(G.postedFor('S2').map((r) => `${r.identifier}@${r.labResultId}`), ['B12@6002'], 'only the new value, to GenX');
  assert.ok(complete(b.inner.staged.get('S2')));
});

await check('B1 console: a sample complete before the switch shows nothing waiting in GenX', async () => {
  const spool = newSpool('b1-console');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('S2C', 'TSH3', 2101);
  G.add('S2C', 'TSH3', 6101);
  const a = runtime(spool, 'hinai', H, G).inner;
  stage(a, 'S2C', { TSH3: '1.5' });
  await pass(a);
  const b = runtime(spool, 'both', H, G);
  const sum = (b.rt.stagedSummaries() ?? []).find((s) => s.barcode === 'S2C') as unknown as {
    complete: boolean;
    lanes?: Array<{ lane: Lane; waiting: number }>;
  };
  assert.equal(sum.complete, true, 'complete');
  const gx = (sum.lanes ?? []).find((l) => l.lane === 'genx');
  assert.equal(gx?.waiting ?? 0, 0, `per-lane counts must not show it waiting in GenX (got ${JSON.stringify(sum.lanes)})`);
});

// =============================================================================
console.log('\n— B3: both -> single');

await check('B3 a sample held for a missing GenX lane files after a restart in single hinai', async () => {
  const spool = newSpool('b3');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('S3', 'TSH3', 3001);
  const a = runtime(spool, 'both', H, G).inner;
  stage(a, 'S3', { TSH3: '3.3' });
  await pass(a);
  assert.match(a.staged.get('S3')!.lastError ?? '', /only in HINAI/);
  assert.equal(H.posted.length, 0);
  const b = runtime(spool, 'hinai', H, G).inner;
  await pass(b);
  assert.deepEqual(H.postedFor('S3').map((r) => `${r.identifier}@${r.labResultId}`), ['TSH3@3001']);
  assert.ok(complete(b.staged.get('S3')));
});

await check('B3 a value filed in HINAI only (GenX was failing) is NOT re-posted to HINAI after switching to single hinai', async () => {
  const spool = newSpool('b3-double');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('S3D', 'TSH3', 3101);
  G.add('S3D', 'TSH3', 7101);
  G.failPost = true;
  const a = runtime(spool, 'both', H, G).inner;
  stage(a, 'S3D', { TSH3: '3.9' });
  await pass(a);
  assert.equal(H.postedFor('S3D').length, 1, 'filed in HINAI');
  assert.ok(!a.staged.get('S3D')!.values.TSH3!.filedAt, 'not done: GenX failed');
  const b = runtime(spool, 'hinai', H, G).inner;
  await pass(b);
  await pass(b);
  assert.equal(H.postedFor('S3D').length, 1, `HINAI must not be sent TSH3 a second time (got ${H.postedFor('S3D').length} posts)`);
  assert.ok(complete(b.staged.get('S3D')), `and the sample counts as complete (got ${JSON.stringify(b.staged.get('S3D'))})`);
});

await check('B3 the same, switching to single genx: GenX files it, HINAI untouched', async () => {
  const spool = newSpool('b3-genx');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('S3G', 'TSH3', 3201);
  G.add('S3G', 'TSH3', 7201);
  G.failPost = true;
  const a = runtime(spool, 'both', H, G).inner;
  stage(a, 'S3G', { TSH3: '4.0' });
  await pass(a);
  G.failPost = false;
  const b = runtime(spool, 'genx', H, G).inner;
  await pass(b);
  await pass(b);
  assert.equal(H.postedFor('S3G').length, 1, 'HINAI not posted again');
  assert.deepEqual(G.postedFor('S3G').map((r) => `${r.identifier}@${r.labResultId}`), ['TSH3@7201']);
  assert.ok(complete(b.staged.get('S3G')));
});

// =============================================================================
console.log('\n— B2: a code in only one lane');

await check('B2 TSH3 only in HINAI rows: files to HINAI, waits for GenX; File now closes it with GenX skipped', async () => {
  const spool = newSpool('b2');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('T4', 'TSH3', 4001);
  H.add('T4', 'B12', 4002);
  G.add('T4', 'B12', 8002);
  const { rt, inner } = runtime(spool, 'both', H, G);
  stage(inner, 'T4', { TSH3: '2.0', B12: '300' });
  await pass(inner);
  assert.deepEqual(sorted(H.postedFor('T4').map((r) => r.identifier)), ['B12', 'TSH3']);
  assert.deepEqual(G.postedFor('T4').map((r) => r.identifier), ['B12']);
  const s = inner.staged.get('T4')!;
  assert.ok(!s.values.TSH3!.filedAt, 'TSH3 waits for GenX');
  assert.match(s.lastError ?? '', /no order row yet/);
  assert.match(s.lastError ?? '', /TSH3/);
  const before = warns.length;
  await rt.stagedFileNow('T4');
  const after = inner.staged.get('T4')!;
  assert.equal(after.values.TSH3!.lanes?.genx?.skipped, 'operator', `TSH3 skipped in GenX by the operator (got ${JSON.stringify(after.values.TSH3!.lanes)})`);
  assert.ok(complete(after), 'the operator push ends with the sample complete');
  assert.equal(G.postedFor('T4').length, 1, 'nothing more posted to GenX');
  assert.equal(H.postedFor('T4').length, 2, 'nothing re-posted to HINAI');
  assert.ok(warns.slice(before).some((w) => w.includes('T4') && w.includes('TSH3') && /genx/i.test(w)), 'the skip is logged');
});

// =============================================================================
console.log('\n— lookup failure vs hold; File now in neither lane');

await check('a lane whose lookup fails while it has no rows: error, retried, not held', async () => {
  const spool = newSpool('lookup-fail');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('T5', 'TSH3', 5101);
  G.failLookup = true;
  const { rt, inner } = runtime(spool, 'both', H, G);
  stage(inner, 'T5', { TSH3: '1.1' });
  await pass(inner);
  const s = inner.staged.get('T5')!;
  assert.doesNotMatch(s.lastError ?? '', /only in|neither/, 'not reported as a hold');
  assert.match(s.lastError ?? '', /503/, 'the lookup error is recorded');
  const sum = (rt.stagedSummaries() ?? []).find((x) => x.barcode === 'T5') as unknown as { held?: unknown };
  assert.ok(!sum.held, 'no held block in the summary');
  assert.equal(H.posted.length + G.posted.length, 0, 'nothing posted while GenX cannot be asked');
  G.failLookup = false;
  G.add('T5', 'TSH3', 9101);
  await pass(inner);
  assert.equal(H.postedFor('T5').length, 1);
  assert.equal(G.postedFor('T5').length, 1);
  assert.ok(complete(inner.staged.get('T5')));
});

await check('File now with the tube in neither lane: stays held, nothing posted, nothing skipped', async () => {
  const spool = newSpool('neither');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  const { rt, inner } = runtime(spool, 'both', H, G);
  stage(inner, 'T5N', { TSH3: '1.1' });
  await pass(inner);
  assert.match(inner.staged.get('T5N')!.lastError ?? '', /neither/);
  await rt.stagedFileNow('T5N');
  const s = inner.staged.get('T5N')!;
  assert.match(s.lastError ?? '', /neither/);
  assert.equal(H.posted.length + G.posted.length, 0);
  assert.equal(s.values.TSH3!.lanes, undefined, 'no lane marked');
  assert.ok(!complete(s));
});

// =============================================================================
console.log('\n— restart persistence');

await check('certified GenX lines are not certified again after a restart; a failed one is retried after it', async () => {
  const spool = newSpool('certify-restart');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('C6', 'TSH3', 6601);
  G.add('C6', 'TSH3', 8601);
  H.add('C7', 'B12', 6701);
  G.add('C7', 'B12', 8701);
  G.failCertify = 0;
  const a = runtime(spool, 'both', H, G, { genxAutoCertify: true }).inner;
  stage(a, 'C6', { TSH3: '2.2' });
  await pass(a);
  assert.deepEqual(G.certified, [8601]);
  G.failCertify = 1;
  stage(a, 'C7', { B12: '500' });
  await pass(a);
  assert.deepEqual(G.certified, [8601], '8701 failed');
  const b = runtime(spool, 'both', H, G, { genxAutoCertify: true }).inner;
  await pass(b);
  await pass(b);
  assert.deepEqual(sorted(G.certified.map(String)), ['8601', '8701'], 'after restart: 8701 retried once, 8601 not repeated');
  assert.equal(H.posted.length, 2);
  assert.equal(G.posted.length, 2, 'nothing re-posted while retrying the certify');
});

await check('a held sample is still held after a restart; an operator skip stays skipped', async () => {
  const spool = newSpool('held-restart');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('H6', 'TSH3', 6801);
  G.add('K6', 'B12', 8901);
  const a = runtime(spool, 'both', H, G);
  stage(a.inner, 'H6', { TSH3: '1.0' });
  stage(a.inner, 'K6', { B12: '200' });
  await pass(a.inner);
  await a.rt.stagedFileNow('K6');
  assert.equal(a.inner.staged.get('K6')!.values.B12!.lanes?.hinai?.skipped, 'operator');
  const b = runtime(spool, 'both', H, G).inner;
  H.add('K6', 'B12', 6901); // HINAI now lists the skipped tube
  await pass(b);
  await pass(b);
  assert.match(b.staged.get('H6')!.lastError ?? '', /only in HINAI/, 'still held');
  assert.equal(H.postedFor('H6').length, 0);
  assert.equal(H.postedFor('K6').length, 0, 'the operator skip in HINAI is not undone by a restart');
  assert.ok(complete(b.staged.get('K6')));
});

// =============================================================================
console.log('\n— acknowledge failing in one lane');

await check('HINAI acknowledge fails: values stay filed there, no re-post; GenX unaffected', async () => {
  const spool = newSpool('ack-fail');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('A7', 'TSH3', 7701);
  G.add('A7', 'TSH3', 9701);
  H.failAck = true;
  const { inner } = runtime(spool, 'both', H, G);
  stage(inner, 'A7', { TSH3: '3.0' });
  await pass(inner);
  await pass(inner);
  assert.equal(H.postedFor('A7').length, 1);
  assert.equal(G.postedFor('A7').length, 1);
  assert.equal(G.acked.length, 1, 'GenX acknowledged');
  assert.ok(complete(inner.staged.get('A7')));
  assert.ok(inner.staged.get('A7')!.values.TSH3!.lanes?.hinai?.filedAt);
});

// =============================================================================
console.log('\n— queue-mode analyzer in both mode');

await check('a queue analyzer in both mode runs staged; its old queue is migrated and files to both lanes', async () => {
  const spool = newSpool('queue');
  const pending = join(spool, 'chem', 'pending');
  mkdirSync(pending, { recursive: true });
  const old = upload('Q8', { GLU: '5.5', UREA: '30' });
  writeFileSync(join(pending, 'q8-1.json'), JSON.stringify({ id: 'q8-1', createdAt: T0, attempts: 3, lastError: 'no order rows matched barcode Q8', payload: old }));
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('Q8', 'GLU', 8801);
  H.add('Q8', 'UREA', 8802);
  G.add('Q8', 'GLU', 9801);
  G.add('Q8', 'UREA', 9801);
  const port = await freePort();
  const { rt, inner } = runtime(spool, 'both', H, G, { filing: {} }, port);
  try {
    await rt.start();
    await until('the filer to be idle', () => !inner.filer.running);
    await pass(inner);
    assert.deepEqual(sorted(H.postedFor('Q8').map((r) => `${r.identifier}@${r.labResultId}`)), ['GLU@8801', 'UREA@8802']);
    assert.deepEqual(sorted(G.postedFor('Q8').map((r) => `${r.identifier}@${r.labResultId}`)), ['GLU@9801', 'UREA@9801']);
    assert.ok(complete(inner.staged.get('Q8')));
    assert.equal(rt.spoolPending().length, 0, 'the queue is empty');
  } finally {
    await rt.stop();
  }
});

// =============================================================================
console.log('\n— QC, pairing, host query, certify off');

await check('a QC sample in both mode is posted to neither lane', async () => {
  const spool = newSpool('qc');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('QC1001', 'GLU', 1);
  G.add('QC1001', 'GLU', 2);
  H.add('PT1001', 'GLU', 3);
  G.add('PT1001', 'GLU', 4);
  const { inner } = runtime(spool, 'both', H, G, { qc: { sampleIdPrefixes: ['QC'] } });
  await inner.onMessage({ protocol: 'astm', queries: [], results: [{ sampleId: 'QC1001', testCode: 'GLU', value: '5.0' }, { sampleId: 'PT1001', testCode: 'GLU', value: '6.0' }], raw: '' });
  await wait(50);
  await until('the filer to be idle', () => !inner.filer.running);
  await pass(inner);
  assert.equal(H.postedFor('QC1001').length + G.postedFor('QC1001').length, 0, 'QC posted nowhere');
  assert.equal(inner.staged.get('QC1001'), null, 'not even staged');
  assert.equal(H.postedFor('PT1001').length, 1, 'the patient sample in the same message files to HINAI');
  assert.equal(G.postedFor('PT1001').length, 1, 'and to GenX');
});

await check('U-WAM pairing + both mode: pairing hold first, then the lane hold, then files to both', async () => {
  const spool = newSpool('pairing');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('U10', 'GLU', 1001);
  H.add('U10', 'RBC', 1002);
  const { inner } = runtime(spool, 'both', H, G, { filing: { mode: 'staged', pairing: { devices: ['UC-3500', 'UF-4000'], maxWaitMs: null } } });
  stage(inner, 'U10', { GLU: 'neg' }, 'UC-3500');
  await pass(inner);
  const first = inner.staged.get('U10')!.lastError ?? '';
  assert.doesNotMatch(first, /only in|neither/, `held by the pairing first (${first})`);
  assert.ok(first.length > 0, 'held for the other instrument');
  assert.equal(H.posted.length + G.posted.length, 0);
  stage(inner, 'U10', { RBC: '2' }, 'UF-4000');
  await pass(inner);
  assert.match(inner.staged.get('U10')!.lastError ?? '', /only in HINAI/, 'then the lane hold');
  assert.equal(H.posted.length + G.posted.length, 0);
  G.add('U10', 'GLU', 2001);
  G.add('U10', 'RBC', 2001);
  await pass(inner);
  assert.deepEqual(sorted(H.postedFor('U10').map((r) => r.identifier)), ['GLU', 'RBC']);
  assert.deepEqual(sorted(G.postedFor('U10').map((r) => r.identifier)), ['GLU', 'RBC']);
  assert.ok(complete(inner.staged.get('U10')));
});

await check('ASTM host query in both mode: one reply carrying the union', async () => {
  const spool = newSpool('query');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('Q11', 'GLU', 1);
  H.add('Q11', 'CREA', 2);
  G.add('Q11', 'GLU', 3);
  G.add('Q11', 'UREA', 4);
  const { inner } = runtime(spool, 'both', H, G);
  const sent: unknown[][] = [];
  inner.link.sendOrders = async (o) => {
    sent.push(o);
  };
  await inner.answerQuery({ sampleId: 'Q11', testCodes: [], specimenIdField: 'Q11' } as HostQuery);
  assert.equal(sent.length, 1, 'one reply');
  assert.deepEqual(sorted((sent[0]![0] as { testCodes: string[] }).testCodes), ['CREA', 'GLU', 'UREA']);
  // C4: one lane down during a query — answered with the lanes that answered.
  G.failLookup = true;
  sent.length = 0;
  await inner.answerQuery({ sampleId: 'Q11', testCodes: [], specimenIdField: 'Q11' } as HostQuery);
  assert.equal(sent.length, 1, 'GenX down: still exactly one reply');
  const reply = sent[0]![0] as { testCodes: string[] } | undefined;
  assert.ok(reply, 'with an order, not the empty download');
  assert.ok(['CREA', 'GLU'].every((c) => reply.testCodes.includes(c)), `HINAI's codes are in it (${JSON.stringify(reply.testCodes)})`);
});

await check('genxAutoCertify off in both mode: no certify call ever', async () => {
  const spool = newSpool('no-certify');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('N12', 'TSH3', 1);
  G.add('N12', 'TSH3', 2);
  const { inner } = runtime(spool, 'both', H, G);
  stage(inner, 'N12', { TSH3: '1' });
  await pass(inner);
  await pass(inner);
  assert.equal(G.posted.length, 1);
  assert.equal(G.certifyCalls, 0);
});

// =============================================================================
console.log('\n— C1: wrong-row / wrong-line hazards of the upgrade');

await check('C1 a site that ran api "genx", first started in both mode: HINAI never files against the old GenX line id', async () => {
  const spool = newSpool('c1-genx-to-both');
  writeOldOrder(spool, 'R14', [['TSH3', 77001]]); // labResultId = a GenX sampleLineId
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('R14', 'TSH3', 93000014);
  G.add('R14', 'TSH3', 77001);
  const { rt, inner } = await started(spool, 'both', H, G);
  try {
    stage(inner, 'R14', { TSH3: '5.0' });
    await pass(inner);
    assert.deepEqual(H.postedFor('R14').map((r) => r.labResultId), [93000014], 'HINAI filed against its own live row only');
    assert.ok(!H.acked.some((r) => r.labResultId === 77001), 'and never acknowledged the old row');
    assert.deepEqual(G.postedFor('R14').map((r) => r.labResultId), [77001]);
  } finally {
    await rt.stop();
  }
});

await check('C1 the same site upgraded the documented way (first start single genx, then both): rows stay GenX', async () => {
  const spool = newSpool('c1-genx-then-both');
  writeOldOrder(spool, 'R14', [['TSH3', 77001]]);
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('R14', 'TSH3', 93000014);
  G.add('R14', 'TSH3', 77001);
  const first = await started(spool, 'genx', H, G);
  await first.rt.stop();
  assert.ok(diskOrder(spool, 'R14').rows.every((r) => r.source === 'genx' && r.migrated === true), 'tagged genx at the first start');
  const both = await started(spool, 'both', H, G);
  try {
    stage(both.inner, 'R14', { TSH3: '5.0' });
    await pass(both.inner);
    assert.deepEqual(H.postedFor('R14').map((r) => r.labResultId), [93000014]);
    assert.deepEqual(G.postedFor('R14').map((r) => r.labResultId), [77001]);
  } finally {
    await both.rt.stop();
  }
});

await check('C1 a HINAI site first started in single genx with genxAutoCertify: a line backed by a migrated row is never certified', async () => {
  const spool = newSpool('c1-hinai-to-genx');
  writeOldOrder(spool, 'R15', [['TSH3', 93000015]]); // a HINAI labResultId, wrongly attributed to GenX
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  G.add('R15', 'TSH3', 77015);
  const { rt, inner } = await started(spool, 'genx', H, G, { genxAutoCertify: true });
  try {
    assert.ok(diskOrder(spool, 'R15').rows.every((r) => r.migrated === true), 'migrated');
    stage(inner, 'R15', { TSH3: '5.0' });
    await pass(inner);
    await pass(inner);
    assert.ok(!G.certifyIds.includes(93000015), `GenX certify never called with the migrated row's id (calls: ${JSON.stringify(G.certifyIds)})`);
  } finally {
    await rt.stop();
  }
});

// =============================================================================
console.log('\n— C2: patient cross-check between the lanes');

await check('C2 different patient ids: held with the mismatch, nothing posted; File now and Force refused; files once they agree', async () => {
  const spool = newSpool('c2-mismatch');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('P16', 'TSH3', 1601, { mrn: 'MRN-A', FName: 'ASHA', LName: 'PATEL' });
  G.add('P16', 'TSH3', 7601, { uhid: 'UH-B', patientName: 'RAVI SHAH' });
  const { rt, inner } = runtime(spool, 'both', H, G);
  stage(inner, 'P16', { TSH3: '1.0' });
  await pass(inner);
  const MSG = /patient differs between HINAI \(MRN-A\) and GenX \(UH-B\) for this barcode — not filed; correct it in HMIS/;
  assert.match(inner.staged.get('P16')!.lastError ?? '', MSG);
  assert.equal(H.posted.length + G.posted.length, 0, 'nothing posted anywhere');
  const sum = (rt.stagedSummaries() ?? []).find((s) => s.barcode === 'P16') as unknown as { held?: { mismatch?: unknown } };
  assert.deepEqual(sum.held?.mismatch, { hinai: 'MRN-A', genx: 'UH-B' }, `held JSON carries the mismatch (${JSON.stringify(sum.held)})`);

  // A refusal may come back as a thrown error carrying the mismatch message
  // (what the admin endpoint turns into its answer) — either form is fine.
  let fileNow = '';
  try {
    await rt.stagedFileNow('P16');
  } catch (err) {
    fileNow = (err as Error).message;
  }
  if (fileNow) assert.match(fileNow, /patient differs/, `File now refuses with the mismatch message (${fileNow})`);
  assert.equal(H.posted.length + G.posted.length, 0, 'File now does not override a mismatch');
  assert.match(inner.staged.get('P16')!.lastError ?? '', MSG);
  let forced = '';
  try {
    forced = JSON.stringify(await rt.stagedForce('P16'));
  } catch (err) {
    forced = (err as Error).message;
  }
  assert.match(forced, /patient differs/, `Force refuses with the mismatch message (${forced})`);
  assert.equal(H.posted.length + G.posted.length, 0, 'Force posted nothing');

  // HMIS corrects GenX (same id, other case / spacing); the next poll brings it.
  G.rows = G.rows.map((r) => (r.sampleID === 'P16' ? { ...r, uhid: ' mrn-a ' } : r));
  await (inner as unknown as { pollOrders(): Promise<void> }).pollOrders();
  await until('the filer to be idle', () => !inner.filer.running);
  await pass(inner);
  assert.deepEqual(H.postedFor('P16').map((r) => r.labResultId), [1601], 'files to HINAI once the ids agree');
  assert.deepEqual(G.postedFor('P16').map((r) => r.labResultId), [7601], 'and to GenX');
  assert.ok(complete(inner.staged.get('P16')));
});

await check('C2 one lane gives no patient id: no check, files to both', async () => {
  const spool = newSpool('c2-missing');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('P17', 'TSH3', 1701, { mrn: 'MRN-A' });
  G.add('P17', 'TSH3', 7701);
  const { inner } = runtime(spool, 'both', H, G);
  stage(inner, 'P17', { TSH3: '1.0' });
  await pass(inner);
  assert.equal(H.postedFor('P17').length, 1);
  assert.equal(G.postedFor('P17').length, 1);
  assert.ok(complete(inner.staged.get('P17')));
});

await check('C2 same id, different case and spacing: no mismatch', async () => {
  const spool = newSpool('c2-same');
  const H = new FakeLane('hinai');
  const G = new FakeLane('genx');
  H.add('P18', 'TSH3', 1801, { mrn: 'uh10032026' });
  G.add('P18', 'TSH3', 7801, { uhid: ' UH10032026 ' });
  const { inner } = runtime(spool, 'both', H, G);
  stage(inner, 'P18', { TSH3: '1.0' });
  await pass(inner);
  assert.ok(complete(inner.staged.get('P18')), inner.staged.get('P18')!.lastError ?? '');
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${risks.length} risk(s) noted`);
if (failures) {
  console.error(`lanes-edge-runtime: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('lanes-edge-runtime: all checks passed');
process.exit(0);
