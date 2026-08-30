import http from 'node:http';
import type { Logger } from '../logger.js';
import type { AnalyzerStatus, WireLogEntry } from '../session/orchestrator.js';
import type { SpoolEnvelope } from '../queue/spool.js';
import type { HmisResultUpload } from '../types.js';
import { renderDashboard } from './dashboard.js';
import { renderLoginPage, type LoginView } from './login.js';
import { ZYDUS_LOGO_SVG } from './logo.js';
import {
  AuthStore,
  LoginThrottle,
  SESSION_COOKIE,
  SessionStore,
  checkPasswordStrength,
  readCookie,
} from './auth.js';

export interface AdminBackend {
  statuses(): AnalyzerStatus[];
  wire(id: string): WireLogEntry[] | null;
  spool(id: string): { pending: SpoolEnvelope<HmisResultUpload>[]; failed: SpoolEnvelope<HmisResultUpload>[] } | null;
  retry(id: string, msgId: string): boolean;
  clearWire(id: string): boolean;
  remove(id: string, msgId: string): boolean;
}

/** Plenty for a login form; anything larger is not a request we serve. */
const MAX_BODY_BYTES = 16 * 1024;

// Local-only admin + monitoring UI. Bind to 127.0.0.1 so it isn't exposed on
// the hospital LAN. Shows analyzer connection state, live wire log, and the
// store-and-forward backlog with a manual retry for parked items.
//
// Everything except the sign-in pages and the logo sits behind a session
// cookie: the PC is on the lab floor, often unattended, and the wire log
// carries patient barcodes and results.
export class AdminServer {
  private server: http.Server | null = null;
  private readonly sessions = new SessionStore();
  private readonly throttle = new LoginThrottle();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly backend: AdminBackend,
    private readonly host: string,
    private readonly port: number,
    private readonly logger: Logger,
    private readonly auth: AuthStore,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server = server;

