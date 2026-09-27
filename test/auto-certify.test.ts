// =============================================================================
// Auto Certify self-test.
//
// Runs the port of the old Certify_Results service against a fake HIS database
// and a fake portal. No Oracle and no network are needed. It checks:
//
//   1. SQL       every config value is a bind variable, and the IN lists and
//                optional clauses come out as configured.
//   2. RUN       the old AutoCertify.cs flow, read from its IL: a whole result
//                is certified by labresultid. A result with parameters waits
//                while any of the equipment's parameters is still in
//                parameterResultStatus. Once none is, EVERY parameter row of
//                the result is certified by labparameterresultid.
//   3. LOG       the day log gets run-started / run-completed lines and one
//                line per call, like the old AutoCertify_yyyyMMdd.log.
//   4. FAILURES  a non-2xx answer and a transport error are both recorded as
//                failed, and the run carries on with the next result.
//   5. GUARDS    disabled config refuses to run; a run in progress refuses a
//                second one; the config schema demands the settings once
//                enabled.
//
// Run: npx tsx test/auto-certify.test.ts
// =============================================================================
import assert from 'node:assert/strict';
import { AutoCertifyService, type CertifyTransport } from '../src/autocertify/service.js';
import { buildAllParametersQuery, buildBlockingParametersQuery, buildResultsQuery, isYes, type CertifyCandidate, type CertifySource } from '../src/autocertify/source.js';
import type { AutoCertifyConfig } from '../src/config.js';
import { logger } from '../src/logger.js';

let checks = 0;
async function check(what: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  checks++;
  console.log(`  ok  ${what}`);
}

const silent = logger.child({ mod: 'test' });
silent.level = 'silent';

function cfg(over: Partial<AutoCertifyConfig> = {}): AutoCertifyConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    baseUrl: 'http://his.test:8050/',
    certifyPath: '/live/portal/labresult/autocertify',
    timeoutMs: 1000,
    siteId: '2',
    equipmentIds: ['46150218', '46150219'],
    resultStatus: ['13391860', '303'],
    parameterResultStatus: ['1108'],
    lookbackDays: 2,
    requireHod: true,
    oracle: { user: 'u', password: 'p', connectString: 'h:1/s' },
    logFile: null,
    historySize: 300,
    ...over,
  };
}

function candidate(id: string, hasParameter: boolean): CertifyCandidate {
  return {
    labResultId: id,
    resultStatus: '303',
    interfacedValue: '1',
    acceptedDate: null,
    equipmentId: '46150218',
    hasParameter,
    labOrderId: 'O' + id,
    sampleId: 'S' + id,
    labServiceId: 'L' + id,
    autoCertifyLab: 'Y',
  };
}

class FakeSource implements CertifySource {
  closed = 0;
  /** params: every parameter row of a result. blocking: those still in parameterResultStatus. */
  constructor(
    private readonly results: CertifyCandidate[],
    private readonly params: Record<string, string[]>,
    private readonly blocking: Record<string, string[]> = {},
  ) {}
  async pendingResults() {
    return this.results;
  }
  async blockingParameters(id: string) {
    return this.blocking[id] ?? [];
  }
  async allParameters(id: string) {
    return this.params[id] ?? [];
  }
  async close() {
    this.closed++;
  }
}

class FakePortal implements CertifyTransport {
  calls: string[] = [];
  constructor(private readonly answer: (url: string) => { status: number; body: string } | Error) {}
  async get(url: string) {
    this.calls.push(url);
    const a = this.answer(url);
    if (a instanceof Error) throw a;
    return a;
  }
}

// -----------------------------------------------------------------------------
console.log('\nSQL');

await check('results query binds site, equipment, status and window', () => {
  const { sql, binds } = buildResultsQuery(cfg());
  assert.match(sql, /LR\.siteid = :siteId/);
  assert.match(sql, /ES\.equipmentid in \(:eq0, :eq1\)/);
  assert.match(sql, /LR\.result_status in \(:rs0, :rs1\)/);
  assert.match(sql, /HD\.hod_id is not null/);
  // The newest source selects these two; they are carried for display, never filtered on.
  assert.match(sql, /LM\.lab_service_id,\s+LM\.autocertifylab/);
  assert.doesNotMatch(sql, /autocertifylab\s*=/i);
  assert.match(sql, /trunc\(sysdate\) - :lookback/);
  assert.deepEqual(binds, { siteId: '2', lookback: 2, eq0: '46150218', eq1: '46150219', rs0: '13391860', rs1: '303' });
  // No config value is ever pasted into the SQL text.
  for (const v of ['46150218', '13391860', '303']) assert.ok(!sql.includes(v), `${v} leaked into the SQL`);
});

