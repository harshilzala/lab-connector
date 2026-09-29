// =============================================================================
// The console's left-hand navigation, shared by every signed-in page.
//
// Closed, it is a narrow rail of icons (each with a tooltip). The hamburger at
// its top opens it over the page to show the labels. It closes by itself when
// the pointer leaves it, on a click outside it, on Esc, and when a page is
// picked, so it never stays over the content the operator is reading.
//
// Page links used to sit in each page's top bar. They live here now, so a new
// page is one entry in NAV_ITEMS.
// =============================================================================

export type NavPage = 'dashboard' | 'auto-certify' | 'connector';

// 24x24 stroke icons, drawn in currentColor so they follow the active state.
const ICON = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  certify:
    '<path d="M12 3l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 21l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="M8.5 12l2.3 2.3 4.7-4.6"/>',
  connector:
    '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M18.5 4.5l2 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
} as const;

function icon(name: keyof typeof ICON): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

const NAV_ITEMS: { page: NavPage; href: string; label: string; icon: keyof typeof ICON; hint: string }[] = [
  { page: 'dashboard', href: '/', label: 'Dashboard', icon: 'dashboard', hint: 'Analyzers, queues and wire logs' },
  { page: 'auto-certify', href: '/auto-certify', label: 'Auto Certify', icon: 'certify', hint: 'Certify interfaced results in HIS' },
  { page: 'connector', href: '/connector', label: 'Connector Tool', icon: 'connector', hint: 'Identify and connect a new machine' },
];

export const SHELL_CSS = `
:root { --rail:64px; --rail-open:248px; }
body { padding-left:var(--rail); }

.sidenav {
  position:fixed; left:0; top:0; bottom:0; width:var(--rail); z-index:60;
  display:flex; flex-direction:column; overflow:hidden;
  background:#fff; border-right:1px solid var(--line);
  transition:width .2s ease, box-shadow .2s ease;
}
.sidenav::before { content:""; height:4px; flex:0 0 4px; background:linear-gradient(90deg,var(--teal),var(--plum)); }
.sidenav.open { width:var(--rail-open); box-shadow:10px 0 32px rgba(54,50,50,.14); }

.nav-item {
  display:flex; align-items:center; gap:14px; height:44px; margin:3px 10px; padding:0 12px;
  border:0; border-radius:10px; background:none; cursor:pointer; width:calc(100% - 20px);
  color:var(--body); font:700 14px/1 var(--font); white-space:nowrap; text-align:left;
  transition:background .15s, color .15s;
}
.nav-item svg { flex:0 0 20px; width:20px; height:20px; }
.nav-item .label { opacity:0; transition:opacity .12s; }
.sidenav.open .nav-item .label { opacity:1; transition-delay:.06s; }
.nav-item:hover { background:var(--teal-soft); color:var(--teal-700); text-decoration:none; }
.nav-item.active { background:var(--teal); color:#fff; }
.nav-item.active:hover { background:var(--teal-600); color:#fff; }
.nav-item:focus-visible { outline:2px solid var(--teal); outline-offset:1px; }

.nav-toggle { height:64px; margin:0; width:100%; border-radius:0; padding:0 22px; border-bottom:1px solid var(--line); }
.nav-toggle .label { font-size:12px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; color:var(--mut); }
.nav-toggle:hover { background:#fbfbfc; }

.nav-group { padding:10px 0; }
.nav-bottom { margin-top:auto; padding:8px 0 12px; border-top:1px solid var(--line); }
.nav-bottom form { margin:0; }

.nav-scrim {
  position:fixed; inset:0; z-index:59; background:rgba(54,50,50,.16);
  opacity:0; pointer-events:none; transition:opacity .2s ease;
}
.nav-scrim.show { opacity:1; pointer-events:auto; }

@media (max-width:720px) { :root { --rail:56px; } .nav-item { margin:3px 6px; width:calc(100% - 12px); padding:0 12px; } .nav-toggle { padding:0 18px; } }
`;

/** The rail. Goes straight after <body>. */
export interface SidebarOptions {
  /** autoCertify.enabled in config.json. When false the Auto Certify page is
   *  not offered at all — no rail icon, no link — and the server refuses it. */
  autoCertify: boolean;
}

export function renderSidebar(active: NavPage, opts: SidebarOptions): string {
  const links = NAV_ITEMS.filter((n) => n.page !== 'auto-certify' || opts.autoCertify).map(
    (n) =>
      `<a class="nav-item${n.page === active ? ' active' : ''}" href="${n.href}" title="${n.label} — ${n.hint}"${
        n.page === active ? ' aria-current="page"' : ''
      }>${icon(n.icon)}<span class="label">${n.label}</span></a>`,
  ).join('');

  return `<nav class="sidenav" id="sidenav" aria-label="Pages">
  <button class="nav-item nav-toggle" id="navToggle" type="button" aria-expanded="false" aria-controls="sidenav" title="Menu">${icon('menu')}<span class="label">Menu</span></button>
  <div class="nav-group">${links}</div>
  <div class="nav-bottom">
    <a class="nav-item" href="/#password" data-nav-pw="1" title="Change password">${icon('key')}<span class="label">Change password</span></a>
    <form method="post" action="/logout"><button class="nav-item" type="submit" title="Sign out">${icon('logout')}<span class="label">Sign out</span></button></form>
  </div>
</nav>
<div class="nav-scrim" id="navScrim"></div>`;
}

/** Open / auto-close behaviour. Goes in a <script> at the end of the page. */
export const SHELL_JS = `
(function () {
  var nav = document.getElementById('sidenav');
  var scrim = document.getElementById('navScrim');
  var toggle = document.getElementById('navToggle');
  if (!nav || !toggle) return;
  var leaveTimer = null;

  function setOpen(open) {
    clearTimeout(leaveTimer);
    nav.classList.toggle('open', open);
    scrim.classList.toggle('show', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function isOpen() { return nav.classList.contains('open'); }

  toggle.addEventListener('click', function () { setOpen(!isOpen()); });
  scrim.addEventListener('click', function () { setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) setOpen(false); });

  // Auto close: a short grace period so a pointer that slips off the edge and
  // comes straight back does not snap it shut.
  nav.addEventListener('mouseleave', function () {
    if (isOpen()) leaveTimer = setTimeout(function () { setOpen(false); }, 500);
  });
  nav.addEventListener('mouseenter', function () { clearTimeout(leaveTimer); });

  nav.querySelectorAll('a.nav-item').forEach(function (a) {
    a.addEventListener('click', function () { setOpen(false); });
  });

  // "Change password" is the dashboard's dialog. On the dashboard open it in
  // place; any other page goes there with #password, which opens it on load.
  var pw = nav.querySelector('[data-nav-pw]');
  if (pw) pw.addEventListener('click', function (e) {
    if (typeof window.openPw === 'function') { e.preventDefault(); setOpen(false); window.openPw(); }
  });
})();
`;
