import { BASE_CSS, FONT_LINK } from './theme.js';

// IM dashboard — auto-certification of analyzer results, served at GET /im to
// an authenticated session. Same brand and card language as the operations
// dashboard; four views:
//
//   Action required  values the gate held, one sample per row; Review opens
//                    the sample with every value, its range and why it was
//                    held, and Verify & send / Reject
//   Orders           every order IM has seen, newest first, with its status;
//                    expanding one shows its Mirth rows and its whole
//                    transaction history, in order
//   Machines         the analyzers, as on the main dashboard, each expandable
//                    to its IM log and wire log
//   Mirth            where IM connects, the certification columns it adds,
//                    the columns Mirth actually sends, a live barcode lookup,
//                    a "what would we send" preview and the latest exchanges
//
// All client code builds HTML by string concatenation and escapes every value
// that came from an analyzer, from Mirth or from a person.

export interface ImDashboardOptions {
  username: string;
  enabled: boolean;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_CSS = `
body { display:flex; flex-direction:column; min-height:100vh; }
.topbar { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--line); box-shadow:0 1px 3px rgba(54,50,50,.04); }
.topbar-inner { max-width:1320px; margin:0 auto; padding:12px 24px; display:flex; align-items:center; gap:18px; }
.brand { display:flex; align-items:center; gap:14px; min-width:0; }
.brand .divider { width:1px; height:34px; background:var(--line); }
.brand h1 { font-size:17px; letter-spacing:-.2px; }
.brand .sub { font-size:12px; color:var(--mut); font-weight:600; letter-spacing:.3px; text-transform:uppercase; }
.spacer { flex:1; }
.tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.clock { font-size:13px; color:var(--mut); font-variant-numeric:tabular-nums; }
.who { display:flex; align-items:center; gap:8px; padding:5px 12px 5px 6px; background:var(--teal-soft); border-radius:999px; font-size:13px; font-weight:700; color:var(--teal-700); }
.who .avatar { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; background:var(--teal); color:#fff; font-size:12px; font-weight:800; }
.btn.is-here { background:var(--teal-soft); border-color:var(--teal); color:var(--teal-700); }

main { flex:1; width:100%; max-width:1320px; margin:0 auto; padding:24px 24px 40px; }

.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin:0 0 22px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow); position:relative; overflow:hidden; }
.stat::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--teal); }
.stat.accent-plum::before { background:var(--plum); }
.stat.accent-warn::before { background:var(--warn); }
.stat.accent-bad::before  { background:var(--bad); }
.stat.accent-ok::before   { background:var(--ok); }
.stat .k { font-size:11px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:var(--mut); }
.stat .v { font-size:26px; font-weight:800; color:var(--ink); line-height:1.15; margin-top:6px; font-variant-numeric:tabular-nums; }
.stat .n { font-size:12px; color:var(--mut); margin-top:2px; }

.viewtabs { display:flex; gap:6px; margin:0 0 16px; background:#f2f0f1; padding:4px; border-radius:12px; flex-wrap:wrap; }
.viewtabs button { flex:1; min-width:150px; border:0; background:transparent; color:var(--mut); cursor:pointer; font:700 14px/1 var(--font); padding:11px 12px; border-radius:9px; }
.viewtabs button:hover { color:var(--ink); }
.viewtabs button.active { background:#fff; color:var(--teal-700); box-shadow:0 1px 2px rgba(54,50,50,.12); }
.badge { display:inline-block; min-width:20px; padding:2px 7px; margin-left:6px; border-radius:999px; background:var(--bad); color:#fff; font-size:11.5px; }
.badge.zero { background:#d9d5d7; }

.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
.card + .card { margin-top:16px; }
.card-h { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.card-h h2 { font-size:15px; }
.card-h .mut { font-size:12.5px; }
.card-b { padding:14px 18px 18px; }

.filters { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.filters select, .filters input { padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:400 13.5px var(--font); background:#fff; color:var(--ink); }
.filters input { min-width:200px; }

table.t { width:100%; border-collapse:collapse; font-size:13.5px; }
table.t th { text-align:left; font-size:11px; letter-spacing:.5px; text-transform:uppercase; color:var(--mut); font-weight:800; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
table.t td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
table.t tr.row { cursor:pointer; }
table.t tr.row:hover td { background:#fafbfb; }
table.t tr.open td { background:var(--teal-soft); }
.wrap-x { overflow-x:auto; }
.mono { font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace; }
.bc { font:700 13px/1.3 "Cascadia Mono",Consolas,monospace; color:var(--ink); }
.small { font-size:12px; color:var(--mut); }
.chips { display:flex; flex-wrap:wrap; gap:4px; }
.chip { display:inline-block; padding:1px 7px; border-radius:5px; font:700 11.5px/1.6 "Cascadia Mono",Consolas,monospace; background:#f1eff0; color:var(--body); }
.chip.bad { background:var(--bad-soft); color:var(--bad); }
.chip.warn { background:var(--warn-soft); color:var(--warn); }
.chip.ok { background:var(--ok-soft); color:var(--ok); }
.empty { padding:28px 16px; text-align:center; color:var(--mut); font-size:13.5px; }

.pill.plum { background:var(--plum-soft); color:var(--plum-600); }
.pill.teal { background:var(--teal-soft); color:var(--teal-700); }

.detail { padding:6px 4px 12px; }
.detail h4 { font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); margin:12px 0 6px; }
.timeline { list-style:none; margin:0; padding:0 0 0 14px; border-left:2px solid var(--line); }
.timeline li { position:relative; padding:4px 0 8px 12px; font-size:13px; }
.timeline li::before { content:""; position:absolute; left:-20px; top:10px; width:10px; height:10px; border-radius:50%; background:var(--teal); border:2px solid #fff; box-shadow:0 0 0 1px var(--line); }
.timeline li.k-held::before, .timeline li.k-file-failed::before, .timeline li.k-order-send-failed::before, .timeline li.k-ack-failed::before { background:var(--bad); }
.timeline li.k-verified::before, .timeline li.k-filed::before, .timeline li.k-certified::before { background:var(--ok); }
.timeline li.k-rejected::before { background:var(--warn); }
.timeline li.k-order-received::before, .timeline li.k-query::before { background:var(--plum); }
.timeline .when { font-size:11.5px; color:var(--mut); font-variant-numeric:tabular-nums; margin-right:8px; }
.timeline .kind { font-size:10.5px; font-weight:800; letter-spacing:.4px; text-transform:uppercase; color:var(--mut); margin-right:6px; }
.timeline details { margin-top:3px; }
.timeline summary { cursor:pointer; font-size:11.5px; color:var(--mut); }
pre.code { margin:6px 0 0; padding:10px 12px; background:#fbfbfc; border:1px solid var(--line); border-radius:8px; font:12px/1.5 "Cascadia Mono",Consolas,monospace; white-space:pre-wrap; word-break:break-all; max-height:360px; overflow:auto; color:var(--ink); }

.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(380px,1fr)); gap:16px; }
.mcard .card-top { padding:14px 18px 12px; border-bottom:1px solid var(--line); }
.mcard .title { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.mcard h3 { font-size:15.5px; }
.mcard .id { font-size:12px; color:var(--mut); font-weight:600; }
.mcard .meta { display:flex; flex-wrap:wrap; gap:6px 10px; margin-top:8px; font-size:12.5px; color:var(--mut); }
.tag { display:inline-block; padding:2px 9px; border-radius:6px; background:var(--plum-soft); color:var(--plum-600); font-weight:700; font-size:11.5px; }
.kv { display:flex; justify-content:space-between; gap:12px; padding:6px 0; font-size:13px; border-top:1px dashed var(--line); }
.kv:first-child { border-top:0; }
.kv .k { color:var(--mut); }
.kv .v { color:var(--ink); font-weight:600; text-align:right; }
.minitabs { display:flex; gap:6px; margin:12px 0 10px; background:#f2f0f1; padding:4px; border-radius:10px; }
.minitabs button { flex:1; border:0; background:transparent; color:var(--mut); cursor:pointer; font:700 12.5px/1 var(--font); padding:8px; border-radius:7px; }
.minitabs button.active { background:#fff; color:var(--teal-700); box-shadow:0 1px 2px rgba(54,50,50,.12); }
.panel { border:1px solid var(--line); border-radius:10px; background:#fbfbfc; max-height:340px; overflow:auto; }
.plist { list-style:none; margin:0; padding:0; }
.plist li { padding:8px 12px; border-bottom:1px solid var(--line); font-size:12.5px; }
.plist li:last-child { border-bottom:0; }
.plist .head { display:flex; gap:8px; font-size:11.5px; color:var(--mut); margin-bottom:2px; align-items:center; }
.dir { font-weight:800; font-size:10.5px; padding:1px 7px; border-radius:5px; }
.dir.IN { background:var(--teal-soft); color:var(--teal-700); }
.dir.OUT { background:var(--plum-soft); color:var(--plum-600); }
.plist pre { margin:0; font:12px/1.5 "Cascadia Mono",Consolas,monospace; white-space:pre-wrap; word-break:break-all; color:var(--ink); }

.two { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.form-row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
.form-row .f { display:flex; flex-direction:column; gap:4px; }
.form-row select, .form-row input { padding:9px 10px; border:1px solid var(--line); border-radius:8px; font:400 14px var(--font); }

/* ---- review dialog ---- */
.backdrop { position:fixed; inset:0; background:rgba(54,50,50,.45); display:none; align-items:flex-start; justify-content:center; padding:40px 20px; z-index:50; overflow:auto; }
.backdrop.open { display:flex; }
.modal { width:100%; max-width:920px; background:#fff; border-radius:18px; box-shadow:0 24px 60px rgba(54,50,50,.28); padding:22px 24px 20px; }
.modal h2 { font-size:18px; }
.modal .lead { margin:4px 0 14px; font-size:13.5px; color:var(--mut); }
.modal .row { display:flex; gap:10px; margin-top:16px; justify-content:flex-end; flex-wrap:wrap; }
.modal textarea { width:100%; min-height:60px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; font:400 14px var(--font); resize:vertical; }
.modal .fields { display:grid; grid-template-columns:1fr 2fr; gap:12px; margin-top:14px; }
tr.v-hold td { background:#fff8f8; }
tr.v-critical td { background:var(--bad-soft); }
tr.v-certify td { color:var(--mut); }
.val { font:700 13.5px "Cascadia Mono",Consolas,monospace; color:var(--ink); }
.btn-danger { color:var(--bad); }
.btn-warnish { color:var(--warn); }

footer.pagefoot { padding:16px 24px 28px; text-align:center; font-size:12.5px; color:var(--mut); }
@media (max-width:820px) {
  .topbar-inner { flex-wrap:wrap; padding:12px 16px; }
  main { padding:18px 16px 30px; }
  .two, .modal .fields { grid-template-columns:1fr; }
  .grid { grid-template-columns:1fr; }
}
`;

export function renderImDashboard(o: ImDashboardOptions): string {
  const initial = esc((o.username[0] ?? 'A').toUpperCase());
  const off = o.enabled
    ? ''
    : `<div class="msg info" role="status" style="margin-bottom:18px">
         <strong>IM is switched off.</strong> Results are filed to Mirth exactly as before, with no
         reference-range check. Set <span class="mono">"im": { "enabled": true }</span> in config.json and
         restart the service to turn auto-certification on.
       </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>IM Dashboard &middot; Lab Connector</title>
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
        <div class="sub">Result auto-certification</div>
        <h1>IM Dashboard</h1>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="tools">
      <span class="clock" id="clock"></span>
      <span class="who"><span class="avatar">${initial}</span>${esc(o.username)}</span>
      <a class="btn btn-ghost btn-sm" href="/">Lab Connector</a>
      <a class="btn btn-ghost btn-sm is-here" href="/im">IM Dashboard</a>
      <a class="btn btn-ghost btn-sm" href="/connector">Connector Tool</a>
      <form method="post" action="/logout" style="margin:0"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
    </div>
  </div>
</header>

<main>
  ${off}
  <div id="alert"></div>
  <section class="stats" id="stats"></section>
  <nav class="viewtabs" id="viewtabs">
    <button type="button" data-view="review">Action required<span class="badge zero" id="badge">0</span></button>
    <button type="button" data-view="orders">Orders &amp; transactions</button>
    <button type="button" data-view="machines">Machines</button>
    <button type="button" data-view="mirth">Mirth</button>
  </nav>
  <section id="view"></section>
</main>

<footer class="pagefoot">Zydus Hospitals &middot; Lab Connector &middot; IM &mdash; in-range results are certified and sent automatically; everything else waits here for a person.</footer>

<div class="backdrop" id="rvBackdrop" role="dialog" aria-modal="true" aria-labelledby="rvTitle">
  <div class="modal" id="rvModal"></div>
</div>

<script>
var IM_ENABLED = ${o.enabled ? 'true' : 'false'};
var state = {
  view: 'review',
  overview: null,
  orders: [],
  expanded: {},       // analyzer|barcode -> true
  detail: {},         // analyzer|barcode -> last fetched detail
  filter: { analyzer: '', status: '', q: '' },
  machineOpen: {},    // analyzer -> 'im' | 'wire' (absent = collapsed)
  review: null,       // the sample open in the dialog
  busy: false,
};
try { var v = localStorage.getItem('im.view'); if (v) state.view = v; } catch (e) {}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function time(iso) { return iso ? new Date(iso).toLocaleTimeString() : '\\u2014'; }
function when(iso) {
  if (!iso) return '\\u2014';
  var d = new Date(iso);
  var today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString() : d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}
function key(a, b) { return a + '|' + b; }

async function j(url, opts) {
  var r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  var body = await r.json().catch(function () { return {}; });
  if (!r.ok && !body.error) body.error = 'HTTP ' + r.status;
  return body;
}
function post(url, data) {
  return j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) });
}

// ---- status words ----------------------------------------------------------
var STATUS = {
  'ordered':          ['plum', 'Ordered'],
  'sent-to-analyzer': ['teal', 'Sent to analyzer'],
  'send-failed':      ['bad',  'Send failed'],
  'resulted':         ['warn', 'Result received'],
  'action-required':  ['bad',  'Action required'],
  'mirth-error':      ['bad',  'Mirth error'],
  'completed':        ['ok',   'Sent to Mirth'],
  'rejected':         ['mut',  'Rejected'],
};
function statusPill(s) { var x = STATUS[s] || ['mut', s]; return '<span class="pill ' + x[0] + '">' + esc(x[1]) + '</span>'; }
var REASON = {
  'critical': 'Critical', 'out-of-range': 'Out of range', 'analyzer-flag': 'Analyzer flag',
  'not-numeric': 'Not numeric', 'not-final': 'Not final', 'no-range': 'No range', 'always-review': 'Always review', 'in-range': 'In range',
};
function reasonChip(r) {
  var cls = r === 'critical' || r === 'out-of-range' ? 'bad' : r === 'in-range' ? 'ok' : 'warn';
  return '<span class="chip ' + cls + '">' + esc(REASON[r] || r) + '</span>';
}
function linkPill(a) {
  var link = a.link || (a.connected ? 'connected' : 'offline');
  if (link === 'connected') return '<span class="pill ok">Connected</span>';
  if (link === 'listening') return '<span class="pill mut">Listening</span>';
  return '<span class="pill bad"' + (a.linkError ? ' title="' + esc(a.linkError) + '"' : '') + '>Offline</span>';
}
function analyzerName(id) {
  var a = (state.overview && state.overview.analyzers || []).find(function (x) { return x.status.id === id; });
  return a ? a.status.equipmentCode : id;
}

// ---- tiles -------------------------------------------------------------------
function renderStats() {
  var list = (state.overview && state.overview.analyzers) || [];
  var sum = function (f) { return list.reduce(function (n, a) { return n + (a.im ? f(a.im.counts) : 0); }, 0); };
  var online = list.filter(function (a) { return a.status.connected || a.status.link === 'listening'; }).length;
  var action = list.reduce(function (n, a) { return n + (a.im ? a.im.counts.actionRequired.samples : 0); }, 0);
  var actionValues = list.reduce(function (n, a) { return n + (a.im ? a.im.counts.actionRequired.values : 0); }, 0);
  var gating = list.filter(function (a) { return a.im && a.im.gating; }).length;
  var errors = sum(function (c) { return c.errorsToday; });
  var tiles = [
    { k: 'Machines online', v: online + '/' + list.length, n: gating + ' auto-certifying', a: online === list.length ? '' : 'accent-bad' },
    { k: 'Orders from Mirth', v: sum(function (c) { return c.ordersToday; }), n: 'received today', a: 'accent-plum' },
    { k: 'Sent to analyzer', v: sum(function (c) { return c.sentToday; }), n: 'order lines today', a: '' },
    { k: 'Results received', v: sum(function (c) { return c.resultsToday; }), n: 'messages today', a: '' },
    { k: 'Auto-certified', v: sum(function (c) { return c.autoCertifiedToday; }), n: 'samples in range today', a: 'accent-ok' },
    { k: 'Action required', v: action, n: actionValues + ' value' + (actionValues === 1 ? '' : 's') + ' to verify', a: action ? 'accent-bad' : 'accent-ok' },
    { k: 'Sent to Mirth', v: sum(function (c) { return c.filedToday; }), n: errors ? errors + ' error' + (errors === 1 ? '' : 's') + ' today' : 'no errors today', a: errors ? 'accent-warn' : '' },
  ];
  document.getElementById('stats').innerHTML = tiles.map(function (t) {
    return '<div class="stat ' + t.a + '"><div class="k">' + esc(t.k) + '</div><div class="v">' + esc(t.v) + '</div><div class="n">' + esc(t.n) + '</div></div>';
  }).join('');
  var b = document.getElementById('badge');
  b.textContent = action;
  b.className = 'badge' + (action ? '' : ' zero');
}

// ---- view switch ---------------------------------------------------------------
function setView(v) {
  state.view = v;
  try { localStorage.setItem('im.view', v); } catch (e) {}
  document.querySelectorAll('#viewtabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
  renderView(true);
}
document.querySelectorAll('#viewtabs button').forEach(function (b) { b.onclick = function () { setView(b.dataset.view); }; });

async function renderView(fresh) {
  if (!IM_ENABLED && state.view !== 'machines') {
    document.getElementById('view').innerHTML = '<div class="card"><div class="empty">IM is off, so nothing is being validated or held. The Machines view still shows the analyzers.</div></div>';
    return;
  }
  if (state.view === 'review') return renderReviewList();
  if (state.view === 'orders') return renderOrders(fresh);
  if (state.view === 'machines') return renderMachines(fresh);
  if (state.view === 'mirth') return renderMirth(fresh);
}

// ================================================================================
// Action required
// ================================================================================
async function renderReviewList() {
  var r = await j('/api/im/review');
  if (state.view !== 'review') return;
  var samples = (r.samples || []);
  var open = samples.filter(function (s) { return s.pending > 0; });
  var done = samples.filter(function (s) { return s.pending === 0; }).slice(0, 30);
  var row = function (s) {
    var held = s.items.filter(function (i) { return i.state === 'pending'; });
    var chips = held.map(function (i) {
      var r = i.verdict.reason;
      return '<span class="chip ' + (r === 'critical' || r === 'out-of-range' ? 'bad' : 'warn') + '" title="' + esc(i.verdict.detail || '') + '">' +
        esc(i.testCode) + ' ' + esc(i.value) + '</span>';
    }).join('');
    var decided = s.items.filter(function (i) { return i.state !== 'pending'; }).map(function (i) {
      return '<span class="chip ' + (i.state === 'verified' ? 'ok' : '') + '">' + esc(i.testCode) + ' ' + esc(i.state) + (i.state === 'verified' && !i.filedAt ? ' (not sent)' : '') + '</span>';
    }).join('');
    var p = s.patient ? esc([s.patient.id, s.patient.name, s.patient.sex].filter(Boolean).join(' \\u00b7 ')) : '<span class="small">no demographics</span>';
    return '<tr><td><div class="bc">' + esc(s.barcode) + '</div><div class="small">' + esc(analyzerName(s.analyzer)) + '</div></td>' +
      '<td>' + p + '</td>' +
      '<td>' + (s.worst ? reasonChip(s.worst) : '') + '</td>' +
      '<td><div class="chips">' + chips + decided + '</div></td>' +
      '<td class="small">' + esc(when(s.firstHeldAt)) + '</td>' +
      '<td><button class="btn ' + (s.pending ? 'btn-primary' : 'btn-ghost') + ' btn-sm" type="button" data-rv="' + esc(s.analyzer) + '|' + esc(s.barcode) + '">' + (s.pending ? 'Review' : 'Open') + '</button></td></tr>';
  };
  var head = '<tr><th>Barcode</th><th>Patient</th><th>Worst</th><th>Values</th><th>Held at</th><th></th></tr>';
  document.getElementById('view').innerHTML =
    '<div class="card"><div class="card-h"><h2>Action required</h2><span class="mut">' + open.length + ' sample' + (open.length === 1 ? '' : 's') +
    ' waiting for a person &mdash; values outside the reference range, flagged by the analyzer, or with no range to certify against.</span></div>' +
    (open.length ? '<div class="wrap-x"><table class="t">' + head + open.map(row).join('') + '</table></div>'
                 : '<div class="empty">Nothing to verify. Every result received has been certified or decided.</div>') + '</div>' +
    (done.length ? '<div class="card"><div class="card-h"><h2>Recently decided</h2></div><div class="wrap-x"><table class="t">' + head + done.map(row).join('') + '</table></div></div>' : '');
  document.querySelectorAll('[data-rv]').forEach(function (b) {
    b.onclick = function () { var p = b.dataset.rv.split('|'); openReview(p[0], p.slice(1).join('|')); };
  });
}

async function openReview(analyzer, barcode) {
  var d = await j('/api/im/analyzers/' + encodeURIComponent(analyzer) + '/orders/' + encodeURIComponent(barcode));
  if (d.error) { alert(d.error); return; }
  state.review = d;
  drawReview();
  document.getElementById('rvBackdrop').classList.add('open');
}
function closeReview() { document.getElementById('rvBackdrop').classList.remove('open'); state.review = null; }
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeReview(); });

function drawReview(msg) {
  var d = state.review;
  var rv = d.review || { items: [] };
  var items = rv.items || [];
  var pending = items.filter(function (i) { return i.state === 'pending'; });
  var unfiled = items.filter(function (i) { return i.state === 'verified' && !i.filedAt; });
  var p = rv.patient || (d.order && d.order.patient ? { id: d.order.patient.patientId, name: [d.order.patient.firstName, d.order.patient.lastName].filter(Boolean).join(' '), sex: d.order.patient.sex } : null);
  var rows = items.map(function (i) {
    var v = i.verdict;
    var cls = i.state === 'pending' ? (v.reason === 'critical' ? 'v-critical' : 'v-hold') : '';
    var box = i.state === 'pending' ? '<input type="checkbox" class="rv-pick" value="' + esc(i.testCode) + '" checked />' : '';
    var st = i.state === 'pending' ? '<span class="pill bad">Pending</span>'
      : i.state === 'verified' ? '<span class="pill ok">Verified</span>' + (i.filedAt ? '' : ' <span class="pill warn" title="' + esc(i.lastError || '') + '">not sent</span>')
      : '<span class="pill mut">Rejected</span>';
    var by = i.decidedBy ? '<div class="small">' + esc(i.decidedBy) + ' \\u00b7 ' + esc(when(i.decidedAt)) + (i.comment ? ' \\u00b7 \\u201c' + esc(i.comment) + '\\u201d' : '') + '</div>' : '';
    return '<tr class="' + cls + '"><td>' + box + '</td><td class="mono"><b>' + esc(i.testCode) + '</b>' +
      (i.identifier && i.identifier !== i.testCode ? '<div class="small">as ' + esc(i.identifier) + '</div>' : '') + '</td>' +
      '<td><span class="val">' + esc(i.value) + '</span> <span class="small">' + esc(i.unit || '') + '</span></td>' +
      '<td class="mono">' + esc(v.range ? v.range.text : '\\u2014') + (v.range ? '<div class="small">' + esc(v.range.source) + '</div>' : '') + '</td>' +
      '<td>' + reasonChip(v.reason) + '<div class="small">' + esc(v.detail || '') + '</div></td>' +
      '<td>' + st + by + '</td></tr>';
  }).join('');
  // Everything the analyzer sent for this sample that was certified, for context.
  var certified = (d.history || []).filter(function (t) { return t.kind === 'certified'; })
    .flatMap(function (t) { return (t.detail && t.detail.values) || []; });
  var ctx = certified.length ? '<h4 style="margin:16px 0 6px;font-size:12px;text-transform:uppercase;color:var(--mut)">Already auto-certified on this sample</h4><div class="chips">' +
    certified.map(function (v) { return '<span class="chip ok" title="' + esc((v.range || '') + ' ' + (v.rangeSource || '')) + '">' + esc(v.code) + ' ' + esc(v.value) + '</span>'; }).join('') + '</div>' : '';
  var canAct = pending.length > 0;
  document.getElementById('rvModal').innerHTML =
    '<h2 id="rvTitle">Review ' + esc(d.barcode) + '</h2>' +
    '<p class="lead">' + esc(analyzerName(d.analyzer)) + (p ? ' \\u00b7 ' + esc([p.id, p.name, p.sex].filter(Boolean).join(' \\u00b7 ')) : '') +
    '. Verified values are sent to Mirth as <b>certified by you</b>; rejected values are never sent.</p>' +
    (msg || '') +
    '<div class="wrap-x"><table class="t"><tr><th></th><th>Test</th><th>Value</th><th>Reference</th><th>Why held</th><th>Status</th></tr>' + rows + '</table></div>' + ctx +
    (canAct || unfiled.length ?
      '<div class="fields"><div><label for="rvBy">Verified by</label><input id="rvBy" type="text" autocomplete="off" placeholder="Your name" /></div>' +
      '<div><label for="rvComment">Comment <span class="small">(required to reject)</span></label><textarea id="rvComment" placeholder="e.g. Checked against the analyzer printout; clinically consistent."></textarea></div></div>' : '') +
    '<div class="row">' +
      '<button class="btn btn-ghost" type="button" id="rvClose">Close</button>' +
      '<button class="btn btn-ghost" type="button" id="rvRerun" title="Push this order to the analyzer again so the sample can be re-run">Re-run on analyzer</button>' +
      (canAct ? '<button class="btn btn-ghost btn-danger" type="button" id="rvReject">Reject selected</button>' : '') +
      (canAct ? '<button class="btn btn-primary" type="button" id="rvVerify">Verify &amp; send to Mirth</button>'
              : unfiled.length ? '<button class="btn btn-primary" type="button" id="rvRetry">Retry sending verified values</button>' : '') +
    '</div>';
  try { var n = localStorage.getItem('im.verifier'); if (n && document.getElementById('rvBy')) document.getElementById('rvBy').value = n; } catch (e) {}
  document.getElementById('rvClose').onclick = closeReview;
  document.getElementById('rvRerun').onclick = rerun;
  var vb = document.getElementById('rvVerify'); if (vb) vb.onclick = function () { decide('verify'); };
  var rb = document.getElementById('rvReject'); if (rb) rb.onclick = function () { decide('reject'); };
  var tb = document.getElementById('rvRetry'); if (tb) tb.onclick = function () { decide('verify', unfiled.map(function (i) { return i.testCode; })); };
}

async function decide(action, forced) {
  if (state.busy) return;
  var d = state.review;
  var codes = forced || Array.prototype.map.call(document.querySelectorAll('.rv-pick:checked'), function (c) { return c.value; });
  var by = (document.getElementById('rvBy') || {}).value || '';
  var comment = (document.getElementById('rvComment') || {}).value || '';
  if (!by.trim()) { drawReview('<div class="msg error">Enter the name of the person verifying.</div>'); return; }
  if (!codes.length) { drawReview('<div class="msg error">Select at least one value.</div>'); return; }
  if (action === 'reject' && !comment.trim()) { drawReview('<div class="msg error">Give a reason for rejecting.</div>'); return; }
  var what = action === 'verify' ? 'Send ' + codes.join(', ') + ' to Mirth as certified by ' + by + '?' : 'Reject ' + codes.join(', ') + '? They will NOT be sent to Mirth.';
  if (!confirm(what)) return;
  try { localStorage.setItem('im.verifier', by.trim()); } catch (e) {}
  state.busy = true;
  var r = await post('/api/im/analyzers/' + encodeURIComponent(d.analyzer) + '/review/' + encodeURIComponent(d.barcode) + '/' + action,
    { codes: codes, verifiedBy: by.trim(), comment: comment.trim() });
  state.busy = false;
  var fresh = await j('/api/im/analyzers/' + encodeURIComponent(d.analyzer) + '/orders/' + encodeURIComponent(d.barcode));
  if (!fresh.error) state.review = fresh;
  if (r.error) drawReview('<div class="msg error">' + esc(r.error) + '</div>');
  else if (action === 'verify') drawReview('<div class="msg ok">Sent to Mirth: ' + r.accepted + ' of ' + r.sent + ' accepted.' + (r.message ? ' ' + esc(r.message) : '') + '</div>');
  else drawReview('<div class="msg ok">' + r.rejected + ' value' + (r.rejected === 1 ? '' : 's') + ' rejected.</div>');
  refresh();
}

async function rerun() {
  var d = state.review;
  if (!confirm('Push order ' + d.barcode + ' to the analyzer again so the sample can be re-run?')) return;
  var r = await post('/api/analyzers/' + encodeURIComponent(d.analyzer) + '/orders/' + encodeURIComponent(d.barcode) + '/resend');
  drawReview(r.error ? '<div class="msg error">Re-run not sent: ' + esc(r.error) + '</div>'
                     : '<div class="msg ok">Order sent to the analyzer: ' + esc((r.tests || []).join(', ')) + '. The rerun value will be judged again when it arrives.</div>');
}

// ================================================================================
// Orders & transactions
// ================================================================================
async function renderOrders(fresh) {
  if (fresh || !state.orders.length) {
    var r = await j('/api/im/orders');
    state.orders = r.orders || [];
  }
  if (state.view !== 'orders') return;
  var list = (state.overview && state.overview.analyzers) || [];
  var f = state.filter;
  var shown = state.orders.filter(function (o) {
    if (f.analyzer && o.analyzer !== f.analyzer) return false;
    if (f.status && o.status !== f.status) return false;
    if (f.q && o.barcode.indexOf(f.q.trim().toUpperCase()) === -1) return false;
    return true;
  });
  var filters = '<div class="filters">' +
    '<select id="fA"><option value="">All machines</option>' + list.map(function (a) {
      return '<option value="' + esc(a.status.id) + '"' + (f.analyzer === a.status.id ? ' selected' : '') + '>' + esc(a.status.equipmentCode) + '</option>'; }).join('') + '</select>' +
    '<select id="fS"><option value="">All statuses</option>' + Object.keys(STATUS).map(function (s) {
      return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + esc(STATUS[s][1]) + '</option>'; }).join('') + '</select>' +
    '<input id="fQ" type="text" placeholder="Search barcode" value="' + esc(f.q) + '" />' +
    '<span class="small">' + shown.length + ' of ' + state.orders.length + '</span></div>';
  var rows = shown.slice(0, 300).map(function (o) {
    var k = key(o.analyzer, o.barcode);
    var open = !!state.expanded[k];
    var counts = [];
    if (o.autoCertified) counts.push('<span class="chip ok">' + o.autoCertified + ' auto</span>');
    if (o.verified) counts.push('<span class="chip ok">' + o.verified + ' verified</span>');
    if (o.held) counts.push('<span class="chip bad">' + o.held + ' held</span>');
    if (o.rejected) counts.push('<span class="chip">' + o.rejected + ' rejected</span>');
    return '<tr class="row' + (open ? ' open' : '') + '" data-k="' + esc(k) + '">' +
      '<td>' + (open ? '&#9662;' : '&#9656;') + '</td>' +
      '<td><div class="bc">' + esc(o.barcode) + '</div></td>' +
      '<td>' + esc(analyzerName(o.analyzer)) + '</td>' +
      '<td>' + statusPill(o.status) + '</td>' +
      '<td><div class="chips">' + o.ordered.slice(0, 10).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
        (o.ordered.length > 10 ? '<span class="small">+' + (o.ordered.length - 10) + '</span>' : '') + '</div></td>' +
      '<td><div class="chips">' + counts.join('') + '</div></td>' +
      '<td class="small">' + esc(when(o.lastAt)) + '<div>' + esc(o.lastSummary.slice(0, 90)) + '</div></td></tr>' +
      (open ? '<tr><td></td><td colspan="6"><div class="detail" id="d-' + esc(k) + '">' + (state.detail[k] ? detailHtml(state.detail[k]) : '<span class="small">Loading\\u2026</span>') + '</div></td></tr>' : '');
  }).join('');
  document.getElementById('view').innerHTML =
    '<div class="card"><div class="card-h"><h2>Orders</h2><span class="mut">Every order IM has seen from Mirth. Click one for its tests and full transaction log.</span><span class="spacer"></span>' + filters + '</div>' +
    (rows ? '<div class="wrap-x"><table class="t"><tr><th></th><th>Barcode</th><th>Machine</th><th>Status</th><th>Tests ordered</th><th>Certification</th><th>Last activity</th></tr>' + rows + '</table></div>'
          : '<div class="empty">No orders match.</div>') + '</div>';
  var fa = document.getElementById('fA'); fa.onchange = function () { state.filter.analyzer = fa.value; renderOrders(false); };
  var fs = document.getElementById('fS'); fs.onchange = function () { state.filter.status = fs.value; renderOrders(false); };
  var fq = document.getElementById('fQ'); fq.oninput = function () { state.filter.q = fq.value; renderOrders(false); var el = document.getElementById('fQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
  document.querySelectorAll('tr.row').forEach(function (tr) {
    tr.onclick = function () {
      var k = tr.dataset.k;
      if (state.expanded[k]) delete state.expanded[k]; else state.expanded[k] = true;
      renderOrders(false);
      if (state.expanded[k]) loadDetail(k);
    };
  });
  // Keep open rows current without collapsing them.
  Object.keys(state.expanded).forEach(function (k) { if (fresh) loadDetail(k); });
}

async function loadDetail(k) {
  var p = k.split('|');
  var d = await j('/api/im/analyzers/' + encodeURIComponent(p[0]) + '/orders/' + encodeURIComponent(p.slice(1).join('|')));
  if (d.error) return;
  state.detail[k] = d;
  var el = document.getElementById('d-' + k);
  if (el) { el.innerHTML = detailHtml(d); bindDetail(el, d); }
}

function detailHtml(d) {
  var o = d.order;
  var rv = d.review;
  var byCode = {};
  (rv ? rv.items : []).forEach(function (i) { byCode[(i.identifier || i.testCode).toUpperCase()] = i; });
  var tests = o ? '<h4>Tests ordered by Mirth</h4><table class="t"><tr><th>Identifier</th><th>labResultId</th><th>Reference (Mirth)</th><th>To analyzer</th><th>Review</th></tr>' +
    o.rows.map(function (r) {
      var i = byCode[String(r.identifier).toUpperCase()];
      return '<tr><td class="mono"><b>' + esc(r.identifier) + '</b></td><td class="mono">' + esc(r.labResultId) + '</td>' +
        '<td class="mono">' + esc(r.range || '\\u2014') + '</td><td>' + (r.downloaded ? '<span class="pill ok">sent</span>' : '<span class="pill mut">not sent</span>') + '</td>' +
        '<td>' + (i ? esc(i.state) + ' \\u00b7 ' + esc(i.value) : '') + '</td></tr>';
    }).join('') + '</table>' : '<div class="small">The order store no longer holds this barcode.</div>';
  var hist = (d.history || []).map(function (t) {
    var extra = t.detail ? '<details><summary>details</summary><pre class="code">' + esc(JSON.stringify(t.detail, null, 2)) + '</pre></details>' : '';
    return '<li class="k-' + esc(t.kind) + '"><span class="when">' + esc(when(t.ts)) + '</span><span class="kind">' + esc(t.kind.replace(/-/g, ' ')) + '</span>' +
      esc(t.summary) + (t.user ? ' <span class="small">(' + esc(t.user) + ')</span>' : '') + extra + '</li>';
  }).join('');
  var act = (rv && rv.pending) ? '<button class="btn btn-primary btn-sm" type="button" data-open-review="1">Review held values</button> ' : '';
  return '<div class="two"><div>' + tests + '</div><div><h4>Transaction log</h4>' +
    (hist ? '<ul class="timeline">' + hist + '</ul>' : '<div class="small">No transactions recorded.</div>') + '</div></div>' +
    '<div style="margin-top:10px">' + act + '<button class="btn btn-ghost btn-sm" type="button" data-preview="1">What would go to Mirth?</button></div>' +
    '<div data-preview-out="1"></div>';
}
function bindDetail(el, d) {
  var r = el.querySelector('[data-open-review]'); if (r) r.onclick = function (e) { e.stopPropagation(); openReview(d.analyzer, d.barcode); };
  var p = el.querySelector('[data-preview]'); if (p) p.onclick = async function (e) {
    e.stopPropagation();
    var out = el.querySelector('[data-preview-out]');
    out.innerHTML = previewHtml(await j('/api/im/analyzers/' + encodeURIComponent(d.analyzer) + '/mirth/preview/' + encodeURIComponent(d.barcode)));
  };
}
// Re-bind detail panels after every orders re-render.
var _renderOrders = renderOrders;
renderOrders = async function (fresh) {
  await _renderOrders(fresh);
  Object.keys(state.detail).forEach(function (k) { var el = document.getElementById('d-' + k); if (el) bindDetail(el, state.detail[k]); });
};

function previewHtml(pv) {
  if (pv.error) return '<div class="msg error" style="margin-top:10px">' + esc(pv.error) + '</div>';
  var verdicts = (pv.verdicts || []).map(function (v) {
    return '<tr><td class="mono"><b>' + esc(v.testCode) + '</b></td><td class="val">' + esc(v.value) + '</td><td class="mono">' + esc(v.range || '\\u2014') +
      '<div class="small">' + esc(v.rangeSource || '') + '</div></td><td>' + reasonChip(v.reason) + '</td><td>' + (v.decision === 'certify' ? '<span class="pill ok">auto-certify</span>' : '<span class="pill bad">hold</span>') + '</td></tr>';
  }).join('');
  return '<div class="msg info" style="margin-top:12px">' + esc(pv.note) + (pv.unmatched && pv.unmatched.length ? ' No Mirth row yet for: ' + esc(pv.unmatched.join(', ')) + '.' : '') + '</div>' +
    (verdicts ? '<table class="t"><tr><th>Test</th><th>Value</th><th>Reference</th><th>Verdict</th><th></th></tr>' + verdicts + '</table>' : '') +
    '<h4 style="margin:12px 0 4px;font-size:12px;text-transform:uppercase;color:var(--mut)">POST body (results endpoint)</h4><pre class="code">' + esc(JSON.stringify(pv.rows, null, 2)) + '</pre>';
}

// ================================================================================
// Machines
// ================================================================================
async function renderMachines() {
  var list = (state.overview && state.overview.analyzers) || [];
  var cards = list.map(function (a) {
    var s = a.status, im = a.im;
    var open = state.machineOpen[s.id];
    var c = im ? im.counts : null;
    var gate = !im ? '<span class="pill mut">IM off</span>' : im.gating ? '<span class="pill ok">Auto-certifying</span>' : '<span class="pill mut">Tracking only</span>';
    return '<article class="card mcard"><div class="card-top"><div class="title"><div><h3>' + esc(s.equipmentCode) + '</h3><div class="id">' + esc(s.id) + '</div></div>' +
      '<div>' + linkPill(s) + ' ' + gate + '</div></div>' +
      '<div class="meta"><span class="tag">' + esc(String(s.protocol).toUpperCase()) + '</span><span>' + esc(s.endpoint) + '</span></div></div>' +
      '<div class="card-b">' +
        '<div class="kv"><span class="k">Last message</span><span class="v">' + esc(time(s.lastMessageAt)) + '</span></div>' +
        '<div class="kv"><span class="k">Orders (poll)</span><span class="v">' + esc(s.orders.stored) + ' stored' + (s.orders.lastPollError ? ' \\u00b7 <span style="color:var(--bad)">poll failing</span>' : ' \\u00b7 polled ' + esc(time(s.orders.lastPollAt))) + '</span></div>' +
        (c ? '<div class="kv"><span class="k">Today</span><span class="v">' + c.ordersToday + ' ordered \\u00b7 ' + c.sentToday + ' sent \\u00b7 ' + c.resultsToday + ' resulted</span></div>' +
             '<div class="kv"><span class="k">Certification</span><span class="v">' + c.autoCertifiedToday + ' auto \\u00b7 ' + c.verifiedToday + ' verified \\u00b7 ' +
               (c.actionRequired.samples ? '<span style="color:var(--bad)">' + c.actionRequired.samples + ' need action</span>' : '0 need action') + '</span></div>' +
             '<div class="kv"><span class="k">Ranges</span><span class="v">' + im.ranges + ' set in IM config' + (im.holdWhenNoRange ? ' \\u00b7 unranged values held' : ' \\u00b7 unranged values file') + '</span></div>' : '') +
        '<div class="minitabs">' +
          '<button type="button" data-m="' + esc(s.id) + '" data-t="im" class="' + (open === 'im' ? 'active' : '') + '">IM log</button>' +
          '<button type="button" data-m="' + esc(s.id) + '" data-t="wire" class="' + (open === 'wire' ? 'active' : '') + '">Wire log</button>' +
          (open ? '<button type="button" data-m="' + esc(s.id) + '" data-t="">Collapse</button>' : '') +
        '</div>' +
        (open ? '<div class="panel" id="mp-' + esc(s.id) + '"><div class="empty">Loading\\u2026</div></div>' : '') +
      '</div></article>';
  }).join('');
  document.getElementById('view').innerHTML = cards ? '<div class="grid">' + cards + '</div>' : '<div class="card"><div class="empty">No analyzers configured.</div></div>';
  document.querySelectorAll('[data-m]').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.t) state.machineOpen[b.dataset.m] = b.dataset.t; else delete state.machineOpen[b.dataset.m];
      renderMachines();
    };
  });
  Object.keys(state.machineOpen).forEach(fillMachinePanel);
}

async function fillMachinePanel(id) {
  var el = document.getElementById('mp-' + id);
  if (!el) return;
  var keep = el.scrollTop;
  if (state.machineOpen[id] === 'wire') {
    var w = await j('/api/analyzers/' + encodeURIComponent(id) + '/wire');
    var rows = (w.wire || []).slice(-40).reverse();
    el.innerHTML = rows.length ? '<ul class="plist">' + rows.map(function (x) {
      return '<li><div class="head"><span class="dir ' + esc(x.direction) + '">' + esc(x.direction) + '</span>' + esc(time(x.at)) + '</div><pre>' + esc(x.text) + '</pre></li>';
    }).join('') + '</ul>' : '<div class="empty">No traffic on the wire yet.</div>';
  } else {
    var l = await j('/api/im/analyzers/' + encodeURIComponent(id) + '/log');
    var ev = l.log || [];
    el.innerHTML = ev.length ? '<ul class="plist">' + ev.map(function (t) {
      return '<li><div class="head"><span class="bc">' + esc(t.barcode) + '</span> <span class="kind" style="text-transform:uppercase;font-weight:800;font-size:10.5px">' + esc(t.kind.replace(/-/g, ' ')) + '</span> ' + esc(when(t.ts)) + '</div>' + esc(t.summary) + '</li>';
    }).join('') + '</ul>' : '<div class="empty">' + (l.error ? esc(l.error) : 'No IM activity yet.') + '</div>';
  }
  el.scrollTop = keep;
}

// ================================================================================
// Mirth
// ================================================================================
async function renderMirth(fresh) {
  var m = await j('/api/im/mirth');
  if (state.view !== 'mirth') return;
  if (m.error) { document.getElementById('view').innerHTML = '<div class="card"><div class="empty">' + esc(m.error) + '</div></div>'; return; }
  var list = (state.overview && state.overview.analyzers) || [];
  var clients = (m.clients || []).map(function (c) {
    return '<tr><td><b>' + esc(c.label) + '</b></td><td class="mono">' + esc(c.baseUrl) + '</td><td class="mono small">GET ' + esc(c.pendingPath) + '<br>POST ' + esc(c.acknowledgePath) + '<br>POST ' + esc(c.resultsPath) + '</td>' +
      '<td class="small">' + esc(c.timeoutMs) + ' ms' + (c.headers.length ? '<br>headers: ' + esc(c.headers.join(', ')) : '') + '</td></tr>';
  }).join('');
  var fields = Object.keys(m.fields || {}).map(function (k) {
    var v = m.fields[k];
    return '<tr><td>' + esc(k) + '</td><td class="mono">' + (v ? esc(v) : '<span class="small">not sent</span>') + '</td></tr>';
  }).join('');
  var RANGE = /range|min|max|low|high|limit|critical|panic/i;
  var cols = (m.columns || []).map(function (c) {
    return '<span class="chip' + (RANGE.test(c.column) ? ' ok' : '') + '" title="e.g. ' + esc(c.example) + '">' + esc(c.column) + ' <span class="small">' + c.count + '</span></span>';
  }).join('');
  var ex = (m.exchanges || []).slice(0, 60).map(function (e) {
    var bad = e.outcome === 'error' || e.outcome === 'none-matched';
    var sid = Array.isArray(e.sampleId) ? e.sampleId.join(', ') : (e.sampleId || '(bulk poll)');
    return '<li><div class="head"><span class="dir ' + (e.method === 'GET' ? 'IN' : 'OUT') + '">' + esc(e.method) + '</span>' + esc(time(e.ts)) +
      ' <b>' + esc(e.kind) + '</b> <span class="bc">' + esc(sid) + '</span> <span class="chip ' + (bad ? 'bad' : 'ok') + '">' + esc(e.outcome) + '</span> ' +
      '<span class="small">' + esc(e.httpStatus == null ? '\\u2014' : e.httpStatus) + ' \\u00b7 ' + esc(e.durationMs) + ' ms \\u00b7 ' + esc(e.client) + '</span></div>' +
      '<div class="small mono">' + esc(e.url) + '</div>' + (e.error ? '<div style="color:var(--bad)">' + esc(e.error) + '</div>' : '') +
      '<details><summary class="small">request / response</summary>' +
      (e.request ? '<div class="small">Sent to Mirth</div><pre class="code">' + esc(pretty(e.request)) + '</pre>' : '') +
      (e.response ? '<div class="small">Mirth answered</div><pre class="code">' + esc(pretty(e.response)) + '</pre>' : '') + '</details></li>';
  }).join('');
  var anaOpts = list.map(function (a) { return '<option value="' + esc(a.status.id) + '">' + esc(a.status.equipmentCode) + '</option>'; }).join('');
  document.getElementById('view').innerHTML =
    '<div class="two">' +
      '<div class="card" style="margin:0"><div class="card-h"><h2>Connection</h2><span class="mut">config.json: hmis, im.mirth</span></div><div class="card-b wrap-x">' +
        '<table class="t"><tr><th>Client</th><th>Base URL</th><th>Endpoints</th><th></th></tr>' + clients + '</table>' +
        '<p class="small">Orders come from the pending endpoint; certified results go to the results endpoint' + ((m.clients || []).length > 1 ? ' of <b>im-mirth</b>' : '') + '; order rows are retired with acknowledge after their result files.</p></div></div>' +
      '<div class="card" style="margin:0"><div class="card-h"><h2>What IM adds to each result row</h2><span class="mut">im.mirth.fields</span></div><div class="card-b">' +
        '<table class="t"><tr><th>Meaning</th><th>Column sent</th></tr>' + fields + '<tr><td>certifiedBy on auto rows</td><td class="mono">' + esc(m.autoCertifiedBy) + '</td></tr></table>' +
        '<p class="small">Sent on top of the usual row (sampleId, labResultId, identifier, resultValue \\u2026). Confirm these names with the Mirth channel owner; set one to null to leave it out.</p></div></div>' +
    '</div>' +
    '<div class="card"><div class="card-h"><h2>What Mirth sends us</h2><span class="mut">Columns seen on pending rows since the service started \\u2014 green ones look like reference-range columns.</span></div><div class="card-b">' +
      (cols ? '<div class="chips">' + cols + '</div>' : '<div class="small">No pending rows received yet.</div>') + '</div></div>' +
    '<div class="card"><div class="card-h"><h2>Look up a barcode in Mirth</h2><span class="mut">Read-only: asks Mirth, shows the raw answer and how IM reads it. Nothing is stored or sent to the analyzer.</span></div><div class="card-b">' +
      '<div class="form-row"><div class="f"><label for="pA">Machine</label><select id="pA">' + anaOpts + '</select></div>' +
      '<div class="f"><label for="pB">Barcode</label><input id="pB" type="text" placeholder="e.g. LB2609180027" /></div>' +
      '<button class="btn btn-primary btn-sm" type="button" id="pGo">Ask Mirth</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="pPrev">What would we send?</button></div>' +
      '<div id="pOut"></div></div></div>' +
    '<div class="card"><div class="card-h"><h2>Latest exchanges with Mirth</h2><span class="mut">Newest first. The full record is logs/hmis-YYYY-MM-DD.log.</span></div><div class="card-b">' +
      (ex ? '<ul class="plist">' + ex + '</ul>' : '<div class="small">No calls yet.</div>') + '</div></div>';
  document.getElementById('pGo').onclick = probe;
  document.getElementById('pPrev').onclick = async function () {
    var a = document.getElementById('pA').value, b = document.getElementById('pB').value.trim();
    if (!b) return;
    document.getElementById('pOut').innerHTML = previewHtml(await j('/api/im/analyzers/' + encodeURIComponent(a) + '/mirth/preview/' + encodeURIComponent(b)));
  };
}
function pretty(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s; } }

async function probe() {
  var a = document.getElementById('pA').value, b = document.getElementById('pB').value.trim();
  var out = document.getElementById('pOut');
  if (!b) { out.innerHTML = '<div class="msg error" style="margin-top:10px">Enter a barcode.</div>'; return; }
  out.innerHTML = '<div class="small" style="margin-top:10px">Asking Mirth\\u2026</div>';
  var r = await post('/api/im/analyzers/' + encodeURIComponent(a) + '/mirth/probe', { sampleId: b });
  if (r.error) { out.innerHTML = '<div class="msg error" style="margin-top:10px">' + esc(r.error) + '</div>'; return; }
  out.innerHTML = r.calls.map(function (c) {
    var parsed = c.parsed.map(function (p) {
      return '<tr><td class="mono"><b>' + esc(p.identifier) + '</b></td><td class="mono">' + esc(p.labResultId) + '</td><td class="mono">' + esc(p.labServiceId) + '</td><td class="mono">' + esc(p.parameterId) + '</td><td class="mono">' + esc(p.range || '\\u2014') + '</td></tr>';
    }).join('');
    return '<h4 style="margin:14px 0 6px">eqCode ' + esc(c.eqCode) + ' \\u2014 ' + c.rows + ' row' + (c.rows === 1 ? '' : 's') + '</h4>' +
      (c.error ? '<div class="msg error">' + esc(c.error) + '</div>' : '') +
      (parsed ? '<table class="t"><tr><th>Identifier</th><th>labResultId</th><th>labServiceId</th><th>parameterId</th><th>Reference range read</th></tr>' + parsed + '</table>' : '') +
      (c.columns.length ? '<div class="small" style="margin-top:6px">Columns: ' + esc(c.columns.join(', ')) + '</div>' : '') +
      '<details><summary class="small">Raw Mirth response</summary><pre class="code">' + esc(c.raw) + '</pre></details>';
  }).join('');
}

// ---- refresh loop ------------------------------------------------------------------
async function refresh() {
  try {
    state.overview = await j('/api/im/overview');
    renderStats();
    document.getElementById('alert').innerHTML = '';
    // Re-render the live views; leave Mirth alone (it holds form input) and
    // leave everything alone while the review dialog is open.
    var typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!state.review && !typing) {
      if (state.view === 'review') renderReviewList();
      else if (state.view === 'orders') renderOrders(true);
      else if (state.view === 'machines') renderMachines();
    }
  } catch (err) {
    document.getElementById('alert').innerHTML = '<div class="msg error">Lost contact with the connector service. Retrying\\u2026</div>';
  }
  document.getElementById('clock').textContent = new Date().toLocaleString();
}

(async function () {
  await refresh();
  setView(state.view);
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