await check('requireHod false drops the HOD clause', () => {
  assert.doesNotMatch(buildResultsQuery(cfg({ requireHod: false })).sql, /hod_id/);
});

await check('blocking-parameter query: this equipment, still in a parameter status', () => {
  const { sql, binds } = buildBlockingParametersQuery(cfg(), '555');
  assert.match(sql, /inner join equipmentservice ES on ES\.parameterid = LRP\.parameter_id/);
  assert.match(sql, /LRP\.lab_result_id = :resultId/);
  assert.match(sql, /LRP\.parameterresultstatus in \(:ps0\)/);
  assert.deepEqual(binds, { resultId: '555', eq0: '46150218', eq1: '46150219', ps0: '1108' });
});

await check('all-parameters query: every row of the result, unfiltered', () => {
  const { sql, binds } = buildAllParametersQuery('555');
  assert.equal(sql, 'select LRP.lab_result_parameter_id from labresultparameter LRP where LRP.lab_result_id = :resultId');
  assert.deepEqual(binds, { resultId: '555' });
});

await check('ithasparameter is "Y" exactly, as the old service compared it', () => {
  for (const y of ['Y', ' Y ']) assert.equal(isYes(y), true, String(y));
  for (const n of ['y', '1', 1, 'TRUE', 'N', '0', null, undefined, '']) assert.equal(isYes(n), false, String(n));
});

// -----------------------------------------------------------------------------
console.log('\nrun');

await check('whole result; finished parameter result; unfinished one waits', async () => {
  const source = new FakeSource(
    [candidate('100', false), candidate('200', true), candidate('300', true)],
    { '200': ['2001', '2002'], '300': ['3001', '3002'] },
    { '300': ['3002'] }, // 3002 is still in 1108: result 300 is not finished
  );
  const portal = new FakePortal(() => ({ status: 200, body: '{"status":"success"}' }));
  const svc = new AutoCertifyService(cfg(), silent, { source: () => source, transport: portal });
  const run = await svc.runNow();

  assert.deepEqual(portal.calls, [
    'http://his.test:8050/live/portal/labresult/autocertify?labresultid=100',
    'http://his.test:8050/live/portal/labresult/autocertify?labparameterresultid=2001',
    'http://his.test:8050/live/portal/labresult/autocertify?labparameterresultid=2002',
  ]);
  assert.equal(run.found, 3);
  assert.equal(run.certified, 3);
  assert.equal(run.failed, 0);
  assert.equal(run.waiting, 1);
  assert.equal(run.error, null);
  assert.equal(source.closed, 1, 'the connection is closed after the run');

  const h = svc.history();
  assert.equal(h.length, 3);
  assert.equal(h[0]!.labResultParameterId, '2002', 'newest first');
  assert.equal(h[2]!.kind, 'result');
  assert.equal(h[2]!.sampleId, 'S100');
  assert.equal(h[2]!.labServiceId, 'L100');
  assert.equal(svc.snapshot().totals.certified, 3);
});

await check('a failed call is recorded and the run carries on', async () => {
  const source = new FakeSource([candidate('1', false), candidate('2', false), candidate('3', false)], {});
  const portal = new FakePortal((url) =>
    url.endsWith('=1') ? { status: 500, body: 'boom' } : url.endsWith('=2') ? new Error('ECONNREFUSED') : { status: 200, body: 'ok' },
  );
  const svc = new AutoCertifyService(cfg(), silent, { source: () => source, transport: portal });
  const run = await svc.runNow();
  assert.equal(portal.calls.length, 3);
  assert.equal(run.certified, 1);
  assert.equal(run.failed, 2);
  const [third, second, first] = svc.history();
  assert.equal(first!.ok, false);
  assert.equal(first!.httpStatus, 500);
  assert.equal(second!.ok, false);
  assert.equal(second!.httpStatus, null);
  assert.equal(second!.response, 'ECONNREFUSED');
  assert.equal(third!.ok, true);
});

await check('a database error ends the run with the error and still closes', async () => {
  const source = new FakeSource([], {});
  source.pendingResults = async () => {
    throw new Error('ORA-12541: no listener');
  };
  const svc = new AutoCertifyService(cfg(), silent, { source: () => source, transport: new FakePortal(() => ({ status: 200, body: '' })) });
  const run = await svc.runNow();
  assert.equal(run.error, 'ORA-12541: no listener');
  assert.equal(source.closed, 1);
});

