import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Connector } from '../src/connector.js';

// =============================================================================
// HMIS lanes — which audit file each lane writes (spec 1a / 2, scenario 2).
//
//   single hinai                 => hmis-<date>.log only
//   both                         => hinai in hmis-<date>.log, genx in hmis-genx-<date>.log
//   genx is the only lane in the process => genx in hmis-<date>.log, as today
//   mixed process (one analyzer hinai, one genx) => genx in hmis-genx-<date>.log
//
// Four real Connectors are started from config files, side by side, against
// one stand-in HINAI gateway and one stand-in GenX gateway. The first order
// poll (5 s after start) is what writes the entries.
//
// Run: npx tsx test/lanes-logs.test.ts
// =============================================================================

const quiet = { child: () => quiet, info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, level: 'silent' } as any;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await wait(100);
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

const dir = mkdtempSync(join(tmpdir(), 'lanes-logs-'));
process.env.LAB_CONNECTOR_ENV = join(dir, 'no.env');
for (const k of ['HMIS_BASE_URL', 'GENX_CLIENT_ID', 'GENX_CLIENT_SECRET', 'GENX_API_KEY']) delete process.env[k];
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'Lanes@2026';

// ---- stand-in HINAI ----------------------------------------------------------
const hinaiPort = await freePort();
const hinaiBase = `http://127.0.0.1:${hinaiPort}/portal`;
const hinai = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/portal/mirth/pending') {
      return res.end(
        JSON.stringify({
          status: 'success',
          data: [{ SampleID: 'LB2610110001', eqIdntifier: 'GLU', equipmentCode: url.searchParams.get('eqCode'), labResultId: 1, labServiceId: 1, parameterId: 1 }],
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => hinai.listen(hinaiPort, '127.0.0.1', () => r()));

// ---- stand-in GenX -----------------------------------------------------------
const genxPort = await freePort();
const genxBase = `http://127.0.0.1:${genxPort}`;
const envelope = (data: unknown) =>
  JSON.stringify({ success: true, correlationId: 'x', timestamp: 't', data: { success: true, message: 'ok', timestamp: 't', data } });
const genx = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/auth-service/api/oauth/token') {
      return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (url.pathname === '/integration-service/external/v1/lab/equipment/worklist') {
      const tube = {
        accessionNumber: 'ACC1',
        sampleNumber: 'GX2610110001',
        status: 'ACCEPTED',
        priority: 'ROUTINE',
        specimenName: 'Serum',
        patient: { uhid: 'UH1', name: 'Test', genderCode: 'F', dateOfBirth: '1990-01-01' },
        tests: [{ sampleLineId: '190001', serviceId: '1', serviceCode: 'GLU', serviceName: 'Glucose', lineStatus: 'PENDING' }],
      };
      return res.end(envelope({ content: [tube], page: 0, size: 200, totalElements: 1 }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => genx.listen(genxPort, '127.0.0.1', () => r()));

// ---- four connectors ---------------------------------------------------------
type Run = { name: string; logs: string; connector: Connector };
const analyzer = async (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  equipmentCode: code,
  transport: { type: 'tcp', mode: 'server', host: '127.0.0.1', port: await freePort() },
  hostQuery: false,
  orderPoll: { enabled: true, intervalMs: 60000, lookbackDays: 0, download: false },
  ...extra,
});
async function start(name: string, hmis: Record<string, unknown>, analyzers: unknown[]): Promise<Run> {
  const root = join(dir, name);
  const logs = join(root, 'logs');
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      logLevel: 'error',
      spoolDir: join(root, 'spool'),
      hmis: {
        auditLog: join(logs, 'hmis.log'),
        ...hmis,
        hinai: { baseUrl: hinaiBase, siteIds: [] },
        genx: {
          baseUrl: genxBase,
          clientId: 'cid',
          clientSecret: 'secret',
          auditLog: join(logs, 'hmis-genx.log'),
          accessionCacheFile: join(root, 'genx-acc.json'),
        },
      },
      retention: { days: 7, logDays: 30, sweepIntervalHours: 6, logDir: logs, includeSpoolPending: true },
      admin: { host: '127.0.0.1', port: await freePort(), authFile: join(root, 'admin-auth.json') },
      autoCertify: { enabled: false, logFile: null },
      analyzers,
    }),
  );
  const connector = new Connector(loadConfig(file), quiet);
  await connector.start();
  return { name, logs, connector };
}

