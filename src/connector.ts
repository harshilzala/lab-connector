import { resolve } from 'node:path';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { HmisClient } from './hmis/client.js';
import { HmisAudit } from './hmis/audit.js';
import { RetentionSweeper } from './maintenance/retention.js';
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
  /** Absent when retention.days is 0 — the sweep is then switched off. */
  private readonly retention?: RetentionSweeper;

  constructor(private readonly cfg: AppConfig, private readonly logger: Logger) {
    // Separate from the application log on purpose: this one is the evidence
    // trail for "did HMIS actually take it?", and stays greppable by barcode.
    const audit = cfg.hmis.auditLog
      ? new HmisAudit(resolve(cfg.hmis.auditLog), logger.child({ mod: 'hmis-audit' }), cfg.hmis.auditMaxBytes)
      : undefined;

    this.hmis = new HmisClient({
      baseUrl: cfg.hmis.baseUrl,
      pendingPath: cfg.hmis.pendingPath,
      acknowledgePath: cfg.hmis.acknowledgePath,
      resultsPath: cfg.hmis.resultsPath,
      timeoutMs: cfg.hmis.timeoutMs,
      tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
      logger: logger.child({ mod: 'hmis' }),
      audit,
    });

    const spoolRoot = resolve(cfg.spoolDir);
    for (const a of cfg.analyzers) {
      this.runtimes.set(a.id, new AnalyzerRuntime(a, this.hmis, spoolRoot, logger));
    }

    if (cfg.retention.days > 0) {
      this.retention = new RetentionSweeper({
        days: cfg.retention.days,
        logDir: resolve(cfg.retention.logDir),
        spoolRoot,
        intervalMs: Math.round(cfg.retention.sweepIntervalHours * 60 * 60 * 1000),
        includeSpoolPending: cfg.retention.includeSpoolPending,
        logger: logger.child({ mod: 'retention' }),
      });
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
    // After the runtimes, so a sweep never races the spool dirs being created.
    this.retention?.start();

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
      {
        analyzers: [...this.runtimes.keys()],
        hmis: this.cfg.hmis.baseUrl,
        hmisLog: this.cfg.hmis.auditLog ?? 'disabled',
        retentionDays: this.cfg.retention.days || 'disabled',
      },
      'lab-connector started',
    );
  }

  async stop(): Promise<void> {
    this.retention?.stop();
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

  clearWire(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return false;
    rt.clearWire();
    return true;
  }

  remove(id: string, msgId: string) {
    return this.runtimes.get(id)?.discardSpooled(msgId) ?? false;
  }
}