await check('preview reads but never calls the portal', async () => {
  const source = new FakeSource([candidate('7', true), candidate('8', true), candidate('9', false)], { '7': ['71', '72'], '8': ['81'] }, { '8': ['81'] });
  const portal = new FakePortal(() => ({ status: 200, body: '' }));
  const svc = new AutoCertifyService(cfg(), silent, { source: () => source, transport: portal });
  const { candidates } = await svc.preview();
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates[0]!.parameterIds, ['71', '72']);
  assert.deepEqual(candidates[0]!.blockingParameterIds, []);
  assert.deepEqual(candidates[1]!.blockingParameterIds, ['81'], 'result 8 waits');
  assert.deepEqual(candidates[1]!.parameterIds, []);
  assert.equal(candidates[2]!.parameterIds, null, 'whole result');
  assert.equal(portal.calls.length, 0);
});

await check('day log: run start, each call, run end', async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'autocert-log-'));
  const source = new FakeSource([candidate('1', false)], {});
  const svc = new AutoCertifyService(cfg({ logFile: join(dir, 'autocertify.log') }), silent, {
    source: () => source,
    transport: new FakePortal(() => ({ status: 200, body: 'done' })),
  });
  await svc.runNow();
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^autocertify-\d{4}-\d{2}-\d{2}\.log$/);
  const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event ?? l.kind), ['run-started', 'result', 'run-completed']);
  assert.equal(lines[1].url, 'http://his.test:8050/live/portal/labresult/autocertify?labresultid=1');
  assert.equal(lines[1].response, 'done');
  assert.equal(lines[2].certified, 1);
});

// -----------------------------------------------------------------------------
console.log('\nguards');

await check('disabled refuses run and preview', async () => {
  const svc = new AutoCertifyService(cfg({ enabled: false }), silent, {
    source: () => new FakeSource([], {}),
    transport: new FakePortal(() => ({ status: 200, body: '' })),
  });
  await assert.rejects(svc.runNow(), /disabled/);
  await assert.rejects(svc.preview(), /disabled/);
});

await check('a second run while one is going is refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const source = new FakeSource([candidate('1', false)], {});
  const portal: CertifyTransport = {
    async get() {
      await gate;
      return { status: 200, body: '' };
    },
  };
  const svc = new AutoCertifyService(cfg(), silent, { source: () => source, transport: portal });
  const first = svc.runNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.snapshot().running, true);
  await assert.rejects(svc.runNow(), /already in progress/);
  release();
  assert.equal((await first).certified, 1);
});

await check('the schema demands the settings once enabled, and ids must be numeric', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../src/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'autocert-'));
  const base = {
    hmis: { baseUrl: 'http://127.0.0.1:1' },
    analyzers: [{ id: 'a', equipmentCode: 'X1', protocol: 'astm', transport: { type: 'tcp', mode: 'server', port: 2999 } }],
  };
  const file = join(dir, 'c.json');

  writeFileSync(file, JSON.stringify(base));
  assert.equal(loadConfig(file).autoCertify.enabled, false, 'absent block = disabled');

  writeFileSync(file, JSON.stringify({ ...base, autoCertify: { enabled: true } }));
  assert.throws(() => loadConfig(file), /autoCertify\.baseUrl[\s\S]*autoCertify\.oracle\.password/);

  writeFileSync(file, JSON.stringify({ ...base, autoCertify: { equipmentIds: ['1; drop table x'] } }));
  assert.throws(() => loadConfig(file), /numeric id/);
});

await check('Auto-Certify-only mode: no analyzers and no hmis block', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../src/config.js');
  const file = join(mkdtempSync(join(tmpdir(), 'autocert-only-')), 'c.json');
  const ac = {
    enabled: true,
    baseUrl: 'http://his.test:8050',
    siteId: '2',
    equipmentIds: ['46150218'],
    resultStatus: ['303'],
    parameterResultStatus: ['1108'],
    oracle: { user: 'u', password: 'p', connectString: 'h:1/s' },
  };

  writeFileSync(file, JSON.stringify({ autoCertify: ac }));
  const c = loadConfig(file);
  assert.deepEqual(c.analyzers, []);
  assert.equal(c.hmis.baseUrl, '');

  writeFileSync(file, JSON.stringify({ autoCertify: ac, analyzers: [] }));
  assert.equal(loadConfig(file).analyzers.length, 0, 'an explicit empty list is fine too');

  // Neither analyzers nor Auto Certify: nothing to run.
  writeFileSync(file, JSON.stringify({ autoCertify: { ...ac, enabled: false } }));
  assert.throws(() => loadConfig(file), /at least one analyzer, or enable autoCertify/);

  // Analyzers still need the HMIS gateway.
  writeFileSync(
    file,
    JSON.stringify({
      autoCertify: ac,
      analyzers: [{ id: 'a', equipmentCode: 'X1', protocol: 'astm', transport: { type: 'tcp', mode: 'server', port: 2999 } }],
    }),
  );
  assert.throws(() => loadConfig(file), /hmis\.baseUrl: required when analyzers are configured/);
});

console.log(`\n${checks} checks passed\n`);
