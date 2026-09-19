#!/usr/bin/env node
// =============================================================================
// Lab-Watch-Agent runner — a 48-hour watch over the VITROS ECiQ and the
// VITROS 250, one Claude Code tick every AGENT_INTERVAL_MIN minutes.
//
// Each tick:  snapshot.mjs  →  claude -p (headless, tools allow-listed)  →
//             report appended to logs/agent-watch-<date>.log
//
// The agent's hands are `scripts/agent/act.mjs` and nothing else — see
// PROMPT.md for what it may do. Runs under PM2 as "Lab-Watch-Agent"
// (magic/magic-agent-start.bat), no window. Exits on its own after
// AGENT_HOURS (default 48) — the start time is kept in state/run.json so a PM2
// resurrect after that cannot bring a finished watch back.
//
//   AGENT_HOURS=48  AGENT_INTERVAL_MIN=15  AGENT_MODEL=<model or empty>
// =============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { snapshot, ROOT } from './snapshot.mjs';
import { audit, watchLogPath } from './act.mjs';

const HOURS = Number(process.env.AGENT_HOURS || 48);
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MIN || 15) * 60_000;
const MODEL = process.env.AGENT_MODEL || '';
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 20);
const TICK_TIMEOUT_MS = 12 * 60_000;

const DIR = join(ROOT, 'scripts', 'agent');
const STATE = join(DIR, 'state');
const RUN = join(STATE, 'run.json');
const NOTES = join(STATE, 'NOTES.md');
const LAST_REPORT = join(STATE, 'last-report.md');
mkdirSync(STATE, { recursive: true });

/** Tools the agent gets. Everything else is denied without a prompt. */
const ALLOWED_TOOLS = [
  'Bash(node scripts/agent/act.mjs *)',
  'Bash(node scripts/agent/act.mjs:*)',
  'Read',
  'Grep',
].join(',');

const log = (s) => { const line = `${new Date().toISOString()} [runner] ${s}`; console.log(line); appendFileSync(watchLogPath(), line + '\n'); };

function resolveClaude() {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  const dirs = [
    ...(process.env.PATH || '').split(delimiter),
    join(process.env.APPDATA || '', 'npm'),
    join(process.env.LOCALAPPDATA || '', 'nodejs'),
    join(process.env.USERPROFILE || '', '.local', 'bin'),
  ];
  for (const d of dirs) for (const n of names) { const p = join(d, n); if (d && existsSync(p)) return p; }
  return null;
}

function runClaude(bin, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--max-turns', String(MAX_TURNS), '--allowedTools', ALLOWED_TOOLS];
    if (MODEL) args.push('--model', MODEL);
    const child = spawn(bin, args, { cwd: ROOT, env: process.env, windowsHide: true, shell: process.platform === 'win32' && bin.endsWith('.cmd') });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, text: `tick timed out after ${TICK_TIMEOUT_MS / 60000} min`, raw: out }); }, TICK_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = out.trim();
      let cost = null;
      try { const j = JSON.parse(out); text = j.result ?? text; cost = j.total_cost_usd ?? null; } catch { /* plain text */ }
      resolve({ ok: code === 0, text: text || err.slice(-800), cost, raw: out });
    });
    child.stdin.end(prompt);
  });
}

function buildPrompt(snap) {
  const brief = readFileSync(join(DIR, 'PROMPT.md'), 'utf8');
  const notes = existsSync(NOTES) ? readFileSync(NOTES, 'utf8').split('\n').slice(-40).join('\n') : '(no notes yet — this is the first tick)';
  const last = existsSync(LAST_REPORT) ? readFileSync(LAST_REPORT, 'utf8') : '(none)';
  return `${brief}

---
## Your notes from earlier ticks
${notes}

## Previous tick's report
${last}

## Snapshot (last ${snap.windowHours} h, taken ${snap.takenAt})
\`\`\`json
${JSON.stringify(snap)}
\`\`\`

Work from the snapshot. Run \`node scripts/agent/act.mjs hmis-pending …\` only where the brief says to. Then write the report in the required format as your final message.`;
}

async function tick(bin, n) {
  log(`tick ${n} — taking snapshot`);
  let snap;
  try { snap = await snapshot(); } catch (e) { log(`snapshot failed: ${e.message}`); return; }
  const digest = Object.entries(snap.analyzers).map(([a, s]) => `${a}: link ${s.link.lastConnectedAt ? 'seen' : 'not seen'} | in ${s.wire.inbound} out ${s.wire.outbound} | filed ${s.resultsFiled.samples}s/${s.resultsFiled.values}v | pending ${s.spool.pending.length} failed ${s.spool.failed.length} staged-waiting ${s.spool.staged.length}`).join(' || ');
  log(`snapshot: pm2 ${snap.pm2.status ?? snap.pm2.error ?? 'unknown'}; hmis ${snap.hmisProbe.ok ? 'ok ' + snap.hmisProbe.ms + 'ms' : 'FAIL ' + (snap.hmisProbe.error || snap.hmisProbe.httpStatus)}; ${digest}`);
  const r = await runClaude(bin, buildPrompt(snap));
  writeFileSync(LAST_REPORT, r.text);
  audit('report', `tick ${n}${r.cost != null ? ` ($${r.cost.toFixed(3)})` : ''}${r.ok ? '' : ' (claude exited with an error)'}\n${r.text}\n`);
}

async function main() {
  const bin = resolveClaude();
  if (!bin) {
    log('Claude Code CLI not found (looked on PATH, %APPDATA%\\npm, %LOCALAPPDATA%\\nodejs). Install with: npm install -g @anthropic-ai/claude-code  — then sign in once with: claude');
    process.exit(3);
  }
  let run = existsSync(RUN) ? JSON.parse(readFileSync(RUN, 'utf8')) : null;
  if (!run || run.finished || Date.now() > Date.parse(run.endsAt)) {
    run = { startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOURS * 3600_000).toISOString(), finished: false, ticks: 0 };
  }
  writeFileSync(RUN, JSON.stringify(run, null, 1));
  log(`Lab-Watch-Agent started — watching vitros-eciq + vitros-250 until ${run.endsAt} (${HOURS} h), every ${INTERVAL_MS / 60000} min, claude=${bin}${MODEL ? ', model ' + MODEL : ''}`);

  let stopping = false;
  const stop = (sig) => { stopping = true; log(`${sig} received — finishing`); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (!stopping && Date.now() < Date.parse(run.endsAt)) {
    run.ticks++;
    writeFileSync(RUN, JSON.stringify(run, null, 1));
    try { await tick(bin, run.ticks); } catch (e) { log(`tick ${run.ticks} crashed: ${e.message}`); }
    const wait = Math.min(INTERVAL_MS, Math.max(0, Date.parse(run.endsAt) - Date.now()));
    if (wait === 0) break;
    await new Promise((r) => { const t = setTimeout(r, wait); const poll = setInterval(() => { if (stopping) { clearTimeout(t); clearInterval(poll); r(); } }, 1000); t.unref?.(); });
  }
  if (!stopping) { run.finished = true; writeFileSync(RUN, JSON.stringify(run, null, 1)); log(`watch complete after ${run.ticks} ticks — Lab-Watch-Agent exiting`); }
  process.exit(0);
}

main();
