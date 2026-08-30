import { BASE_CSS, FONT_LINK } from './theme.js';

// Operations dashboard, styled to the Zydus Hospitals brand (teal #00a5a5 /
// plum #aa55a0 on white, Nunito Sans). Self-contained apart from the webfont.
// Served at GET / to an authenticated session only.

export interface DashboardOptions {
  username: string;
  /** Raises a nudge banner while the commissioning password is still in place. */
  usingDefaultPassword: boolean;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_CSS = `
body { display:flex; flex-direction:column; min-height:100vh; }

/* ---- top bar ---- */
.topbar {
  position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--line);
  box-shadow:0 1px 3px rgba(54,50,50,.04);
}
.topbar-inner {
  max-width:1240px; margin:0 auto; padding:12px 24px;
  display:flex; align-items:center; gap:18px;
}
.brand { display:flex; align-items:center; gap:14px; min-width:0; }
.brand .divider { width:1px; height:34px; background:var(--line); }
.brand h1 { font-size:17px; letter-spacing:-.2px; }
.brand .sub { font-size:12px; color:var(--mut); font-weight:600; letter-spacing:.3px; text-transform:uppercase; }
.spacer { flex:1; }
.topbar .tools { display:flex; align-items:center; gap:10px; }
.clock { font-size:13px; color:var(--mut); font-variant-numeric:tabular-nums; }
.who {
  display:flex; align-items:center; gap:8px; padding:5px 12px 5px 6px;
  background:var(--teal-soft); border-radius:999px; font-size:13px; font-weight:700; color:var(--teal-700);
}
.who .avatar {
  width:26px; height:26px; border-radius:50%; display:grid; place-items:center;
  background:var(--teal); color:#fff; font-size:12px; font-weight:800;
}

main { flex:1; width:100%; max-width:1240px; margin:0 auto; padding:26px 24px 40px; }

/* ---- summary tiles ---- */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:16px; margin:0 0 26px; }
.stat {
  background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  padding:16px 18px; box-shadow:var(--shadow); position:relative; overflow:hidden;
}
.stat::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--teal); }
.stat.accent-plum::before { background:var(--plum); }
.stat.accent-warn::before { background:var(--warn); }
.stat.accent-bad::before  { background:var(--bad); }
.stat .k { font-size:11.5px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:var(--mut); }
.stat .v { font-size:28px; font-weight:800; color:var(--ink); line-height:1.15; margin-top:6px; font-variant-numeric:tabular-nums; }
.stat .n { font-size:12.5px; color:var(--mut); margin-top:2px; }

.section-head { display:flex; align-items:baseline; gap:12px; margin:0 0 14px; }
.section-head h2 { font-size:16px; }
.section-head .mut { font-size:13px; }

/* ---- analyzer cards ---- */
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(400px,1fr)); gap:18px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
.card-top { padding:16px 18px 14px; border-bottom:1px solid var(--line); }
.card-title { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.card-title h3 { font-size:16px; }
.card-title .id { font-size:12px; color:var(--mut); font-weight:600; }
.meta { display:flex; flex-wrap:wrap; gap:6px 10px; margin-top:10px; font-size:12.5px; color:var(--mut); }
.tag {
  display:inline-block; padding:2px 9px; border-radius:6px; background:var(--plum-soft);
  color:var(--plum-600); font-weight:700; font-size:11.5px; letter-spacing:.3px;
}
.kv { display:flex; justify-content:space-between; gap:12px; padding:7px 0; font-size:13.5px; border-top:1px dashed var(--line); }
.kv:first-of-type { border-top:0; }
.kv .k { color:var(--mut); }
.kv .v { color:var(--ink); font-weight:600; }
.card-body { padding:14px 18px 18px; }

.tabs { display:flex; gap:6px; margin:0 0 12px; background:#f2f0f1; padding:4px; border-radius:10px; }
.tabs button {
  flex:1; border:0; background:transparent; color:var(--mut); cursor:pointer;
  font:700 13px/1 var(--font); padding:8px 10px; border-radius:7px; transition:background .15s,color .15s;
}
.tabs button:hover { color:var(--ink); }
.tabs button.active { background:#fff; color:var(--teal-700); box-shadow:0 1px 2px rgba(54,50,50,.12); }

.panel { border:1px solid var(--line); border-radius:10px; background:#fbfbfc; max-height:320px; overflow:auto; }
.panel .empty { padding:26px 16px; text-align:center; color:var(--mut); font-size:13px; }

.wire { margin:0; padding:0; list-style:none; }
.wire li { padding:9px 12px; border-bottom:1px solid var(--line); }
.wire li:last-child { border-bottom:0; }
.wire .head { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--mut); margin-bottom:4px; }
.dir { font-weight:800; font-size:10.5px; letter-spacing:.5px; padding:1px 7px; border-radius:5px; }
.dir.IN  { background:var(--teal-soft); color:var(--teal-700); }
.dir.OUT { background:var(--plum-soft); color:var(--plum-600); }
.wire pre {
  margin:0; font:12px/1.55 "Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;
  color:var(--ink); white-space:pre-wrap; word-break:break-all;
}

.q { margin:0; padding:0; list-style:none; }
.q li { display:flex; align-items:center; gap:12px; padding:10px 12px; border-bottom:1px solid var(--line); }
.q li:last-child { border-bottom:0; }
.q .barcode { font:700 13px/1.3 "Cascadia Mono",Consolas,monospace; color:var(--ink); }
.q .err { font-size:11.5px; color:var(--bad); margin-top:3px; word-break:break-word; }
.q .grow { flex:1; min-width:0; }

/* ---- change-password dialog ---- */
.backdrop { position:fixed; inset:0; background:rgba(54,50,50,.45); display:none; align-items:center; justify-content:center; padding:20px; z-index:50; }
.backdrop.open { display:flex; }
.modal { width:100%; max-width:410px; background:#fff; border-radius:18px; box-shadow:0 24px 60px rgba(54,50,50,.28); padding:26px 26px 22px; }
.modal h2 { font-size:19px; margin-bottom:4px; }
.modal > p.lead { margin:0 0 18px; font-size:13.5px; color:var(--mut); }
.modal .field { margin:0 0 14px; }
.modal .row { display:flex; gap:10px; margin-top:18px; }
.modal .row .btn { flex:1; }

footer.pagefoot { padding:16px 24px 28px; text-align:center; font-size:12.5px; color:var(--mut); }

@media (max-width:720px) {
  .topbar-inner { flex-wrap:wrap; gap:12px; padding:12px 16px; }
  .clock { display:none; }
  main { padding:20px 16px 32px; }
  .grid { grid-template-columns:1fr; }
}
`;

export function renderDashboard(o: DashboardOptions): string {
  const initial = esc((o.username[0] ?? 'A').toUpperCase());
  const defaultPwBanner = o.usingDefaultPassword
    ? `<div class="msg info" role="status" style="margin-bottom:22px">
         <strong>Commissioning password still active.</strong>
         Set a private password before this connector goes live &mdash;
         <a href="#" onclick="openPw();return false;">change it now</a>.
       </div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Lab Connector &middot; Zydus Hospitals</title>
${FONT_LINK}
<style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
<div class="brandbar"></div>

<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <img class="logo" src="/assets/zydus-logo.svg" alt="Zydus Hospitals" />
      <span class="divider"></span>
      <div>
        <div class="sub">HMIS Interface</div>
        <h1>Lab Connector</h1>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="tools">
      <span class="clock" id="clock"></span>
      <span class="who"><span class="avatar">${initial}</span>${esc(o.username)}</span>
      <button class="btn btn-ghost btn-sm" type="button" onclick="openPw()">Change password</button>
      <form method="post" action="/logout" style="margin:0">
        <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
      </form>
    </div>
  </div>
</header>

<main>
  ${defaultPwBanner}
  <div id="alert"></div>
  <section class="stats" id="stats"></section>
  <div class="section-head">
    <h2>Analyzers</h2>
    <span class="mut" id="refreshed"></span>
  </div>
  <section class="grid" id="cards"></section>
</main>

<footer class="pagefoot">Zydus Hospitals &middot; HMIS Lab Connector &middot; local console</footer>

<div class="backdrop" id="pwBackdrop" role="dialog" aria-modal="true" aria-labelledby="pwTitle">
  <div class="modal">
    <h2 id="pwTitle">Change password</h2>
    <p class="lead">Signed in as <strong>${esc(o.username)}</strong>. All other sessions are signed out.</p>
    <div id="pwMsg"></div>
    <div class="field">
      <label for="pwCurrent">Current password</label>
      <input id="pwCurrent" type="password" autocomplete="current-password" />
    </div>
    <div class="field">
      <label for="pwNew">New password</label>
      <input id="pwNew" type="password" autocomplete="new-password" />
    </div>
    <div class="field">
      <label for="pwConfirm">Confirm new password</label>
      <input id="pwConfirm" type="password" autocomplete="new-password" />
    </div>
    <div class="row">
      <button class="btn btn-ghost" type="button" onclick="closePw()">Cancel</button>
      <button class="btn btn-primary" type="button" id="pwSubmit" onclick="submitPw()">Update</button>
    </div>
  </div>
</div>

<script>
const state = { open: null, tab: 'wire' };

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function time(iso) { return iso ? new Date(iso).toLocaleTimeString() : '\u2014'; }

// Any 401 means the session lapsed while the page sat open — bounce to sign-in.
async function j(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  return r.json();
}

function statusPill(a) {
  return a.connected
    ? '<span class="pill ok">Connected</span>'
    : '<span class="pill bad">Offline</span>';
}
function queuePill(sp) {
  if (sp.failed > 0)  return '<span class="pill bad">' + sp.failed + ' failed</span>';
  if (sp.pending > 0) return '<span class="pill warn">' + sp.pending + ' pending</span>';
  return '<span class="pill ok">Clear</span>';
}

function renderStats(analyzers) {
  const online  = analyzers.filter(a => a.connected).length;
  const pending = analyzers.reduce((n, a) => n + a.spool.pending, 0);
  const failed  = analyzers.reduce((n, a) => n + a.spool.failed, 0);
  const last    = analyzers.map(a => a.lastMessageAt).filter(Boolean).sort().pop() || null;

  const tiles = [
    { k: 'Analyzers online', v: online + '/' + analyzers.length,
      n: online === analyzers.length ? 'All links up' : (analyzers.length - online) + ' link(s) down',
      accent: online === analyzers.length ? '' : 'accent-bad' },
    { k: 'Queued uploads', v: pending, n: 'Awaiting delivery to HMIS',
      accent: pending > 0 ? 'accent-warn' : '' },
    { k: 'Parked results', v: failed, n: failed > 0 ? 'Needs a manual retry' : 'Nothing parked',
      accent: failed > 0 ? 'accent-bad' : '' },
    { k: 'Last message', v: time(last), n: last ? new Date(last).toLocaleDateString() : 'No traffic yet',
      accent: 'accent-plum' },
  ];

  document.getElementById('stats').innerHTML = tiles.map(t =>
    '<div class="stat ' + t.accent + '"><div class="k">' + t.k + '</div>' +
    '<div class="v">' + esc(t.v) + '</div><div class="n">' + esc(t.n) + '</div></div>').join('');
}

function renderCards(analyzers) {
  document.getElementById('cards').innerHTML = analyzers.map(a => \`
    <article class="card">
      <div class="card-top">
        <div class="card-title">
          <div>
            <h3>\${esc(a.equipmentCode)}</h3>
            <div class="id">\${esc(a.id)}</div>
          </div>
          \${statusPill(a)}
        </div>
        <div class="meta">
          <span class="tag">\${esc(a.protocol.toUpperCase())}</span>
          <span>\${esc(a.endpoint)}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="kv"><span class="k">Last message</span><span class="v">\${time(a.lastMessageAt)}</span></div>
        <div class="kv"><span class="k">Upload queue</span><span class="v">\${queuePill(a.spool)}</span></div>
        <div class="tabs">
          <button type="button" data-a="\${esc(a.id)}" data-t="wire"
                  class="\${state.open === a.id && state.tab === 'wire' ? 'active' : ''}">Wire log</button>
          <button type="button" data-a="\${esc(a.id)}" data-t="spool"
                  class="\${state.open === a.id && state.tab === 'spool' ? 'active' : ''}">Upload queue</button>
        </div>
        <div class="panel" id="panel-\${esc(a.id)}">
          <div class="empty">Pick a view above.</div>
        </div>
      </div>
    </article>\`).join('');

  document.querySelectorAll('button[data-a]').forEach(b => {
    b.onclick = () => {
      state.open = b.dataset.a;
      state.tab = b.dataset.t;
      // Repaint the tab strip locally rather than re-fetching the whole page.
      document.querySelectorAll('button[data-a]').forEach(x => x.classList.toggle(
        'active', x.dataset.a === state.open && x.dataset.t === state.tab));
      renderPanel(state.open);
    };
  });
}

async function renderPanel(id) {
  const el = document.getElementById('panel-' + id);
  if (!el) return;

  if (state.tab === 'wire') {
    const { wire } = await j('/api/analyzers/' + encodeURIComponent(id) + '/wire');
    const rows = (wire || []).slice(-30).reverse();
    el.innerHTML = rows.length
      ? '<ul class="wire">' + rows.map(w =>
          '<li><div class="head"><span class="dir ' + esc(w.direction) + '">' + esc(w.direction) + '</span>' +
          '<span>' + time(w.at) + '</span></div><pre>' + esc(w.text) + '</pre></li>').join('') + '</ul>'
      : '<div class="empty">No traffic on the wire yet.</div>';
    return;
  }

  const s = await j('/api/analyzers/' + encodeURIComponent(id) + '/spool');
  const failed = (s.failed || []).map(f =>
    '<li><div class="grow"><div class="barcode">' + esc(f.payload.barcode) + '</div>' +
    '<div class="err">' + esc(f.lastError || 'delivery failed') + '</div></div>' +
    '<span class="pill bad">' + f.attempts + ' tries</span>' +
    '<button class="btn btn-ghost btn-sm" type="button" onclick="retry(\\'' + id + '\\',\\'' + f.id + '\\')">Retry</button></li>').join('');
  const pending = (s.pending || []).map(p =>
    '<li><div class="grow"><div class="barcode">' + esc(p.payload.barcode) + '</div></div>' +
    '<span class="pill warn">queued</span></li>').join('');

  el.innerHTML = (failed || pending)
    ? '<ul class="q">' + failed + pending + '</ul>'
    : '<div class="empty">Upload queue is empty &mdash; everything has reached the HMIS.</div>';
}

async function retry(id, msgId) {
  await j('/api/analyzers/' + encodeURIComponent(id) + '/retry/' + encodeURIComponent(msgId), { method: 'POST' });
  renderPanel(id);
}

async function refresh() {
  try {
    const { analyzers } = await j('/api/status');
    renderStats(analyzers);
    renderCards(analyzers);
    if (state.open) renderPanel(state.open);
    document.getElementById('alert').innerHTML = '';
    document.getElementById('refreshed').textContent = 'refreshed ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('alert').innerHTML =
      '<div class="msg error">Lost contact with the connector service. Retrying\\u2026</div>';
  }
  document.getElementById('clock').textContent = new Date().toLocaleString();
}

// ---- change password ----
function openPw() {
  document.getElementById('pwMsg').innerHTML = '';
  ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('pwBackdrop').classList.add('open');
  document.getElementById('pwCurrent').focus();
}
function closePw() { document.getElementById('pwBackdrop').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePw(); });

async function submitPw() {
  const msg = document.getElementById('pwMsg');
  const btn = document.getElementById('pwSubmit');
  const body = {
    current: document.getElementById('pwCurrent').value,
    password: document.getElementById('pwNew').value,
    confirm: document.getElementById('pwConfirm').value,
  };
  btn.disabled = true;
  try {
    const r = await j('/api/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      msg.innerHTML = '<div class="msg ok">Password updated. Signing you back in\\u2026</div>';
      setTimeout(() => { location.href = '/login'; }, 1200);
      return;
    }
    msg.innerHTML = '<div class="msg error">' + esc(r.error || 'Could not update the password.') + '</div>';
  } catch (err) {
    msg.innerHTML = '<div class="msg error">Request failed. Is the connector still running?</div>';
  }
  btn.disabled = false;
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
