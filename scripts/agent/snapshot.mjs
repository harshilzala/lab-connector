#!/usr/bin/env node
// =============================================================================
// snapshot — one compact JSON picture of the ECiQ and the 250, for the agent.
//
// Everything the agent reasons about comes from here, so it never has to grep
// a 40 MB log itself. Read-only. Cheap: tails the logs, lists the spool, and
// makes ONE small HMIS call to prove the gateway answers.
//
//   node scripts/agent/snapshot.mjs            # JSON on stdout
//   node scripts/agent/snapshot.mjs --hours 3  # window (default 2)
// =============================================================================
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ANALYZERS = ['vitros-eciq', 'vitros-250'];
const LOGS = join(ROOT, 'logs');
const SPOOL = join(ROOT, 'spool');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

/** Last `bytes` of a file, split into lines (first partial line dropped). */
function tailLines(file, bytes = 3 * 1024 * 1024) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

const jsonAt = (line) => {
  const i = line.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(line.slice(i)); } catch { return null; }
};

/** Strip the volatile bits so identical faults collapse to one line. */
const dedupeKey = (o) =>
  `${o.analyzer}|${o.msg}|${(o.err || '').replace(/SF\d{10}|[A-Z]{2}\d{10}/g, 'SF#').replace(/\d+ms/g, 'Nms').slice(0, 90)}`;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function pm2Status() {
  try {
    // shell: pm2 is a .cmd shim on Windows, and Node 22 refuses to spawn one
    // without a shell (EINVAL).
    const out = execFileSync('pm2', ['jlist'], {
      env: { ...process.env, PM2_HOME: join(ROOT, '.pm2') },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    const list = JSON.parse(out.slice(out.indexOf('[')));
    const app = list.find((a) => a.name === 'Lab-Interface');
    if (!app) return { registered: false };
    return {
      registered: true,
      status: app.pm2_env.status,
      pid: app.pid,
      restarts: app.pm2_env.restart_time,
      upSince: app.pm2_env.pm_uptime ? new Date(app.pm2_env.pm_uptime).toISOString() : null,
    };
  } catch (e) {
    return { registered: null, error: String(e.message || e).slice(0, 120) };
  }
}

function appLog(sinceMs) {
  const per = Object.fromEntries(ANALYZERS.map((a) => [a, {
    link: { lastConnectedAt: null, lastOfflineAt: null, lastOfflineWhy: null },
    ordersDownloaded: 0,
    orderPollFailures: 0,
    resultMessages: 0,
    resultsFiled: { samples: 0, values: 0 },
    cannotFile: 0,
    parked: 0,
    faults: {},
  }]));
  let appStartedAt = null;
  for (const line of tailLines(join(LOGS, 'lab-interface.out.log'))) {
    const o = jsonAt(line);
    if (!o || !o.time || o.time < sinceMs) continue;
    if (o.msg === 'admin dashboard listening') appStartedAt = new Date(o.time).toISOString();
    const a = per[o.analyzer];
    if (!a) continue;
    const at = new Date(o.time).toISOString();
    switch (o.msg) {
      case 'analyzer connected': a.link.lastConnectedAt = at; break;
      case 'order downloaded to analyzer': a.ordersDownloaded++; break;
      case 'results filed to HMIS': a.resultsFiled.samples++; a.resultsFiled.values += o.filed || 0; break;
      case 'VITROS 250 result file received': a.resultMessages++; break;
      case 'spool item parked in failed/': a.parked++; break;
      default:
        if (/no pending order row/.test(o.msg || '')) a.cannotFile++;
        if (/order poll failed/.test(o.msg || '')) a.orderPollFailures++;
        if (/disconnect|link (is )?down|connect(ion)? (failed|refused|reset)|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(`${o.msg} ${o.err || ''}`)) {
          a.link.lastOfflineAt = at;
          a.link.lastOfflineWhy = (o.err || o.msg || '').slice(0, 120);
        }
    }
    if (o.level >= 40 && !/spool delivery failed|no pending order row/.test(o.msg || '')) {
      const k = dedupeKey(o);
      a.faults[k] ??= { count: 0, lastAt: at, sample: `${o.msg}${o.err ? ' — ' + String(o.err).slice(0, 140) : ''}` };
      a.faults[k].count++;
      a.faults[k].lastAt = at;
    }
  }
  for (const a of Object.values(per)) a.faults = Object.values(a.faults).sort((x, y) => y.count - x.count).slice(0, 8);
  return { appStartedAt, per };
}

function wireLog(analyzer, sinceMs) {
  const out = { inbound: 0, outbound: 0, lastInboundAt: null, lastOutboundAt: null, inboundSamples: [] };
  const files = existsSync(LOGS)
    ? readdirSync(LOGS).filter((f) => f.startsWith(`wire-${analyzer}-`) && f.endsWith('.log') && statSync(join(LOGS, f)).mtimeMs >= sinceMs)
    : [];
  for (const f of files) {
    for (const line of tailLines(join(LOGS, f), 1024 * 1024)) {
      const o = jsonAt(line);
      if (!o || !o.at || Date.parse(o.at) < sinceMs) continue;
      if (o.direction === 'IN') {
        out.inbound++;
        out.lastInboundAt = o.at;
        const ids = analyzer === 'vitros-250'
          ? [...o.text.matchAll(/\]?\s*(?:\d{10})[^\]]{15}([A-Za-z0-9 ]{15})/g)].map((m) => m[1].trim())
          : [...o.text.matchAll(/O\|\d+\|([^|^]+)/g)].map((m) => m[1].trim());
        for (const id of ids) if (id && !out.inboundSamples.includes(id)) out.inboundSamples.push(id);
      } else {
        out.outbound++;
        out.lastOutboundAt = o.at;
      }
    }
  }
  out.inboundSamples = out.inboundSamples.slice(-30);
  return out;
}

