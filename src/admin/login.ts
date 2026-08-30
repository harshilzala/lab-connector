import { BASE_CSS, FONT_LINK } from './theme.js';

// Sign-in / password-reset page. Self-contained apart from the webfont, which
// degrades to the system sans when the lab PC has no route to the internet.

export type LoginView = 'login' | 'reset';

export interface LoginPageOptions {
  view: LoginView;
  /** Red banner above the form. */
  error?: string | null;
  /** Green banner above the form (e.g. after a successful reset). */
  notice?: string | null;
  /** Re-filled after a failed attempt so only the password has to be retyped. */
  username?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PAGE_CSS = `
body { display:flex; flex-direction:column; min-height:100vh; background:#fff; }
/* Soft brand glows, echoing the teal/plum accents used across zydushospitals.com. */
.stage {
  flex:1; display:flex; align-items:center; justify-content:center; padding:40px 20px;
  position:relative; overflow:hidden;
  background:
    radial-gradient(620px 420px at 12% 8%,  rgba(0,165,165,.13), transparent 62%),
    radial-gradient(560px 420px at 88% 92%, rgba(170,85,160,.13), transparent 62%),
    var(--bg);
}
.card {
  position:relative; width:100%; max-width:432px; background:var(--card);
  border:1px solid var(--line); border-radius:20px; box-shadow:var(--shadow); padding:36px 34px 30px;
}
.card-head { text-align:center; margin:0 0 26px; }
.card-head .logo { height:56px; margin:0 auto 20px; }
.card-head h1 { font-size:23px; letter-spacing:-.2px; }
.card-head p { margin:7px 0 0; font-size:14px; color:var(--mut); }
.field { margin:0 0 16px; }
.field-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.field-head a { font-size:12.5px; font-weight:700; }
.hint { margin:7px 0 0; font-size:12.5px; color:var(--mut); }
.actions { margin-top:22px; display:flex; flex-direction:column; gap:10px; }
.footnote {
  margin:26px 0 0; padding-top:18px; border-top:1px solid var(--line);
  font-size:12.5px; color:var(--mut); text-align:center; line-height:1.55;
}
.pagefoot { padding:18px 20px 26px; text-align:center; font-size:12.5px; color:var(--mut); }
@media (max-width:520px) { .card { padding:28px 22px 24px; border-radius:16px; } }
`;

function banners(o: LoginPageOptions): string {
  let html = '';
  if (o.notice) html += `<div class="msg ok" role="status">${esc(o.notice)}</div>`;
  if (o.error) html += `<div class="msg error" role="alert">${esc(o.error)}</div>`;
  return html;
}

function loginForm(o: LoginPageOptions): string {
  return `
      <div class="card-head">
        <img class="logo" src="/assets/zydus-logo.svg" alt="Zydus Hospitals" />
        <h1>Lab Connector</h1>
        <p>HMIS laboratory interface &middot; sign in to continue</p>
      </div>
      ${banners(o)}
      <form method="post" action="/login" autocomplete="off" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" value="${esc(o.username ?? '')}"
                 placeholder="Adminx" autocomplete="username" autocapitalize="none"
                 spellcheck="false" required autofocus />
        </div>
        <div class="field">
          <div class="field-head">
            <label for="password">Password</label>
            <a href="/login?view=reset">Forgot password?</a>
          </div>
          <input id="password" name="password" type="password" placeholder="••••••••••"
                 autocomplete="current-password" required />
        </div>
        <div class="actions">
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </div>
      </form>
      <p class="footnote">
        Local administration console. Bound to the lab PC only &mdash; it is not published on the hospital LAN.
      </p>`;
}

function resetForm(o: LoginPageOptions): string {
  return `
      <div class="card-head">
        <img class="logo" src="/assets/zydus-logo.svg" alt="Zydus Hospitals" />
        <h1>Reset password</h1>
        <p>Confirm with your current password or the recovery key</p>
      </div>
      ${banners(o)}
      <form method="post" action="/reset" autocomplete="off" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" value="${esc(o.username ?? '')}"
                 placeholder="Adminx" autocomplete="username" autocapitalize="none"
                 spellcheck="false" required autofocus />
        </div>
        <div class="field">
          <label for="proof">Current password or recovery key</label>
          <input id="proof" name="proof" type="password" placeholder="Current password or XXXXX-XXXXX-XXXXX-XXXXX"
                 autocomplete="current-password" required />
          <p class="hint">The recovery key was printed to the connector log the first time it started.</p>
        </div>
        <div class="field">
          <label for="password">New password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required />
          <p class="hint">At least 10 characters, using three of: lowercase, uppercase, digits, symbols.</p>
        </div>
        <div class="field">
          <label for="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autocomplete="new-password" required />
        </div>
        <div class="actions">
          <button class="btn btn-primary btn-block" type="submit">Update password</button>
          <a class="btn btn-ghost btn-block" href="/login">Back to sign in</a>
        </div>
      </form>
      <p class="footnote">
        Lost both the password and the recovery key? Delete <code>admin-auth.json</code> on the lab PC
        and restart the connector to re-seed the commissioning credential.
      </p>`;
}

export function renderLoginPage(o: LoginPageOptions): string {
  const title = o.view === 'reset' ? 'Reset password' : 'Sign in';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title} &middot; Lab Connector</title>
${FONT_LINK}
<style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
  <div class="brandbar"></div>
  <div class="stage">
    <main class="card">${o.view === 'reset' ? resetForm(o) : loginForm(o)}</main>
  </div>
  <footer class="pagefoot">Zydus Hospitals &middot; HMIS Lab Connector</footer>
</body>
</html>`;
}
