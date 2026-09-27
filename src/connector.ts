import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { HmisClient } from './hmis/client.js';
import { HmisAudit } from './hmis/audit.js';
import { RetentionSweeper } from './maintenance/retention.js';
import { AnalyzerRuntime } from './session/orchestrator.js';
import { AdminServer, type AdminBackend } from './admin/server.js';
import { AuthStore } from './admin/auth.js';
import { imGateFor } from './config.js';
import { ImTracker } from './im/tracker.js';

// Top-level app: one HMIS client, one AnalyzerRuntime per configured analyzer,
// and the local admin server. Implements AdminBackend so the dashboard can read
// live state.
export class Connector implements AdminBackend {
  private readonly runtimes = new Map<string, AnalyzerRuntime>();
  private readonly hmis: HmisClient;
  /** IM's own Mirth channel for certified results, when im.mirth names one. */
  private readonly imMirthClient: HmisClient | null = null;
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
      siteId: cfg.hmis.siteId,
      siteIds: cfg.hmis.siteIds,
      pendingPath: cfg.hmis.pendingPath,
      acknowledgePath: cfg.hmis.acknowledgePath,
      resultsPath: cfg.hmis.resultsPath,
      timeoutMs: cfg.hmis.timeoutMs,
      tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
      logger: logger.child({ mod: 'hmis' }),
      audit,
      headers: cfg.hmis.headers,
      label: 'mirth',
    });

    // A second client only when IM posts somewhere the pending/acknowledge
    // calls do not: its own base URL, results path or credentials.
    const im = cfg.im;
    if (im.enabled && (im.mirth.baseUrl || im.mirth.resultsPath || Object.keys(im.mirth.headers).length)) {
      this.imMirthClient = new HmisClient({
        baseUrl: im.mirth.baseUrl ?? cfg.hmis.baseUrl,
        siteId: cfg.hmis.siteId,
        siteIds: cfg.hmis.siteIds,
        pendingPath: cfg.hmis.pendingPath,
        acknowledgePath: cfg.hmis.acknowledgePath,
        resultsPath: im.mirth.resultsPath ?? cfg.hmis.resultsPath,
        timeoutMs: cfg.hmis.timeoutMs,
        tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
        logger: logger.child({ mod: 'im-mirth' }),
        audit,
        headers: { ...cfg.hmis.headers, ...im.mirth.headers },
        label: 'im-mirth',
      });
    }

    const spoolRoot = resolve(cfg.spoolDir);
    for (const a of cfg.analyzers) {
      // Wire frames go to logs/wire-<id>-YYYY-MM-DD.log beside the HMIS
      // transaction log, so "the instrument says it sent that sample" stays
      // answerable after a restart — for retention.logDays, after which the
      // sweeper removes the day file.
      const wireLogFile = resolve(cfg.retention.logDir, `wire-${a.id}.log`);
      // IM on for the site: every analyzer is tracked on the IM dashboard;
      // only those whose gate is enabled have results held for review.
      const tracker = im.enabled
        ? new ImTracker(
            a.id,
            imGateFor(cfg, a),
            im.mirth.fields,
            im.mirth.autoCertifiedBy,
            spoolRoot,
            cfg.retention.logDir,
            logger.child({ mod: 'im', analyzer: a.id }),
          )
        : null;
      this.runtimes.set(
        a.id,
        new AnalyzerRuntime(a, this.hmis, spoolRoot, logger, wireLogFile, cfg.retention.days || 7, {
          im: tracker,
          imMirth: this.imMirthClient,
          imReviewKeepDays: im.reviewKeepDays,
        }),
      );
    }

    if (cfg.retention.days > 0) {
      this.retention = new RetentionSweeper({
        days: cfg.retention.days,
        logDays: cfg.retention.logDays,
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
        hmisLog: this.cfg.hmis.auditLog ? this.cfg.hmis.auditLog.replace(/(\.[^./\\]+)?$/, '-YYYY-MM-DD$1') : 'disabled',
        wireLogs: `${this.cfg.retention.logDir}/wire-<analyzer>-YYYY-MM-DD.log`,
        retentionDays: this.cfg.retention.days || 'disabled',
        logRetentionDays: this.cfg.retention.days ? this.cfg.retention.logDays : 'disabled',
        im: this.cfg.im.enabled
          ? {
              gating: [...this.runtimes.values()].filter((r) => r.imTracker()?.enabled).map((r) => r.status().id),
              results: this.imMirthClient ? this.imMirthClient.describe().baseUrl + this.imMirthClient.describe().resultsPath : 'hmis.resultsPath',
            }
          : 'disabled',
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

  staged(id: string) {
    return this.runtimes.get(id)?.stagedSummaries() ?? null;
  }

  ordersView(id: string) {
    return this.runtimes.get(id)?.ordersView() ?? null;
  }

  resendOrder(id: string, barcode: string) {
    return this.runtimes.get(id)?.resendOrder(barcode) ?? Promise.resolve(null);
  }

  fileNow(id: string, barcode: string) {
    return this.runtimes.get(id)?.stagedFileNow(barcode) ?? Promise.resolve(false);
  }

  rekey(id: string, from: string, to: string) {
    return this.runtimes.get(id)?.stagedRekey(from, to) ?? null;
  }

  removeStaged(id: string, barcode: string) {
    return this.runtimes.get(id)?.stagedRemove(barcode) ?? false;
  }

  forceEnabled() {
    return this.cfg.Force_Hmis.password.length > 0;
  }

  /** Constant-time check of the console's Force password (config Force_Hmis). */
  forcePasswordOk(given: string) {
    const want = this.cfg.Force_Hmis.password;
    if (!want) return false;
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(want).digest();
    return timingSafeEqual(a, b);
  }

  force(id: string, barcode: string) {
    return this.runtimes.get(id)?.stagedForce(barcode) ?? Promise.resolve(null);
  }

  // ---- IM dashboard -----------------------------------------------------------
  imEnabled() {
    return this.cfg.im.enabled;
  }

  imOverview() {
    const analyzers = [...this.runtimes.values()].map((rt) => {
      const t = rt.imTracker();
      return {
        status: rt.status(),
        im: t
          ? {
              gating: t.enabled,
              counts: t.counts(),
              ranges: Object.keys(t.gateConfig.ranges).length,
              alwaysReview: t.gateConfig.alwaysReview,
              holdWhenNoRange: t.gateConfig.holdWhenNoRange,
              holdOnAnalyzerFlag: t.gateConfig.holdOnAnalyzerFlag,
            }
          : null,
      };
    });
    return { enabled: this.cfg.im.enabled, analyzers };
  }

  imReview() {
    return [...this.runtimes.values()]
      .flatMap((rt) => rt.imTracker()?.reviewList() ?? [])
      .sort((a, b) => {
        if ((a.pending > 0) !== (b.pending > 0)) return a.pending > 0 ? -1 : 1;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
  }

  imOrders() {
    return [...this.runtimes.values()]
      .flatMap((rt) => rt.imTracker()?.orders() ?? [])
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  }

  imOrder(id: string, barcode: string) {
    const rt = this.runtimes.get(id);
    const t = rt?.imTracker();
    if (!rt || !t) return null;
    return {
      analyzer: id,
      barcode: barcode.trim().toUpperCase(),
      order: rt.storedOrder(barcode),
      review: t.reviewSample(barcode),
      history: t.history(barcode),
    };
  }

  imLog(id: string) {
    return this.runtimes.get(id)?.imTracker()?.transactions.recent(200) ?? null;
  }

  imVerify(id: string, barcode: string, codes: string[], user: string, comment: string | null) {
    return this.runtimes.get(id)?.imVerify(barcode, codes, user, comment) ?? Promise.resolve(null);
  }

  imReject(id: string, barcode: string, codes: string[], user: string, comment: string | null) {
    return this.runtimes.get(id)?.imReject(barcode, codes, user, comment) ?? null;
  }

  imMirth() {
    const clients = [this.hmis, ...(this.imMirthClient ? [this.imMirthClient] : [])];
    return {
      clients: clients.map((c) => c.describe()),
      fields: this.cfg.im.mirth.fields,
      autoCertifiedBy: this.cfg.im.mirth.autoCertifiedBy,
      columns: this.hmis.seenColumns(),
      exchanges: clients
        .flatMap((c) => c.recentExchanges())
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, 150),
    };
  }

  imMirthProbe(id: string, sampleId: string) {
    return this.runtimes.get(id)?.mirthProbe(sampleId) ?? Promise.resolve(null);
  }

  imMirthPreview(id: string, barcode: string) {
    return this.runtimes.get(id)?.mirthPreview(barcode) ?? null;
  }
}
