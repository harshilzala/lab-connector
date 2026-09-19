#!/usr/bin/env node
// =============================================================================
// act — the ONLY way the watch agent changes anything. Five commands, each
// guarded, each written to the audit log. Nothing else is reachable from the
// agent: no file edits, no pm2, no config.
//
//   node scripts/agent/act.mjs hmis-pending <barcode> <eqCode>
//   node scripts/agent/act.mjs requeue <analyzerId> <spoolId>
//   node scripts/agent/act.mjs restart-connector "<reason>"
//   node scripts/agent/act.mjs alert "<text>"
//   node scripts/agent/act.mjs note "<text>"
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ANALYZERS } from './snapshot.mjs';

const STATE_DIR = join(ROOT, 'scripts', 'agent', 'state');
const NOTES = join(STATE_DIR, 'NOTES.md');
const ALERTS = join(ROOT, 'logs', 'agent-alerts.log');
const RESTART_STAMP = join(STATE_DIR, 'last-restart.json');
const RESTART_COOLDOWN_MS = 30 * 60_000;
/** Ids that are never patient tubes — a requeue of one of these is refused. */
const CONTROL_ID = /^(g?2905|231192|240684|known|known psa|sunitaben|psa|\d{1,6})(-|$)/i;

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(ROOT, 'logs'), { recursive: true });

export function watchLogPath(d = new Date()) {
  return join(ROOT, 'logs', `agent-watch-${d.toISOString().slice(0, 10)}.log`);
}
export function audit(kind, text) {
  const line = `${new Date().toISOString()} [${kind}] ${text}\n`;
  appendFileSync(watchLogPath(), line);
  return line.trimEnd();
}

const say = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stdout.write(`REFUSED: ${s}\n`); audit('refused', s); process.exit(2); };

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'hmis-pending': {
    const [barcode, eqCode] = rest;
    if (!barcode || !eqCode) fail('usage: hmis-pending <barcode> <eqCode>');
    const url = `https://hims.zhhrpl.in/live/portal/mirth/pending?sampleId=${encodeURIComponent(barcode)}&eqCode=${encodeURIComponent(eqCode)}&siteId=9246332`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal })
      .then(async (r) => {
        clearTimeout(timer);
        const text = await r.text();
        let rows = [];
        try { rows = JSON.parse(text).data || []; } catch { /* not json */ }
        const summary = rows.map((x) => `${x.identifier || x.eqIdntifier || x.uniqueIdentifier}@${x.equipmentCode || eqCode} svc${x.labServiceId}${x.isTransmitted ? ' tx' : ''}`).join('  ');
        say(`HTTP ${r.status}; ${rows.length} pending row(s) for ${barcode} under ${eqCode}${rows.length ? ': ' + summary : ''}`);
        audit('hmis-pending', `${barcode} ${eqCode} -> ${rows.length} rows`);
      })
      .catch((e) => { clearTimeout(timer); say(`HMIS did not answer: ${e.name === 'AbortError' ? 'timed out after 15000ms' : e.message}`); audit('hmis-pending', `${barcode} ${eqCode} -> error ${e.message}`); });
    break;
  }

  case 'requeue': {
    const [analyzer, id] = rest;
    if (!ANALYZERS.includes(analyzer)) fail(`analyzer must be one of ${ANALYZERS.join(', ')}`);
    if (!id || /[\\/]/.test(id)) fail('usage: requeue <analyzerId> <spoolId>');
    if (CONTROL_ID.test(id)) fail(`${id} is a control / operator-typed id, not a patient tube — it stays parked`);
    const from = join(ROOT, 'spool', analyzer, 'failed', `${id}.json`);
    const to = join(ROOT, 'spool', analyzer, 'pending', `${id}.json`);
    if (!existsSync(from)) fail(`${analyzer}/failed/${id}.json does not exist`);
    const env = JSON.parse(readFileSync(from, 'utf8'));
    env.attempts = 0;
    env.lastError = `re-queued by Lab-Watch-Agent ${new Date().toISOString()}`;
    writeFileSync(from, JSON.stringify(env));
    renameSync(from, to);
    say(audit('requeue', `${analyzer} ${id} -> pending (attempts reset)`));
    break;
  }

  case 'restart-connector': {
    const reason = rest.join(' ').trim();
    if (!reason) fail('give a reason: restart-connector "<reason>"');
    if (existsSync(join(ROOT, '.lab-maintenance'))) fail('maintenance flag is raised (.lab-maintenance) — an operator stopped the connector on purpose');
    if (existsSync(RESTART_STAMP)) {
      const last = JSON.parse(readFileSync(RESTART_STAMP, 'utf8'));
      const ago = Date.now() - Date.parse(last.at);
      if (ago < RESTART_COOLDOWN_MS) fail(`already restarted ${Math.round(ago / 60000)} min ago for "${last.reason}" — wait ${Math.ceil((RESTART_COOLDOWN_MS - ago) / 60000)} min and look again`);
    }
    try {
      const out = execFileSync('pm2', ['restart', 'Lab-Interface', '--update-env'], {
        env: { ...process.env, PM2_HOME: join(ROOT, '.pm2') }, encoding: 'utf8', timeout: 60_000, windowsHide: true,
        shell: process.platform === 'win32', // pm2 is a .cmd shim on Windows
      });
      writeFileSync(RESTART_STAMP, JSON.stringify({ at: new Date().toISOString(), reason }));
      say(audit('restart', `Lab-Interface restarted — ${reason}\n${out.split('\n').filter((l) => /✓|error/i.test(l)).join('\n')}`));
    } catch (e) {
      say(audit('restart-failed', `${reason} — ${String(e.message).slice(0, 200)}`));
      process.exit(1);
    }
    break;
  }

  case 'alert': {
    const text = rest.join(' ').trim();
    if (!text) fail('alert needs text');
    appendFileSync(ALERTS, `${new Date().toISOString()} ${text}\n`);
    say(audit('ALERT', text));
    break;
  }

  case 'note': {
    const text = rest.join(' ').trim();
    if (!text) fail('note needs text');
    appendFileSync(NOTES, `- ${new Date().toISOString()} ${text}\n`);
    say(audit('note', text));
    break;
  }

  default:
    say('usage: act.mjs hmis-pending <barcode> <eqCode> | requeue <analyzerId> <spoolId> | restart-connector "<reason>" | alert "<text>" | note "<text>"');
    process.exit(2);
}
