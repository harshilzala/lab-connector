// Shared look-and-feel for the admin UI, following the Zydus Hospitals brand:
// teal #00a5a5 primary, plum #aa55a0 secondary, warm-grey #464141 body text,
// Nunito Sans on a system-sans fallback (the webfont is a progressive
// enhancement — the lab PC is usually offline, so the stack must stand alone).
export const BASE_CSS = `
:root {
  --teal:#00a5a5; --teal-600:#0b8c8c; --teal-700:#0a7676; --teal-soft:#e2fffa;
  --plum:#aa55a0; --plum-600:#96438c; --plum-soft:#f3e7f1;
  --ink:#363232; --body:#464141; --mut:#8a8383;
  --line:#e8e5e7; --bg:#f5f7f8; --card:#fff;
  --ok:#12a06b; --ok-soft:#e6f6ef;
  --warn:#c47f0a; --warn-soft:#fdf3e0;
  --bad:#d13b3b; --bad-soft:#fdeaea;
  --radius:14px;
  --shadow:0 1px 2px rgba(54,50,50,.05), 0 8px 24px rgba(54,50,50,.06);
  --font:"Nunito Sans","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;
}
* { box-sizing:border-box; }
html, body { height:100%; }
body {
  margin:0; background:var(--bg); color:var(--body);
  font:400 15px/1.6 var(--font);
  -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4 { margin:0; color:var(--ink); font-weight:700; line-height:1.25; }
a { color:var(--teal-700); text-decoration:none; }
a:hover { text-decoration:underline; }

/* Brand rule that runs along the top of every page. */
.brandbar { height:4px; background:linear-gradient(90deg,var(--teal) 0%,var(--teal) 45%,var(--plum) 100%); }

.logo { height:44px; width:auto; display:block; }

/* ---- form controls ---- */
label { display:block; font-size:13px; font-weight:700; color:var(--ink); margin:0 0 6px; }
input[type=text], input[type=password] {
  width:100%; padding:12px 14px; font:400 15px/1.4 var(--font); color:var(--ink);
  background:#fff; border:1px solid var(--line); border-radius:10px; transition:border-color .15s, box-shadow .15s;
}
input[type=text]:focus, input[type=password]:focus {
  outline:0; border-color:var(--teal); box-shadow:0 0 0 3px rgba(0,165,165,.15);
}
input::placeholder { color:#b4aeae; }

.btn {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  padding:12px 20px; border:1px solid transparent; border-radius:10px; cursor:pointer;
  font:700 15px/1 var(--font); transition:background .15s, color .15s, border-color .15s;
}
.btn-primary { background:var(--teal); color:#fff; }
.btn-primary:hover { background:var(--teal-600); }
.btn-ghost { background:#fff; color:var(--body); border-color:var(--line); }
.btn-ghost:hover { background:var(--teal-soft); border-color:var(--teal); color:var(--teal-700); }
.btn-block { width:100%; }
.btn:disabled { opacity:.55; cursor:not-allowed; }

.btn-sm { padding:6px 12px; font-size:13px; border-radius:8px; }

/* ---- status pills ---- */
.pill { display:inline-flex; align-items:center; gap:6px; padding:4px 11px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.2px; }
.pill::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.pill.ok   { background:var(--ok-soft);   color:var(--ok); }
.pill.warn { background:var(--warn-soft); color:var(--warn); }
.pill.bad  { background:var(--bad-soft);  color:var(--bad); }
.pill.mut  { background:#eeecec;          color:var(--mut); }

/* ---- messages ---- */
.msg { padding:11px 14px; border-radius:10px; font-size:14px; margin:0 0 18px; border:1px solid transparent; }
.msg.error { background:var(--bad-soft);  border-color:#f3c9c9; color:#9e2b2b; }
.msg.ok    { background:var(--ok-soft);   border-color:#bfe6d5; color:#0d7a51; }
.msg.info  { background:var(--plum-soft); border-color:#e6cfe2; color:#7d3574; }

.mut { color:var(--mut); }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

/** Webfont link — fails silently (and harmlessly) when the PC has no internet. */
export const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700;6..12,800&display=swap" />`;
