import { resolve } from 'node:path';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { HmisClient } from './hmis/client.js';
import { AnalyzerRuntime } from './session/orchestrator.js';
import { AdminServer, type AdminBackend } from './admin/server.js';
import { AuthStore } from './admin/auth.js';

// Top-level app: one HMIS client, one AnalyzerRuntime per configured analyzer,
// and the local admin server. Implements AdminBackend so the dashboard can read
// live state.
export class Connector implements AdminBackend {
  private readonly runtimes = new Map<string, AnalyzerRuntime>();
  private readonly hmis: HmisClient;
  private readonly admin: AdminServer;
  private readonly auth: AuthStore;

  constructor(private readonly cfg: AppConfig, private readonly logger: Logger) {
    this.hmis = new HmisClient({
      baseUrl: cfg.hmis.baseUrl,
      pendingPath: cfg.hmis.pendingPath,
      acknowledgePath: cfg.hmis.acknowledgePath,
      resultsPath: cfg.hmis.resultsPath,
      timeoutMs: cfg.hmis.timeoutMs,
      tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
      logger: logger.child({ mod: 'hmis' }),
    });

    const spoolRoot = resolve(cfg.spoolDir);
    for (const a of cfg.analyzers) {
      this.runtimes.set(a.id, new AnalyzerRuntime(a, this.hmis, spoolRoot, logger));
    }

    this.auth = new AuthStore(cfg.admin.authFile);
    this.admin = new AdminServer(
      this,
      cfg.admin.host,
      cfg.admin.port,
      logger.child({ mod: 'admin' }),
      this.auth,
    );
  }

  async start(): Promise<void> {
    for (const rt of this.runtimes.values()) await rt.start();
    await this.admin.start();

    // A loopback/placeholder HMIS URL starts cleanly but files nothing —
    // results just accumulate in the spool. Say so loudly rather than let a
    // placeholder reach go-live unnoticed.
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/i.test(this.cfg.hmis.baseUrl)) {
      this.logger.warn(
        { baseUrl: this.cfg.hmis.baseUrl },
        'HMIS base URL points at this machine — results will queue in the spool until it is set to the real gateway',
      );
    }

    // Printed exactly once, on the start that seeds the auth file. File it with
    // the lab runbook: it is the only way back in if the password is lost.
    if (this.auth.seededRecoveryKey) {
      this.logger.warn(
        { username: this.auth.username, recoveryKey: this.auth.seededRecoveryKey, authFile: this.cfg.admin.authFile },
        'admin credential seeded — record the recovery key now, it is not shown again',
      );
    }

    this.logger.info(
      { analyzers: [...this.runtimes.keys()], hmis: this.cfg.hmis.baseUrl },
      'lab-connector started',
    );
  }

  async stop(): Promise<void> {
    await this.admin.stop();
    for (const rt of this.runtimes.values()) await rt.stop();
    this.logger.info('lab-connector stopped');
  }

  // ---- AdminBackend ---------------------------------------------------------
  statuses() {
    return [...this.runtimes.values()].map((r) => r.status());
  }

  wire(id: string) {
    return this.runtimes.get(id)?.recentWire() ?? null;
  }

  spool(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    return { pending: rt.spoolPending(), failed: rt.spoolFailed() };
  }

  retry(id: string, msgId: string) {
    return this.runtimes.get(id)?.retryFailed(msgId) ?? false;
  }
}
