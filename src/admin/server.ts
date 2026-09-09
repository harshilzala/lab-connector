import http from 'node:http';
import type { Logger } from '../logger.js';
import type { AnalyzerStatus, WireLogEntry } from '../session/orchestrator.js';
import type { SpoolEnvelope } from '../queue/spool.js';
import type { HmisResultUpload } from '../types.js';
import { renderDashboard } from './dashboard.js';
import { renderConnectorTool } from './connector-tool.js';
import { ProbeSession, type ProbeTransportConfig } from '../probe/session.js';
import { FAMILY_LABELS, identify, knownProtocols, parsePayload } from '../probe/identify.js';
import { listSerialPorts, scanTcp, sweepBaudRates } from '../probe/discover.js';
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
  /** filing.mode "staged" analyzers — null for a queued one. */
  staged(id: string): StagedSummary[] | null;
  fileNow(id: string, barcode: string): Promise<boolean>;
  /** Returns the barcode the sample now sits under, or null. */
  rekey(id: string, from: string, to: string): string | null;
  removeStaged(id: string, barcode: string): boolean;
}
import type { StagedSummary } from '../results/store.js';

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
  // The Connector Tool's probe. One per console: it is a commissioning
  // instrument, not a service, and two probes racing for the same port would
  // only produce a capture nobody can read.
  private probe: ProbeSession | null = null;

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
    if (this.probe) await this.probe.stop().catch(() => {});
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

      // ---- staged result store (filing.mode "staged") ----
      const stagedList = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/staged$/);
      if (method === 'GET' && stagedList) {
        const s = this.backend.staged(stagedList[1]!);
        return s ? this.json(res, { samples: s }) : this.json(res, { error: 'not a staged analyzer' }, 404);
      }

      const stagedAction = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/staged\/([^/]+)\/(file|rekey)$/);
      if (method === 'POST' && stagedAction) {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const id = stagedAction[1]!;
        const barcode = decodeURIComponent(stagedAction[2]!);
        if (stagedAction[3] === 'file') {
          const ok = await this.backend.fileNow(id, barcode);
          return this.json(res, ok ? { ok } : { error: 'unknown sample' }, ok ? 200 : 404);
        }
        let to = '';
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as { to?: unknown };
          to = String(body.to ?? '').trim();
        } catch {
          /* not JSON — treated as no barcode given */
        }
        if (!to) return this.json(res, { error: 'the new barcode is required' }, 400);
        const moved = this.backend.rekey(id, barcode, to);
        if (moved) this.logger.warn({ analyzer: id, from: barcode, to: moved }, 'staged sample re-keyed from the admin console');
        return this.json(res, moved ? { ok: true, barcode: moved } : { error: 'unknown sample' }, moved ? 200 : 404);
      }

      const stagedRemove = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/staged\/([^/]+)$/);
      if (method === 'DELETE' && stagedRemove) {
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const barcode = decodeURIComponent(stagedRemove[2]!);
        const ok = this.backend.removeStaged(stagedRemove[1]!, barcode);
        if (ok) this.logger.warn({ analyzer: stagedRemove[1], barcode }, 'staged sample removed from the admin console');
        return this.json(res, ok ? { ok } : { error: 'unknown sample' }, ok ? 200 : 404);
      }

      // ---- Connector Tool: the universal device monitor ----
      if (method === 'GET' && p === '/connector') {
        return this.html(res, renderConnectorTool({ username: session.username }));
      }
      if (p.startsWith('/api/connector')) {
        // Everything under here either opens sockets or drives a live link, so
        // the same-origin guard the other mutating routes use applies to every
        // verb except the read-only GETs.
        if (method !== 'GET' && !this.sameOrigin(req)) {
          return this.json(res, { error: 'cross-origin request rejected' }, 403);
        }
        return await this.connectorTool(req, res, p, method);
      }

      this.json(res, { error: 'not found' }, 404);
    } catch (err) {
      this.logger.error({ err }, 'admin request failed');
      if (!res.headersSent) this.json(res, { error: 'internal error' }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Connector Tool
  //
  // A commissioning instrument, not part of the interface: it opens raw links
  // to unknown devices, records what arrives and fingerprints it. It never
  // files a result, touches the spool or calls HMIS. The probe is bound to this
  // console's lifetime and is stopped when the server stops.
  // ---------------------------------------------------------------------------
  private async connectorTool(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: string,
    method: string,
  ): Promise<void> {
    const body = async (): Promise<Record<string, unknown>> => {
      const raw = await readBody(req);
      if (raw === null) throw new Error('request body too large');
      if (!raw) return {};
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error('request body is not valid JSON');
      }
    };

    try {
      // ---- discovery ----
      if (method === 'GET' && p === '/api/connector/protocols') {
        return this.json(res, { protocols: knownProtocols(), families: FAMILY_LABELS });
      }

      if (method === 'POST' && p === '/api/connector/scan') {
        const b = await body();
        const host = String(b.host ?? '').trim();
        if (!host) return this.json(res, { error: 'a host, range or CIDR is required' }, 400);
        const ports = Array.isArray(b.ports) ? b.ports.map(Number).filter((n) => n > 0 && n < 65536) : undefined;
        const result = await scanTcp(
          {
            host,
            ...(ports?.length ? { ports } : {}),
            ...(b.connectTimeoutMs
              ? { connectTimeoutMs: Math.min(5000, Math.max(100, Number(b.connectTimeoutMs))) }
              : {}),
          },
          this.logger,
        );
        return this.json(res, result);
      }

      if (method === 'GET' && p === '/api/connector/serial') {
        return this.json(res, await listSerialPorts());
      }

      if (method === 'POST' && p === '/api/connector/serial/sweep') {
        const b = await body();
        const path = String(b.path ?? '').trim();
        if (!path) return this.json(res, { error: 'a serial port path is required' }, 400);
        const listenMsPerRate = b.listenMsPerRate
          ? Math.min(15000, Math.max(500, Number(b.listenMsPerRate)))
          : undefined;
        return this.json(res, await sweepBaudRates(path, listenMsPerRate ? { listenMsPerRate } : {}));
      }

      // ---- probe ----
      if (method === 'GET' && p === '/api/connector/probe') {
        return this.json(
          res,
          this.probe
            ? { state: this.probe.snapshot(), log: this.probe.log() }
            : { state: IDLE_PROBE_STATE, log: [] },
        );
      }

      if (method === 'POST' && p === '/api/connector/probe/start') {
        const b = await body();
        const transport = parseProbeTransport(b.transport);
        // One probe at a time — a second start replaces the first rather than
        // leaving an orphan holding the port.
        if (this.probe) await this.probe.stop();
        this.probe = new ProbeSession(
          {
            transport,
            autoAck: b.autoAck !== false,
            maxCaptureBytes: 4 * 1024 * 1024,
            maxEvents: 2000,
          },
          this.logger.child({ mod: 'connector-tool' }),
          'captures',
        );
        await this.probe.start();
        return this.json(res, { ok: true, state: this.probe.snapshot() });
      }

      if (method === 'POST' && p === '/api/connector/probe/stop') {
        if (!this.probe) return this.json(res, { error: 'no probe is running' }, 400);
        await this.probe.stop();
        return this.json(res, { ok: true, state: this.probe.snapshot() });
      }

      if (method === 'POST' && p === '/api/connector/probe/clear') {
        if (!this.probe) return this.json(res, { error: 'no probe has been started' }, 400);
        this.probe.clear();
        return this.json(res, { ok: true });
      }

      if (method === 'POST' && p === '/api/connector/probe/save') {
        if (!this.probe) return this.json(res, { error: 'no probe has been started' }, 400);
        return this.json(res, this.probe.save());
      }

      if (method === 'POST' && p === '/api/connector/probe/send') {
        if (!this.probe) return this.json(res, { error: 'no probe is running' }, 400);
        const b = await body();
        const mode = b.mode === 'hex' ? 'hex' : 'text';
        const data = parsePayload(String(b.data ?? ''), mode);
        if (!data.length) return this.json(res, { error: 'nothing to send' }, 400);
        await this.probe.send(data);
        return this.json(res, { ok: true, bytes: data.length });
      }

      // ---- identify ----
      if (p === '/api/connector/identify') {
        if (method === 'GET') {
          if (!this.probe) return this.json(res, { error: 'no capture yet — start a probe or paste data' }, 400);
          return this.json(res, this.probe.analyze());
        }
        if (method === 'POST') {
          const b = await body();
          const mode = b.mode === 'hex' ? 'hex' : 'text';
          return this.json(res, identify(parsePayload(String(b.data ?? ''), mode)));
        }
      }

      return this.json(res, { error: 'not found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: message, path: p }, 'connector-tool request failed');
      return this.json(res, { error: message }, 400);
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

/** The shape the Connector Tool page expects before any probe has been started. */
const IDLE_PROBE_STATE = {
  running: false,
  endpoint: '',
  autoAck: true,
  connected: false,
  startedAt: null,
  connectedAt: null,
  bytesIn: 0,
  bytesOut: 0,
  lastActivityAt: null,
  error: null,
};

/**
 * Validate the transport the operator described in the browser. The probe opens
 * real sockets and real COM ports, so every field is checked here rather than
 * trusted — a typo should be a 400, not an exception out of the transport.
 */
function parseProbeTransport(raw: unknown): ProbeTransportConfig {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.type === 'serial') {
    const path = String(t.path ?? '').trim();
    if (!path) throw new Error('a serial port path is required');
    const baudRate = Number(t.baudRate ?? 9600);
    if (!Number.isFinite(baudRate) || baudRate <= 0) throw new Error('baud rate must be a positive number');
    const dataBits = Number(t.dataBits ?? 8);
    if (![5, 6, 7, 8].includes(dataBits)) throw new Error('data bits must be 5, 6, 7 or 8');
    const stopBits = Number(t.stopBits ?? 1);
    if (![1, 2].includes(stopBits)) throw new Error('stop bits must be 1 or 2');
    const parity = String(t.parity ?? 'none');
    if (!['none', 'even', 'odd', 'mark', 'space'].includes(parity)) throw new Error(`unknown parity "${parity}"`);
    return {
      type: 'serial',
      path,
      baudRate,
      dataBits: dataBits as 5 | 6 | 7 | 8,
      stopBits: stopBits as 1 | 2,
      parity: parity as 'none' | 'even' | 'odd' | 'mark' | 'space',
      dtr: t.dtr !== false,
      rts: t.rts !== false,
    };
  }

  const mode = String(t.mode ?? 'server');
  if (mode !== 'server' && mode !== 'client') throw new Error('mode must be "server" or "client"');
  const port = Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  const host = String(t.host ?? (mode === 'server' ? '0.0.0.0' : '')).trim();
  if (!host) throw new Error('a host is required to dial a device');
  return { type: 'tcp', mode, host, port };
}