      // Without this, a bind failure surfaces as an unhandled 'error' event and
      // takes the whole process down with a stack dump — after the analyzer
      // links are already up. Turn it into a fatal the caller can report.
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(
                `admin dashboard cannot bind ${this.host}:${this.port} — another lab-connector is probably already running (change admin.port to use a different one)`,
              )
            : err,
        );
      });

      server.listen(this.port, this.host, () => {
        this.sweeper = setInterval(() => this.sessions.sweep(), 15 * 60 * 1000);
        this.sweeper.unref();
        this.logger.info({ url: `http://${this.host}:${this.port}` }, 'admin dashboard listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // ---- public ----
      if (method === 'GET' && p === '/assets/zydus-logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        return void res.end(ZYDUS_LOGO_SVG);
      }
      if (method === 'GET' && (p === '/login' || p === '/reset')) return this.getLogin(req, res, url, p);
      if (method === 'POST' && p === '/login') return await this.postLogin(req, res);
      if (method === 'POST' && p === '/reset') return await this.postReset(req, res);

      // ---- everything below needs a session ----
      const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      const session = this.sessions.get(sid);

      if (method === 'POST' && p === '/logout') {
        this.sessions.destroy(sid);
        return this.redirect(res, '/login', this.clearCookie());
      }

      if (!session) {
        if (p.startsWith('/api/')) return this.json(res, { error: 'unauthenticated' }, 401);
        return this.redirect(res, '/login');
      }

      if (method === 'GET' && p === '/') {
        return this.html(
          res,
          renderDashboard({ username: session.username, usingDefaultPassword: this.auth.usingDefaultPassword }),
        );
      }

      if (method === 'GET' && p === '/api/status') {
        return this.json(res, { analyzers: this.backend.statuses() });
      }

      if (method === 'POST' && p === '/api/password') {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        return await this.postChangePassword(req, res, session.username, sid);
      }

      const wireMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/wire$/);
      if (method === 'GET' && wireMatch) {
        const w = this.backend.wire(wireMatch[1]!);
        return w ? this.json(res, { wire: w }) : this.json(res, { error: 'unknown analyzer' }, 404);
      }

      const spoolMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/spool$/);
      if (method === 'GET' && spoolMatch) {
        const s = this.backend.spool(spoolMatch[1]!);
        return s ? this.json(res, s) : this.json(res, { error: 'unknown analyzer' }, 404);
      }

      const clearWireMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/wire$/);
      if (method === 'DELETE' && clearWireMatch) {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const ok = this.backend.clearWire(clearWireMatch[1]!);
        return this.json(res, ok ? { ok } : { error: 'unknown analyzer' }, ok ? 200 : 404);
      }

      const retryMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/retry\/(.+)$/);
      if (method === 'POST' && retryMatch) {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const ok = this.backend.retry(retryMatch[1]!, decodeURIComponent(retryMatch[2]!));
        return this.json(res, { ok }, ok ? 200 : 404);
      }

      // Discards a sample so it is never filed. Guarded by same-origin like the
      // other mutating routes; the log records who dropped what.
      const removeMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/queue\/(.+)$/);
      if (method === 'DELETE' && removeMatch) {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const msgId = decodeURIComponent(removeMatch[2]!);
        const ok = this.backend.remove(removeMatch[1]!, msgId);
        if (ok) this.logger.warn({ analyzer: removeMatch[1], msgId }, 'queued sample removed from the admin console');
        return this.json(res, ok ? { ok } : { error: 'unknown queue item' }, ok ? 200 : 404);
      }

      this.json(res, { error: 'not found' }, 404);
    } catch (err) {
      this.logger.error({ err }, 'admin request failed');
      if (!res.headersSent) this.json(res, { error: 'internal error' }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Sign in / reset
  // ---------------------------------------------------------------------------
  private getLogin(req: http.IncomingMessage, res: http.ServerResponse, url: URL, path: string): void {
    // Already signed in? Straight to the dashboard.
    if (this.sessions.get(readCookie(req.headers.cookie, SESSION_COOKIE))) return this.redirect(res, '/');
    const view: LoginView = path === '/reset' || url.searchParams.get('view') === 'reset' ? 'reset' : 'login';
    const notice = url.searchParams.get('changed') === '1' ? 'Password updated. Sign in with the new one.' : null;
    this.html(res, renderLoginPage({ view, notice }));
  }

  private async postLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.sameOrigin(req)) return this.html(res, renderLoginPage({ view: 'login', error: 'Request rejected.' }), 403);

    const form = await readBody(req);
    if (!form) return this.html(res, renderLoginPage({ view: 'login', error: 'Request too large.' }), 413);

    const params = new URLSearchParams(form);
    const username = (params.get('username') ?? '').trim();
    const password = params.get('password') ?? '';
    const peer = this.peer(req);

    const waitMs = this.throttle.retryAfterMs(peer);
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      return this.html(
        res,
        renderLoginPage({ view: 'login', username, error: `Too many attempts. Try again in ${secs}s.` }),
        429,
      );
    }

    if (!username || !password || !this.auth.verifyPassword(username, password)) {
      this.throttle.fail(peer);
      this.logger.warn({ peer, username }, 'admin sign-in rejected');
      return this.html(
        res,
        renderLoginPage({ view: 'login', username, error: 'Incorrect username or password.' }),
        401,
      );
    }

    this.throttle.succeed(peer);
    const sid = this.sessions.create(this.auth.username);
    this.logger.info({ peer, username: this.auth.username }, 'admin signed in');
    this.redirect(res, '/', this.setCookie(sid));
  }

  private async postReset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.sameOrigin(req)) return this.html(res, renderLoginPage({ view: 'reset', error: 'Request rejected.' }), 403);

    const form = await readBody(req);
    if (!form) return this.html(res, renderLoginPage({ view: 'reset', error: 'Request too large.' }), 413);

    const params = new URLSearchParams(form);
    const username = (params.get('username') ?? '').trim();
    const proof = params.get('proof') ?? '';
    const password = params.get('password') ?? '';
    const confirm = params.get('confirm') ?? '';
    const peer = this.peer(req);

    const fail = (error: string, status = 400) =>
      this.html(res, renderLoginPage({ view: 'reset', username, error }), status);

    const waitMs = this.throttle.retryAfterMs(peer);
    if (waitMs > 0) return fail(`Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`, 429);

    if (password !== confirm) return fail('The two new passwords do not match.');
    const strength = checkPasswordStrength(password);
    if (!strength.ok) return fail(strength.reason!);

    // Either proof is accepted; the recovery key exists for the locked-out case.
    const proven = this.auth.verifyPassword(username, proof) || this.auth.verifyRecoveryKey(username, proof);
    if (!proven) {
      this.throttle.fail(peer);
      this.logger.warn({ peer, username }, 'admin password reset rejected');
      return fail('That username with that password or recovery key was not recognised.', 401);
    }

    this.throttle.succeed(peer);
    this.auth.setPassword(password);
    this.sessions.destroyAll();
    this.logger.warn({ peer, username: this.auth.username }, 'admin password reset');
    this.redirect(res, '/login?changed=1', this.clearCookie());
  }

  private async postChangePassword(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    username: string,
    sid: string | null,
  ): Promise<void> {
    const raw = await readBody(req);
    if (!raw) return this.json(res, { error: 'Request too large.' }, 413);

    let body: { current?: string; password?: string; confirm?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return this.json(res, { error: 'Malformed request.' }, 400);
    }

    const current = body.current ?? '';
    const password = body.password ?? '';
    if (password !== (body.confirm ?? '')) return this.json(res, { error: 'The two new passwords do not match.' }, 400);

    const strength = checkPasswordStrength(password);
    if (!strength.ok) return this.json(res, { error: strength.reason }, 400);

    if (!this.auth.verifyPassword(username, current)) {
      this.logger.warn({ peer: this.peer(req), username }, 'admin password change rejected');
      return this.json(res, { error: 'Current password is incorrect.' }, 401);
    }

    this.auth.setPassword(password);
    this.sessions.destroyAll(); // includes this one — the page redirects to /login
    void sid;
    this.logger.warn({ username }, 'admin password changed');
    this.json(res, { ok: true });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private peer(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** The session cookie is SameSite=Strict; this is the belt to that's braces.
   *
   *  Compared on a canonical form, not literally: "localhost", "127.0.0.1" and
   *  "::1" are the same machine reached by different names, and the operator may
   *  type either. A literal `===` rejects a sign-in typed as localhost when the
   *  page was loaded as 127.0.0.1 — the console's own login looking cross-site
   *  to itself. The server binds loopback, so collapsing those spellings gives
   *  up nothing: a request from off-box cannot arrive here in the first place. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // classic form posts from some clients omit it

    // An opaque origin — literally the string "null" — is what a sandboxed
    // renderer sends: VS Code's Simple Browser and similar embedded previews
    // host the page in a sandboxed iframe, so the console's own sign-in arrives
    // with no usable origin and is otherwise rejected as cross-site. Accept it
    // on the same reasoning as an absent Origin above: the listener is bound to
    // loopback, and the session cookie is SameSite=Strict, so a real cross-site
    // page cannot carry a session into the authenticated routes regardless.
    if (origin === 'null') return true;

    const canonical = (value: string): string | null => {
      try {
        const u = new URL(value.includes('://') ? value : `http://${value}`);
        const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        return `${loopback ? 'loopback' : host}:${port}`;
      } catch {
        return null; // "null" origin (sandboxed frame, file://) lands here
      }
    };

    const from = canonical(origin);
    const here = canonical(req.headers.host ?? '');
    if (from === null || here === null || from !== here) {
      this.logger.warn({ origin, host: req.headers.host }, 'admin request rejected — Origin does not match Host');
      return false;
    }
    return true;
  }

  private setCookie(sid: string): string {
    // No Secure flag: this is plain HTTP on 127.0.0.1, where Secure would stop
    // the cookie being stored at all.
    return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict`;
  }

  private clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  private redirect(res: http.ServerResponse, location: string, cookie?: string): void {
    const headers: http.OutgoingHttpHeaders = { location, 'cache-control': 'no-store' };
    if (cookie) headers['set-cookie'] = cookie;
    res.writeHead(302, headers);
    res.end();
  }

  private json(res: http.ServerResponse, body: unknown, status = 200): void {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(s),
      'cache-control': 'no-store',
    });
    res.end(s);
  }

  private html(res: http.ServerResponse, body: string, status = 200): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }
}

/** Collects a request body, or null once it goes past the cap. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}