const files = (d: string) => (existsSync(d) ? readdirSync(d) : []);
const hinaiFiles = (d: string) => files(d).filter((f) => /^hmis-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f));
const genxFiles = (d: string) => files(d).filter((f) => /^hmis-genx-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f));
const entries = (d: string, list: string[]) =>
  list.flatMap((f) =>
    readFileSync(join(d, f), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { url: string; kind: string }),
  );

const runs: Run[] = [];
let failed = false;
try {
  const single = await start('single-hinai', { mode: 'single', use: 'hinai' }, [await analyzer('a1', 'EQL1')]);
  const both = await start('both', { mode: 'both' }, [await analyzer('a1', 'EQL1')]);
  const genxOnly = await start('genx-only', { mode: 'single', use: 'genx' }, [await analyzer('a1', 'EQL1')]);
  const mixed = await start('mixed', { mode: 'single', use: 'hinai' }, [
    await analyzer('a1', 'EQL1'),
    await analyzer('a2', 'EQL2', { hmis: { mode: 'single', use: 'genx' } }),
  ]);
  runs.push(single, both, genxOnly, mixed);

  // ---- single hinai -----------------------------------------------------------
  await until('single hinai: a query entry in hmis-<date>.log', () => entries(single.logs, hinaiFiles(single.logs)).some((e) => e.kind === 'query'));
  {
    const e = entries(single.logs, hinaiFiles(single.logs));
    assert.ok(e.every((x) => x.url.startsWith(hinaiBase)), 'every entry is a HINAI call');
    assert.deepEqual(genxFiles(single.logs), [], 'no hmis-genx file in a hinai-only process');
    console.log('✓ single hinai: hmis-<date>.log only');
  }

  // ---- both -------------------------------------------------------------------
  await until('both: a hinai query entry', () => entries(both.logs, hinaiFiles(both.logs)).some((e) => e.kind === 'query'));
  await until('both: a genx query entry', () => entries(both.logs, genxFiles(both.logs)).some((e) => e.kind === 'query'));
  {
    const h = entries(both.logs, hinaiFiles(both.logs));
    const g = entries(both.logs, genxFiles(both.logs));
    assert.ok(h.every((x) => x.url.startsWith(hinaiBase)), `hmis-<date>.log holds HINAI calls only (${h.map((x) => x.url).join(', ')})`);
    assert.ok(g.every((x) => x.url.startsWith(genxBase)), `hmis-genx-<date>.log holds GenX calls only (${g.map((x) => x.url).join(', ')})`);
    console.log('✓ both: hinai -> hmis-<date>.log, genx -> hmis-genx-<date>.log, nothing crossed over');
  }

  // ---- genx is the only lane in the process ------------------------------------
  await until('genx-only: a query entry in hmis-<date>.log', () => entries(genxOnly.logs, hinaiFiles(genxOnly.logs)).some((e) => e.kind === 'query'));
  {
    const e = entries(genxOnly.logs, hinaiFiles(genxOnly.logs));
    assert.ok(e.every((x) => x.url.startsWith(genxBase)), 'the GenX calls are in hmis-<date>.log');
    assert.deepEqual(genxFiles(genxOnly.logs), [], 'hmis.genx.auditLog is not used when GenX is the only lane');
    console.log('✓ genx-only process: GenX keeps writing hmis-<date>.log, exactly as today');
  }

  // ---- mixed: one analyzer per lane --------------------------------------------
  await until('mixed: a hinai query entry', () => entries(mixed.logs, hinaiFiles(mixed.logs)).some((e) => e.kind === 'query'));
  await until('mixed: a genx query entry', () => entries(mixed.logs, genxFiles(mixed.logs)).some((e) => e.kind === 'query'));
  {
    const h = entries(mixed.logs, hinaiFiles(mixed.logs));
    const g = entries(mixed.logs, genxFiles(mixed.logs));
    assert.ok(h.every((x) => x.url.startsWith(hinaiBase)));
    assert.ok(g.every((x) => x.url.startsWith(genxBase)));
    console.log('✓ mixed process (hinai analyzer + genx analyzer): GenX goes to hmis-genx-<date>.log');
  }
} catch (err) {
  failed = true;
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)));
} finally {
  for (const r of runs) await r.connector.stop().catch(() => {});
  await new Promise<void>((r) => hinai.close(() => r()));
  await new Promise<void>((r) => genx.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error('\nlanes-logs: FAILED');
  process.exit(1);
}
console.log('\nlanes-logs: all checks passed');
process.exit(0);
