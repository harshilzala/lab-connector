import { BASE_CSS, FONT_LINK } from './theme.js';
import { SHELL_CSS, SHELL_JS, renderSidebar } from './shell.js';

// =============================================================================
// AUTO CERTIFY page, served at GET /auto-certify to a signed-in session.
//
// The console view of src/autocertify/service.ts: whether the job is running,
// what the last run found and certified, the settings it runs with, and every
// recent certify call with the portal's answer. Run now / Pause act on the
// running service. Preview reads what is ready without certifying anything.
// =============================================================================

export interface AutoCertifyPageOptions {
  username: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_CSS = `
body { display:flex; flex-direction:column; min-height:100vh; }

.topbar { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--line); box-shadow:0 1px 3px rgba(54,50,50,.04); }
.topbar-inner { width:100%; padding:12px 28px; display:flex; align-items:center; gap:18px; }
.brand { display:flex; align-items:center; gap:14px; min-width:0; }
.brand .divider { width:1px; height:34px; background:var(--line); }
.brand h1 { font-size:17px; letter-spacing:-.2px; }
.brand .sub { font-size:12px; color:var(--mut); font-weight:600; letter-spacing:.3px; text-transform:uppercase; }
.spacer { flex:1; }
.topbar .tools { display:flex; align-items:center; gap:10px; }
.clock { font-size:13px; color:var(--mut); font-variant-numeric:tabular-nums; }
.who { display:flex; align-items:center; gap:8px; padding:5px 12px 5px 6px; background:var(--teal-soft); border-radius:999px; font-size:13px; font-weight:700; color:var(--teal-700); }
.who .avatar { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; background:var(--teal); color:#fff; font-size:12px; font-weight:800; }

main { flex:1; width:100%; padding:26px 28px 40px; }

.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin:0 0 22px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; box-shadow:var(--shadow); position:relative; overflow:hidden; }
.stat::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--teal); }
.stat.accent-plum::before { background:var(--plum); }
.stat.accent-warn::before { background:var(--warn); }
.stat.accent-bad::before  { background:var(--bad); }
.stat.accent-mut::before  { background:#cfcaca; }
.stat .k { font-size:11.5px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:var(--mut); }
.stat .v { font-size:26px; font-weight:800; color:var(--ink); line-height:1.15; margin-top:6px; font-variant-numeric:tabular-nums; }
.stat .n { font-size:12.5px; color:var(--mut); margin-top:2px; }

.cols { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; margin:0 0 22px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
.card-head { display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid var(--line); }
.card-head h2 { font-size:15px; }
.card-head .note { font-size:12.5px; color:var(--mut); }
.card-body { padding:12px 18px 16px; }
.kv { display:flex; justify-content:space-between; gap:14px; padding:7px 0; font-size:13.5px; border-top:1px dashed var(--line); }
.kv:first-child { border-top:0; }
.kv .k { color:var(--mut); flex-shrink:0; }
.kv .v { color:var(--ink); font-weight:600; text-align:right; word-break:break-all; }
.mono { font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace; font-size:12.5px; }
.chip { display:inline-block; padding:1px 7px; margin:1px 0 1px 4px; border-radius:5px; background:var(--plum-soft); color:var(--plum-600); font:700 11.5px/1.5 "Cascadia Mono",Consolas,monospace; }

.actions { display:flex; flex-wrap:wrap; gap:10px; padding:14px 18px; border-top:1px solid var(--line); background:#fbfbfc; }
.btn-warn { color:var(--warn); }

.filters { display:flex; gap:6px; background:#f2f0f1; padding:4px; border-radius:10px; margin-left:auto; }
.filters button { border:0; background:transparent; color:var(--mut); cursor:pointer; font:700 12.5px/1 var(--font); padding:7px 12px; border-radius:7px; }
.filters button.active { background:#fff; color:var(--teal-700); box-shadow:0 1px 2px rgba(54,50,50,.12); }

.table-wrap { overflow:auto; max-height:560px; }
table.t { width:100%; border-collapse:collapse; font-size:13px; }
table.t th { position:sticky; top:0; background:#fbfbfc; text-align:left; font-size:11.5px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; color:var(--mut); padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
table.t td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
table.t tr:last-child td { border-bottom:0; }
table.t td.resp { max-width:360px; color:var(--mut); font-size:12px; word-break:break-word; }
.kind { font-weight:800; font-size:10.5px; letter-spacing:.5px; padding:2px 7px; border-radius:5px; text-transform:uppercase; }
.kind.result { background:var(--teal-soft); color:var(--teal-700); }
.kind.parameter { background:var(--plum-soft); color:var(--plum-600); }
.empty { padding:28px 16px; text-align:center; color:var(--mut); font-size:13px; }

footer.pagefoot { padding:16px 24px 28px; text-align:center; font-size:12.5px; color:var(--mut); }

@media (max-width:900px) { .cols { grid-template-columns:1fr; } }
@media (max-width:720px) {
  .topbar-inner { flex-wrap:wrap; gap:12px; padding:12px 16px; }
  .clock { display:none; }
  main { padding:20px 16px 32px; }
}
`;

export function renderAutoCertify(o: AutoCertifyPageOptions): string {
  const initial = esc((o.username[0] ?? 'A').toUpperCase());

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Auto Certify &middot; Lab Connector</title>
${FONT_LINK}
<style>${BASE_CSS}${SHELL_CSS}${PAGE_CSS}</style>
</head>
<body>
${renderSidebar('auto-certify')}
<div class="brandbar"></div>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <img class="logo" src="/assets/zydus-logo.svg" alt="Zydus Hospitals" />
      <span class="divider"></span>
      <div>
        <div class="sub">HMIS Interface</div>
        <h1>Auto Certify</h1>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="tools">
      <span class="clock" id="clock"></span>
      <span class="who"><span class="avatar">${initial}</span>${esc(o.username)}</span>
    </div>
  </div>
</header>

<main>
  <div id="alert"></div>
  <section class="stats" id="stats"></section>

  <section class="cols">
    <div class="card">
      <div class="card-head"><h2>Last run</h2><span class="note" id="lastRunNote"></span></div>
      <div class="card-body" id="lastRun"></div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" type="button" id="btnRun" title="Certify everything that is ready now">Run now</button>
        <button class="btn btn-ghost btn-sm btn-warn" type="button" id="btnPause"></button>
        <button class="btn btn-ghost btn-sm" type="button" id="btnPreview" title="List what is ready, without certifying anything">Preview</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Settings</h2><span class="note">config.json &rarr; autoCertify</span></div>
      <div class="card-body" id="settings"></div>
    </div>
  </section>

  <section class="card" id="previewCard" style="display:none;margin:0 0 22px">
    <div class="card-head">
      <h2>Ready to certify</h2><span class="note" id="previewNote"></span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" id="btnPreviewClose">Close</button>
    </div>
    <div class="table-wrap" id="preview"></div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Certify log</h2><span class="note" id="historyNote"></span>
      <div class="filters" id="filters">
        <button type="button" data-f="all" class="active">All</button>
        <button type="button" data-f="ok">Certified</button>
        <button type="button" data-f="failed">Failed</button>
      </div>
    </div>
    <div class="table-wrap" id="history"></div>
  </section>
</main>

<footer class="pagefoot">Zydus Hospitals &middot; HMIS Lab Connector &middot; Auto Certify</footer>

<script>
const state = { filter: 'all', data: null };

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function time(iso) { return iso ? new Date(iso).toLocaleTimeString() : '\\u2014'; }
function stamp(iso) { return iso ? new Date(iso).toLocaleString() : '\\u2014'; }

// Any 401 means the session lapsed while the page sat open — bounce to sign-in.
async function j(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const body = await r.json();
  if (!r.ok && !body.error) body.error = 'HTTP ' + r.status;
  return body;
}

function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
function chips(list) { return (list || []).length ? list.map(x => '<span class="chip">' + esc(x) + '</span>').join('') : '<span class="mut">none</span>'; }

function renderStats(s) {
  let st, stN, stA;
  if (!s.enabled) { st = 'Disabled'; stN = 'autoCertify.enabled is false'; stA = 'accent-mut'; }
  else if (s.running) { st = 'Running'; stN = 'Certifying now'; stA = ''; }
  else if (s.paused) { st = 'Paused'; stN = 'Resume to certify again'; stA = 'accent-warn'; }
  else { st = 'Active'; stN = 'Every ' + s.intervalSeconds + ' s'; stA = ''; }
  const lr = s.lastRun;
  const tiles = [
    { k: 'Status', v: st, n: stN, a: stA },
    { k: 'Next run', v: s.nextRunAt ? time(s.nextRunAt) : '\\u2014', n: s.nextRunAt ? 'Scheduled' : (s.enabled ? (s.paused ? 'Paused' : 'After this run') : 'Not scheduled'), a: 'accent-plum' },
    { k: 'Ready last run', v: lr ? lr.found : '\\u2014', n: lr ? 'at ' + time(lr.startedAt) : 'No run yet', a: '' },
    { k: 'Certified', v: s.totals.certified, n: 'since ' + stamp(s.totals.since), a: '' },
    { k: 'Failed calls', v: s.totals.failed, n: s.totals.failed ? 'Retried on the next run' : 'None', a: s.totals.failed ? 'accent-bad' : '' },
  ];
  document.getElementById('stats').innerHTML = tiles.map(t =>
    '<div class="stat ' + t.a + '"><div class="k">' + t.k + '</div><div class="v">' + esc(t.v) + '</div><div class="n">' + esc(t.n) + '</div></div>').join('');
}

function renderLastRun(s) {
  const lr = s.lastRun;
  document.getElementById('lastRunNote').textContent = lr ? (lr.manual ? 'started from the console' : 'scheduled') : '';
  document.getElementById('lastRun').innerHTML = lr
    ? kv('Started', esc(stamp(lr.startedAt))) +
      kv('Finished', lr.finishedAt ? esc(time(lr.finishedAt)) + ' <span class="mut">(' + ((new Date(lr.finishedAt) - new Date(lr.startedAt)) / 1000).toFixed(1) + ' s)</span>' : '<span class="pill ok">running</span>') +
      kv('Results ready', esc(lr.found)) +
      kv('Certified', '<span style="color:var(--ok)">' + esc(lr.certified) + '</span>') +
      kv('Failed', lr.failed ? '<span style="color:var(--bad)">' + esc(lr.failed) + '</span>' : '0') +
      kv('Waiting on the analyzer', '<span title="Parameters still in a parameter result status. Checked again on the next run.">' + esc(lr.waiting) + '</span>') +
      (lr.error ? kv('Error', '<span style="color:var(--bad)">' + esc(lr.error) + '</span>') : '')
    : '<div class="empty">' + (s.enabled ? 'The first run starts a few seconds after the connector starts.' : 'Auto Certify is disabled.') + '</div>';

  const run = document.getElementById('btnRun');
  const pause = document.getElementById('btnPause');
  const prev = document.getElementById('btnPreview');
  run.disabled = !s.enabled || s.running;
  prev.disabled = !s.enabled;
  pause.disabled = !s.enabled;
  pause.textContent = s.paused ? 'Resume' : 'Pause';
  pause.title = s.paused ? 'Start the scheduled runs again' : 'Stop the scheduled runs until you resume (a restart resumes too)';
}

function renderSettings(s) {
  const c = s.config;
  document.getElementById('settings').innerHTML =
    kv('Certify endpoint', '<span class="mono">' + esc(c.certifyUrl || 'not set') + '</span>') +
    kv('Interval', esc(s.intervalSeconds) + ' s') +
    kv('Site id', esc(c.siteId || 'not set')) +
    kv('Equipment ids', chips(c.equipmentIds)) +
    kv('Result status', chips(c.resultStatus)) +
    kv('Parameter result status', chips(c.parameterResultStatus)) +
    kv('Accepted within', 'today + ' + esc(c.lookbackDays) + ' previous day' + (c.lookbackDays === 1 ? '' : 's')) +
    kv('Department must have HOD', c.requireHod ? 'yes' : 'no') +
    kv('Oracle', '<span class="mono">' + esc((c.oracle.user || '?') + '@' + (c.oracle.connectString || 'not set')) + '</span>' +
       (c.oracle.passwordSet ? '' : ' <span class="pill bad">no password</span>')) +
    kv('Log file', '<span class="mono">' + esc(c.logFile || 'off') + '</span>');
}

function renderHistory(list) {
  const shown = list.filter(a => state.filter === 'all' || (state.filter === 'ok' ? a.ok : !a.ok));
  document.getElementById('historyNote').textContent = list.length ? shown.length + ' of ' + list.length + ' recent call' + (list.length === 1 ? '' : 's') : '';
  document.getElementById('history').innerHTML = shown.length
    ? '<table class="t"><thead><tr><th>Time</th><th>Type</th><th>Sample</th><th>Lab result</th><th>Parameter</th><th>Lab order</th><th>Outcome</th><th>HTTP</th><th>Response</th></tr></thead><tbody>' +
      shown.map(a => '<tr>' +
        '<td class="mono" title="' + esc(stamp(a.at)) + '">' + esc(time(a.at)) + (a.manual ? ' <span class="mut">&middot; manual</span>' : '') + '</td>' +
        '<td><span class="kind ' + a.kind + '">' + a.kind + '</span></td>' +
        '<td class="mono">' + esc(a.sampleId) + '</td>' +
        '<td class="mono">' + esc(a.labResultId) + '</td>' +
        '<td class="mono">' + esc(a.labResultParameterId || '\\u2014') + '</td>' +
        '<td class="mono">' + esc(a.labOrderId) + '</td>' +
        '<td>' + (a.ok ? '<span class="pill ok">certified</span>' : '<span class="pill bad">failed</span>') + '</td>' +
        '<td class="mono">' + esc(a.httpStatus == null ? '\\u2014' : a.httpStatus) + '</td>' +
        '<td class="resp" title="' + esc(a.response) + '">' + esc(a.response.length > 140 ? a.response.slice(0, 140) + '\\u2026' : a.response) + '</td>' +
        '</tr>').join('') + '</tbody></table>'
    : '<div class="empty">' + (list.length ? 'Nothing matches this filter.' : 'No certify calls yet in this session. Every call is also written to the log file.') + '</div>';
}

async function refresh() {
  try {
    const data = await j('/api/auto-certify');
    state.data = data;
    renderStats(data.status);
    renderLastRun(data.status);
    renderSettings(data.status);
    renderHistory(data.history || []);
    const alert = document.getElementById('alert');
    if (!data.status.enabled) {
      alert.innerHTML = '<div class="msg info"><strong>Auto Certify is disabled.</strong> Fill in the <code>autoCertify</code> block in config.json, set <code>"enabled": true</code> and restart the connector.</div>';
    } else if (data.status.lastRun && data.status.lastRun.error) {
      alert.innerHTML = '<div class="msg error"><strong>The last run failed:</strong> ' + esc(data.status.lastRun.error) + '</div>';
    } else {
      alert.innerHTML = '';
    }
  } catch (err) {
    document.getElementById('alert').innerHTML = '<div class="msg error">Lost contact with the connector service. Retrying\\u2026</div>';
  }
  document.getElementById('clock').textContent = new Date().toLocaleString();
}

document.getElementById('btnRun').onclick = async (e) => {
  if (!confirm('Certify every result that is ready now?\\n\\nEach one is certified in HIS through the autocertify endpoint.')) return;
  const b = e.currentTarget;
  b.disabled = true; b.textContent = 'Running\\u2026';
  const r = await j('/api/auto-certify/run', { method: 'POST' }).catch(err => ({ error: String(err.message || err) }));
  b.textContent = 'Run now';
  if (r.error) alert('Run failed: ' + r.error);
  else alert(r.found + ' ready \\u00b7 ' + r.certified + ' certified \\u00b7 ' + r.failed + ' failed' + (r.waiting ? ' \\u00b7 ' + r.waiting + ' waiting on the analyzer' : '') + (r.error ? '\\n\\n' + r.error : ''));
  refresh();
};

document.getElementById('btnPause').onclick = async () => {
  const paused = !(state.data && state.data.status.paused);
  const r = await j('/api/auto-certify/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) });
  if (r.error) alert(r.error);
  refresh();
};

document.getElementById('btnPreview').onclick = async (e) => {
  const b = e.currentTarget;
  const card = document.getElementById('previewCard');
  const el = document.getElementById('preview');
  card.style.display = '';
  b.disabled = true;
  el.innerHTML = '<div class="empty">Reading the HIS database\\u2026</div>';
  document.getElementById('previewNote').textContent = '';
  const r = await j('/api/auto-certify/preview', { method: 'POST' }).catch(err => ({ error: String(err.message || err) }));
  b.disabled = false;
  if (r.error) { el.innerHTML = '<div class="empty" style="color:var(--bad)">' + esc(r.error) + '</div>'; return; }
  const c = r.candidates || [];
  document.getElementById('previewNote').textContent = c.length + ' result' + (c.length === 1 ? '' : 's') + ' \\u00b7 read ' + new Date().toLocaleTimeString() + ' \\u00b7 nothing certified';
  el.innerHTML = c.length
    ? '<table class="t"><thead><tr><th>Accepted</th><th>Sample</th><th>Lab result</th><th>Lab order</th><th>Equipment</th><th>Service</th><th title="LM.autocertifylab: shown for reference, not used to decide">Auto-cert flag</th><th>Status</th><th>Value</th><th>Next run would</th></tr></thead><tbody>' +
      c.map(x => '<tr>' +
        '<td class="mono">' + esc(stamp(x.acceptedDate)) + '</td>' +
        '<td class="mono">' + esc(x.sampleId) + '</td>' +
        '<td class="mono">' + esc(x.labResultId) + '</td>' +
        '<td class="mono">' + esc(x.labOrderId) + '</td>' +
        '<td class="mono">' + esc(x.equipmentId) + '</td>' +
        '<td class="mono">' + esc(x.labServiceId) + '</td>' +
        '<td class="mono">' + esc(x.autoCertifyLab == null ? '\\u2014' : x.autoCertifyLab) + '</td>' +
        '<td class="mono">' + esc(x.resultStatus) + '</td>' +
        '<td class="mono">' + esc(x.interfacedValue || '\\u2014') + '</td>' +
        '<td>' + (x.hasParameter
          ? (x.blockingParameterIds.length
              ? '<span class="pill warn" title="Still in a parameter result status: ' + esc(x.blockingParameterIds.join(', ')) + '">wait \\u2014 ' + x.blockingParameterIds.length + ' not finished</span>'
              : '<span class="kind parameter">' + x.parameterIds.length + ' parameter' + (x.parameterIds.length === 1 ? '' : 's') + '</span> <span class="mono mut">' + esc(x.parameterIds.join(', ')) + '</span>')
          : '<span class="kind result">result</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table>'
    : '<div class="empty">Nothing is ready to certify right now.</div>';
};

document.getElementById('btnPreviewClose').onclick = () => { document.getElementById('previewCard').style.display = 'none'; };

document.querySelectorAll('#filters button').forEach(b => {
  b.onclick = () => {
    state.filter = b.dataset.f;
    document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('active', x === b));
    if (state.data) renderHistory(state.data.history || []);
  };
});

refresh();
setInterval(refresh, 5000);
</script>
<script>${SHELL_JS}</script>
</body>
</html>`;
}