function hmisLog(sinceMs) {
  const codes = { ZYCAPIFC01: 'vitros-eciq', ZHFC01: 'vitros-eciq', ZHFC02: 'vitros-250' };
  const out = { postsFiled: {}, postsOther: {}, errors: { timedOut: 0, http5xx: 0, other: 0, lastAt: null }, calls: 0 };
  const files = existsSync(LOGS)
    ? readdirSync(LOGS).filter((f) => /^hmis-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f) && statSync(join(LOGS, f)).mtimeMs >= sinceMs)
    : [];
  for (const f of files) {
    for (const line of tailLines(join(LOGS, f), 4 * 1024 * 1024)) {
      const o = jsonAt(line);
      if (!o || !o.ts || Date.parse(o.ts) < sinceMs) continue;
      const a = codes[o.eqCode];
      if (!a) continue;
      out.calls++;
      if (o.kind === 'result') {
        const bucket = o.outcome === 'filed' ? out.postsFiled : out.postsOther;
        bucket[a] ??= [];
        for (const id of [].concat(o.sampleId)) bucket[a].push(o.outcome === 'filed' ? id : `${id}:${o.outcome}/${o.httpStatus}`);
      }
      if (o.outcome === 'error') {
        const e = String(o.error || '');
        if (/timed out/.test(e)) out.errors.timedOut++;
        else if (/HTTP 5\d\d/.test(e)) out.errors.http5xx++;
        else out.errors.other++;
        out.errors.lastAt = o.ts;
      }
    }
  }
  for (const b of [out.postsFiled, out.postsOther]) for (const k of Object.keys(b)) b[k] = [...new Set(b[k])].slice(-40);
  return out;
}

function spoolState(analyzer) {
  const base = join(SPOOL, analyzer);
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  const failed = list(join(base, 'failed')).map((f) => {
    const o = readJson(join(base, 'failed', f)) || {};
    return { id: f.replace(/\.json$/, ''), createdAt: o.createdAt, attempts: o.attempts, lastError: (o.lastError || '').slice(0, 140), codes: (o.payload?.results || []).map((r) => r.testCode).slice(0, 12) };
  });
  const pending = list(join(base, 'pending')).map((f) => {
    const o = readJson(join(base, 'pending', f)) || {};
    return { id: f.replace(/\.json$/, ''), createdAt: o.createdAt, attempts: o.attempts, lastError: (o.lastError || '').slice(0, 140) };
  });
  // Staged store (ECiQ): one file per sample. Field names follow
  // src/results/store.ts; anything missing is simply omitted.
  const staged = list(join(base, 'results')).map((f) => {
    const o = readJson(join(base, 'results', f)) || {};
    const vals = o.values || o.results || [];
    const count = (st) => vals.filter((v) => v.status === st || v.state === st).length;
    return {
      barcode: o.barcode || f.replace(/\.json$/, ''),
      updatedAt: o.updatedAt, attempts: o.attempts, lastError: (o.lastError || '').slice(0, 140),
      total: vals.length, filed: o.filed ?? count('filed'), waiting: o.waiting ?? count('waiting'),
      waitingCodes: (o.waitingCodes || vals.filter((v) => (v.status || v.state) === 'waiting').map((v) => v.code || v.testCode)).slice(0, 12),
    };
  }).filter((s) => s.waiting > 0 || s.lastError).slice(-40);
  return { pending, failed: failed.slice(-40), staged, orders: list(join(base, 'orders')).length };
}

async function hmisProbe() {
  const cfg = readJson(join(ROOT, 'config.json')) ?? null;
  // config.json is JSONC; fall back to the known gateway if the strict parse fails.
  const base = cfg?.hmis?.baseUrl || 'https://hims.zhhrpl.in/live/portal';
  const site = cfg?.hmis?.siteId || '9246332';
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const url = `${base.replace(/\/$/, '')}/mirth/pending?eqCode=ZHFC02&siteId=${site}&date=${date}`;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let rows = null;
    try { rows = (JSON.parse(text).data || []).length; } catch { /* not json */ }
    return { ok: res.ok, httpStatus: res.status, ms: Date.now() - t0, pendingRowsToday250: rows };
  } catch (e) {
    return { ok: false, httpStatus: null, ms: Date.now() - t0, error: String(e.name === 'AbortError' ? 'timed out after 12000ms' : e.message).slice(0, 120) };
  }
}

export async function snapshot(hours = Number(arg('hours', '2'))) {
  const sinceMs = Date.now() - hours * 3600_000;
  const app = appLog(sinceMs);
  const hmis = hmisLog(sinceMs);
  const analyzers = {};
  for (const a of ANALYZERS) {
    analyzers[a] = {
      ...app.per[a],
      wire: wireLog(a, sinceMs),
      hmisPosts: { filed: hmis.postsFiled[a] || [], other: hmis.postsOther[a] || [] },
      spool: spoolState(a),
    };
  }
  return {
    takenAt: new Date().toISOString(),
    windowHours: hours,
    maintenanceFlag: existsSync(join(ROOT, '.lab-maintenance')),
    pm2: pm2Status(),
    appStartedAt: app.appStartedAt,
    hmisProbe: await hmisProbe(),
    hmisGateway: { callsInWindow: hmis.calls, errors: hmis.errors },
    analyzers,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  snapshot().then((s) => process.stdout.write(JSON.stringify(s, null, 1) + '\n'));
}
