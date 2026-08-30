import http from 'node:http';
import type { Logger } from '../logger.js';
import type { AnalyzerStatus, WireLogEntry } from '../session/orchestrator.js';
import type { SpoolEnvelope } from '../queue/spool.js';
import type { HmisResultUpload } from '../types.js';
import { renderDashboard } from './dashboard.js';
import { ZYDUS_LOGO_SVG } from './logo.js';

export interface AdminBackend {
  statuses(): AnalyzerStatus[];
  wire(id: string): WireLogEntry[] | null;
  spool(id: string): { pending: SpoolEnvelope<HmisResultUpload>[]; failed: SpoolEnvelope<HmisResultUpload>[] } | null;
  retry(id: string, msgId: string): boolean;
}

// Local-only admin + monitoring UI. Bind to 127.0.0.1 so it isn't exposed on
// the hospital LAN. Shows analyzer connection state, live wire log, and the
// store-and-forward backlog with a manual retry for parked items.
//
// There is no sign-in: the console is open to anyone who can reach the port,
// so the loopback bind is the only thing keeping the wire log — which carries
// patient barcodes and results — off the network. Do not move admin.host off
// 127.0.0.1 without putting an authenticating proxy in front of it.
export class AdminServer {
  private server: http.Server | null = null;

  constructor(
    private readonly backend: AdminBackend,
    private readonly host: string,
    private readonly port: number,
    private readonly logger: Logger,
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
        this.logger.info({ url: `http://${this.host}:${this.port}` }, 'admin dashboard listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
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
      if (method === 'GET' && p === '/assets/zydus-logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        return void res.end(ZYDUS_LOGO_SVG);
      }

      if (method === 'GET' && p === '/') {
        return this.html(res, renderDashboard());
      }

      if (method === 'GET' && p === '/api/status') {
        return this.json(res, { analyzers: this.backend.statuses() });
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

      const retryMatch = p.match(/^\/api\/analyzers\/([a-z0-9-]+)\/retry\/(.+)$/);
      if (method === 'POST' && retryMatch) {
        // Retry is the one state-changing route left; keep it off-limits to a
        // page on another origin even though there is no session to ride on.
        if (!this.sameOrigin(req)) return this.json(res, { error: 'cross-origin request rejected' }, 403);
        const ok = this.backend.retry(retryMatch[1]!, decodeURIComponent(retryMatch[2]!));
        return this.json(res, { ok }, ok ? 200 : 404);
      }

      this.json(res, { error: 'not found' }, 404);
    } catch (err) {
      this.logger.error({ err }, 'admin request failed');
      if (!res.headersSent) this.json(res, { error: 'internal error' }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // classic form posts from some clients omit it
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
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
