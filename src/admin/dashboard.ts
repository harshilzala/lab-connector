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

/* ---- maximize: one machine fills the view, the rest step aside ---- */
.card-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.btn-max {
  border:1px solid var(--line); background:#fff; color:var(--mut); cursor:pointer;
  font:700 12px/1 var(--font); padding:6px 10px; border-radius:7px; white-space:nowrap;
  transition:background .15s,color .15s,border-color .15s;
}
.btn-max:hover { color:var(--teal-700); border-color:var(--teal-700); background:#fbfbfc; }
.grid.has-max { grid-template-columns:1fr; }
.grid.has-max .card:not(.is-max) { display:none; }
/* The whole point of maximizing is to read the wire log, so give the panel the
   height the grid layout could not. */
.card.is-max .panel { max-height:calc(100vh - 360px); min-height:420px; }

.tabs { display:flex; gap:6px; margin:0 0 12px; background:#f2f0f1; padding:4px; border-radius:10px; }
.tabs button {
  flex:1; border:0; background:transparent; color:var(--mut); cursor:pointer;
  font:700 13px/1 var(--font); padding:8px 10px; border-radius:7px; transition:background .15s,color .15s;
}
.tabs button:hover { color:var(--ink); }
.tabs button.active { background:#fff; color:var(--teal-700); box-shadow:0 1px 2px rgba(54,50,50,.12); }

.panel { border:1px solid var(--line); border-radius:10px; background:#fbfbfc; max-height:320px; overflow:auto; }
.panel .empty { padding:26px 16px; text-align:center; color:var(--mut); font-size:13px; }

.panel-tools { display:flex; align-items:center; gap:8px; margin:0 0 8px; }
.panel-tools .note { flex:1; min-width:0; font-size:12px; color:var(--mut); }
.btn.btn-danger { color:var(--bad); }
.btn.btn-danger:hover { background:rgba(199,58,58,.08); }
.btn[disabled] { opacity:.45; cursor:not-allowed; }

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
      <a class="btn btn-ghost btn-sm" href="/connector" title="Identify and connect a new machine">Connector Tool</a>
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
// state.max is the id of the maximized machine, or null for the normal grid.
// state.analyzers caches the last poll so toggling repaints without a fetch.
// state.scroll remembers where the operator had scrolled each panel, keyed by
// analyzer+tab. Needed because the 5s poll rebuilds the whole card grid, which
// destroys the panel element and would otherwise snap the view back to the top
// mid-read.
const state = { open: null, tab: 'wire', max: null, analyzers: [], scroll: {} };

const scrollKey = (id) => id + '|' + state.tab;

/**
 * Keep the operator's place across a re-render.
 *
 * The wire log is newest-first, so a new frame is PREPENDED and everything the
 * operator was reading shifts down. Restoring the raw pixel offset would still
 * move the text under their eyes, so the offset is corrected by however much
 * the content grew above it — the frame they were looking at stays put.
 *
 * Sitting at the very top is treated as "follow the latest": the view is left
 * at 0 so incoming frames appear naturally, which is the one case where NOT
 * moving is what the operator wants.
 */
function keepScroll(el, id) {
  const key = scrollKey(id);
  const prev = state.scroll[key];
  if (prev && prev.top > 0) {
    el.scrollTop = prev.top + (el.scrollHeight - prev.height);
  }
  const save = () => { state.scroll[key] = { top: el.scrollTop, height: el.scrollHeight }; };
  save();
  // One listener per element: this runs twice per poll (once when the grid is
  // rebuilt, once when the fetch lands) and the element outlives both calls.
  if (!el.dataset.scrollBound) {
    el.dataset.scrollBound = '1';
    el.addEventListener('scroll', save, { passive: true });
  }
}

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
function queuePill(a) {
  const sp = a.spool || { pending: 0, failed: 0 };
  // A staged analyzer has no queue: its results wait, per sample, for the
  // HMIS order to exist. "Waiting" is the honest word for that.
  if (a.filing === 'staged') {
    const st = a.staged || { waiting: 0, complete: 0 };
    if (st.waiting > 0) return '<span class="pill warn">' + st.waiting + ' waiting</span>';
    return '<span class="pill ok">Clear</span>';
  }
  if (sp.failed > 0)  return '<span class="pill bad">' + sp.failed + ' failed</span>';
  if (sp.pending > 0) return '<span class="pill warn">' + sp.pending + ' pending</span>';
  return '<span class="pill ok">Clear</span>';
}
// Order store + poller state. A poll error is the thing an operator must see:
// it means new orders are not reaching this analyzer.
function ordersLine(o) {
  if (!o) return '—';
  var stored = o.stored + ' stored';
  if (!o.pollEnabled) return esc(stored) + ' · poll off';
  if (o.lastPollError) return '<span class="pill bad">poll failing</span> ' + esc(stored) + ' · ' + esc(o.lastPollError);
  return esc(stored) + ' · polled ' + time(o.lastPollAt);
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
  state.analyzers = analyzers;
  // An analyzer dropped from the config must not leave the grid stuck on a
  // card that no longer renders.
  if (state.max && !analyzers.some(a => a.id === state.max)) state.max = null;

  const grid = document.getElementById('cards');
  grid.classList.toggle('has-max', !!state.max);

  // Rebuilding the grid throws away the open panel and replaces it with the
  // "Pick a view above" placeholder, and renderPanel only refills it once its
  // fetch returns. On the 5s poll that collapsed the panel and flashed the
  // operator's reading position away several times a minute. Carry the current
  // contents across so the panel is never empty in between.
  const openPanel = state.open ? document.getElementById('panel-' + state.open) : null;
  const carried = openPanel ? openPanel.innerHTML : null;

  grid.innerHTML = analyzers.map(a => \`
    <article class="card \${state.max === a.id ? 'is-max' : ''}">
      <div class="card-top">
        <div class="card-title">
          <div>
            <h3>\${esc(a.equipmentCode)}</h3>
            <div class="id">\${esc(a.id)}</div>
          </div>
          <div class="card-actions">
            \${statusPill(a)}
            <button class="btn-max" type="button" data-max="\${esc(a.id)}"
                    title="\${state.max === a.id ? 'Back to all machines (Esc)' : 'Show only this machine'}">
              \${state.max === a.id ? '&#8600; Normal view' : '&#8599; Maximize'}
            </button>
          </div>
        </div>
        <div class="meta">
          <span class="tag">\${esc(a.protocol.toUpperCase())}</span>
          <span>\${esc(a.endpoint)}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="kv"><span class="k">Last message</span><span class="v">\${time(a.lastMessageAt)}</span></div>
        <div class="kv"><span class="k">\${a.filing === 'staged' ? 'Results' : 'Upload queue'}</span><span class="v">\${queuePill(a)}</span></div>
        <div class="kv"><span class="k">Orders</span><span class="v">\${ordersLine(a.orders)}</span></div>
        <div class="tabs">
          <button type="button" data-a="\${esc(a.id)}" data-t="wire"
                  class="\${state.open === a.id && state.tab === 'wire' ? 'active' : ''}">Wire log</button>
          <button type="button" data-a="\${esc(a.id)}" data-t="spool"
                  class="\${state.open === a.id && state.tab === 'spool' ? 'active' : ''}">\${a.filing === 'staged' ? 'Results' : 'Upload queue'}</button>
        </div>
        <div id="tools-\${esc(a.id)}"></div>
        <div class="panel" id="panel-\${esc(a.id)}">
          <div class="empty">Pick a view above.</div>
        </div>
      </div>
    </article>\`).join('');

  // Put the carried contents back before the browser paints, so the panel keeps
  // both its text and the operator's scroll position while renderPanel refetches.
  if (carried !== null) {
    const fresh = document.getElementById('panel-' + state.open);
    if (fresh) {
      fresh.innerHTML = carried;
      keepScroll(fresh, state.open);
    }
  }

  document.querySelectorAll('button[data-max]').forEach(b => {
    b.onclick = () => setMax(state.max === b.dataset.max ? null : b.dataset.max);
  });

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

/** Switch between the grid and a single maximized machine. */
function setMax(id) {
  state.max = id;
  // Maximizing is always "I want to watch this one", so open its panel rather
  // than leaving the card showing "Pick a view above".
  if (id) state.open = id;
  renderCards(state.analyzers);
  if (state.open) renderPanel(state.open);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.max) setMax(null);
});

async function renderPanel(id) {
  const el = document.getElementById('panel-' + id);
  if (!el) return;
  const tools = document.getElementById('tools-' + id);

  if (state.tab === 'wire') {
    const { wire } = await j('/api/analyzers/' + encodeURIComponent(id) + '/wire');
    const rows = (wire || []).slice(-30).reverse();
    // Refresh pulls the log on demand — the 5s poll can lag a live exchange —
    // and Clear empties it so the next exchange can be read on its own.
    if (tools) {
      tools.innerHTML =
        '<div class="panel-tools"><span class="note">' +
        (rows.length ? 'latest ' + rows.length + ' frame(s)' : 'no frames') + '</span>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-wire-refresh="1">Refresh</button>' +
        '<button class="btn btn-ghost btn-sm btn-danger" type="button" data-wire-clear="1"' +
        (rows.length ? '' : ' disabled') + '>Clear</button></div>';
      const r = tools.querySelector('[data-wire-refresh]');
      if (r) r.onclick = () => renderPanel(id);
      const c = tools.querySelector('[data-wire-clear]');
      if (c) c.onclick = () => clearWire(id);
    }
    el.innerHTML = rows.length
      ? '<ul class="wire">' + rows.map(w =>
          '<li><div class="head"><span class="dir ' + esc(w.direction) + '">' + esc(w.direction) + '</span>' +
          '<span>' + time(w.at) + '</span></div><pre>' + esc(w.text) + '</pre></li>').join('') + '</ul>'
      : '<div class="empty">No traffic on the wire yet.</div>';
    keepScroll(el, id);
    return;
  }

  if (tools) tools.innerHTML = '';
  const an = (state.analyzers || []).find(a => a.id === id);
  if (an && an.filing === 'staged') return renderStaged(id, el);
  const s = await j('/api/analyzers/' + encodeURIComponent(id) + '/spool');
  // Ids and barcodes ride in attributes, so they go through esc() here too.
  const removeBtn = (env) =>
    '<button class="btn btn-ghost btn-sm btn-danger" type="button" data-q-remove="' + esc(env.id) +
    '" data-q-barcode="' + esc(env.payload.barcode) + '">Remove</button>';
  // A remainder item holds only the analytes that had no order row; the rest of
  // the sample is already filed and acknowledged. Saying "queued" against the
  // bare barcode reads as though nothing reached HMIS, so show the split.
  const partly = (env) => {
    const filed = (env.payload && env.payload.filedAnalytes) || 0;
    if (!filed) return '';
    const left = ((env.payload && env.payload.results) || []).length;
    return '<div class="err">' + filed + ' analyte' + (filed === 1 ? '' : 's') +
      ' already filed to HMIS &mdash; ' + left + ' still ' + (left === 1 ? 'has' : 'have') +
      ' no order row</div>';
  };
  const failed = (s.failed || []).map(f =>
    '<li><div class="grow"><div class="barcode">' + esc(f.payload.barcode) + '</div>' +
    partly(f) +
    '<div class="err">' + esc(f.lastError || 'delivery failed') + '</div></div>' +
    '<span class="pill bad">' + f.attempts + ' tries</span>' +
    '<button class="btn btn-ghost btn-sm" type="button" data-q-retry="' + esc(f.id) + '">Retry</button>' +
    removeBtn(f) + '</li>').join('');
  const pending = (s.pending || []).map(p => {
    const filed = (p.payload && p.payload.filedAnalytes) || 0;
    return '<li><div class="grow"><div class="barcode">' + esc(p.payload.barcode) + '</div>' +
      partly(p) + '</div>' +
      '<span class="pill ' + (filed ? 'mut' : 'warn') + '">' +
      (filed ? 'partly filed' : 'queued') + '</span>' + removeBtn(p) + '</li>';
  }).join('');

  el.innerHTML = (failed || pending)
    ? '<ul class="q">' + failed + pending + '</ul>'
    : '<div class="empty">Upload queue is empty &mdash; everything has reached the HMIS.</div>';

  el.querySelectorAll('[data-q-retry]').forEach(b => { b.onclick = () => retry(id, b.dataset.qRetry); });
  el.querySelectorAll('[data-q-remove]').forEach(b => {
    b.onclick = () => removeQueued(id, b.dataset.qRemove, b.dataset.qBarcode);
  });
  keepScroll(el, id);
}

// Staged analyzers (filing.mode "staged"): one row per sample, showing how
// much of it has reached HMIS and what is still waiting for an order row.
async function renderStaged(id, el) {
  const { samples } = await j('/api/analyzers/' + encodeURIComponent(id) + '/staged');
  const rows = (samples || []).map(s => {
    const pill = s.complete
      ? '<span class="pill ok">filed</span>'
      : (s.filed > 0 ? '<span class="pill mut">partly filed</span>' : '<span class="pill warn">waiting for order</span>');
    const codes = (s.waitingCodes || []);
    const detail = s.filed + ' of ' + s.total + ' filed' +
      (s.waiting ? ' &mdash; ' + s.waiting + ' waiting: ' + esc(codes.slice(0, 8).join(', ')) + (codes.length > 8 ? ' &hellip;' : '') : '') +
      (s.dropped ? ' &mdash; ' + s.dropped + ' not interfaced' : '');
    const when = 'received ' + time(s.firstReceivedAt) +
      (s.lastCheckedAt ? ' · HMIS asked ' + time(s.lastCheckedAt) : '') +
      (s.attempts ? ' · ' + s.attempts + ' pass' + (s.attempts === 1 ? '' : 'es') : '');
    const from = s.rekeyedFrom ? '<div class="err">re-keyed from ' + esc(s.rekeyedFrom) + '</div>' : '';
    const err = (s.lastError && !s.complete && !/^no order row yet/.test(s.lastError))
      ? '<div class="err">' + esc(s.lastError) + '</div>' : '';
    const actions = s.complete ? '' :
      '<button class="btn btn-ghost btn-sm" type="button" data-s-file="' + esc(s.barcode) + '">File now</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-s-rekey="' + esc(s.barcode) + '">Re-key</button>';
    return '<li><div class="grow"><div class="barcode">' + esc(s.barcode) + '</div>' +
      '<div class="err">' + detail + '</div><div class="err">' + esc(when) + '</div>' + from + err + '</div>' +
      pill + actions +
      '<button class="btn btn-ghost btn-sm btn-danger" type="button" data-s-remove="' + esc(s.barcode) + '">Remove</button></li>';
  }).join('');
  el.innerHTML = rows
    ? '<ul class="q">' + rows + '</ul>'
    : '<div class="empty">No staged results &mdash; everything received has reached the HMIS.</div>';
  el.querySelectorAll('[data-s-file]').forEach(b => { b.onclick = () => stagedFile(id, b.dataset.sFile); });
  el.querySelectorAll('[data-s-rekey]').forEach(b => { b.onclick = () => stagedRekey(id, b.dataset.sRekey); });
  el.querySelectorAll('[data-s-remove]').forEach(b => { b.onclick = () => stagedRemove(id, b.dataset.sRemove); });
  keepScroll(el, id);
}

async function stagedFile(id, barcode) {
  await j('/api/analyzers/' + encodeURIComponent(id) + '/staged/' + encodeURIComponent(barcode) + '/file', { method: 'POST' });
  renderPanel(id);
}

// The fix for a sample the operator typed wrongly on the instrument (an MRN, a
// short number, a name): move its values to the real tube barcode and file.
async function stagedRekey(id, barcode) {
  const to = prompt('Move the results of ' + barcode + ' to which barcode?\\n\\nType the barcode exactly as printed on the tube.');
  if (!to || !to.trim()) return;
  const r = await j('/api/analyzers/' + encodeURIComponent(id) + '/staged/' + encodeURIComponent(barcode) + '/rekey',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: to.trim() }) });
  if (r && r.error) alert(r.error);
  refresh();
  renderPanel(id);
}

async function stagedRemove(id, barcode) {
  if (!confirm('Remove sample ' + barcode + ' from the result store?\\n\\nIts unfiled values will never be sent to the HMIS.')) return;
  await j('/api/analyzers/' + encodeURIComponent(id) + '/staged/' + encodeURIComponent(barcode), { method: 'DELETE' });
  refresh();
  renderPanel(id);
}

async function retry(id, msgId) {
  await j('/api/analyzers/' + encodeURIComponent(id) + '/retry/' + encodeURIComponent(msgId), { method: 'POST' });
  renderPanel(id);
}

// Dropping a sample means its results never reach the HMIS — name the barcode
// in the prompt so the operator sees exactly what they are discarding.
async function removeQueued(id, msgId, barcode) {
  if (!confirm('Remove sample ' + barcode + ' from the upload queue?\\n\\nIts results will not be sent to the HMIS.')) return;
  await j('/api/analyzers/' + encodeURIComponent(id) + '/queue/' + encodeURIComponent(msgId), { method: 'DELETE' });
  refresh(); // the queue counts on the tiles and the card pill move too
}

async function clearWire(id) {
  if (!confirm('Clear the wire log for this analyzer?\\n\\nThe on-disk log keeps the full record.')) return;
  await j('/api/analyzers/' + encodeURIComponent(id) + '/wire', { method: 'DELETE' });
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
