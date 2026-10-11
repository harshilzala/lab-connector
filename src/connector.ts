import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { lanesFor, type AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { HmisClient } from './hmis/client.js';
import { GenxHmisClient } from './hmis/genx.js';
import { HmisAudit } from './hmis/audit.js';
import { RetentionSweeper } from './maintenance/retention.js';
import { AnalyzerRuntime, type LaneGateways } from './session/orchestrator.js';
import { LANES, describeLanes, type Lane } from './hmis/lanes.js';
import { AdminServer, type AdminBackend } from './admin/server.js';
import { AuthStore } from './admin/auth.js';
import { AutoCertifyService } from './autocertify/service.js';

// Top-level app: one HMIS client per lane in use (HINAI and/or GenX), one
// AnalyzerRuntime per configured analyzer,
// and the local admin server. Implements AdminBackend so the dashboard can read
// live state.
export class Connector implements AdminBackend {
  private readonly runtimes = new Map<string, AnalyzerRuntime>();
  /** GenX's audit file when GenX is in use (for the start-up line). */
  private readonly genxAuditFile: string | null;
  private readonly admin: AdminServer;
  private readonly auth: AuthStore;
  /** Absent when retention.days is 0 — the sweep is then switched off. */
  private readonly retention?: RetentionSweeper;
  private readonly autoCertifyService: AutoCertifyService;

  /** Every lane any configured analyzer uses, HINAI first. */
  private readonly lanesInUse: Lane[];

  /** The gateway URLs actually in use — HINAI's and/or GenX's. */
  private get hmisUrls(): string[] {
    return this.lanesInUse.map((l) => (l === 'genx' ? this.cfg.hmis.genx.baseUrl : this.cfg.hmis.baseUrl));
  }

  constructor(private readonly cfg: AppConfig, private readonly logger: Logger) {
    // Which HMIS lanes this process needs: decided by what the configured
    // analyzers use, not by which hmis blocks happen to be filled in.
    const perAnalyzer = new Map(cfg.analyzers.map((a) => [a.id, lanesFor(a, cfg)]));
    this.lanesInUse = LANES.filter((l) => [...perAnalyzer.values()].some((ls) => ls.includes(l)));
    const usesHinai = this.lanesInUse.includes('hinai');
    const usesGenx = this.lanesInUse.includes('genx');

    // Separate from the application log on purpose: this one is the evidence
    // trail for "did HMIS actually take it?", and stays greppable by barcode.
    // Not opened in Auto-Certify-only mode (no analyzers): nothing would ever
    // be written to it. HINAI always writes hmis.auditLog; GenX writes there
    // too while it is the only lane in the process (as before), and its own
    // hmis.genx.auditLog once HINAI is in use as well, so the two trails stay
    // apart.
    const openAudit = (file: string | null, mod: string) =>
      file && cfg.analyzers.length ? new HmisAudit(resolve(file), logger.child({ mod }), cfg.hmis.auditMaxBytes) : undefined;
    const g = cfg.hmis.genx;
    const genxLog = usesHinai ? (g.auditLog ?? null) : cfg.hmis.auditLog;
    this.genxAuditFile = usesGenx ? genxLog : null;

    // One client per lane, built once and shared by every analyzer on it.
    const gateways: LaneGateways = {};
    if (usesHinai) {
      gateways.hinai = new HmisClient({
        baseUrl: cfg.hmis.baseUrl,
        siteId: cfg.hmis.siteId,
        siteIds: cfg.hmis.siteIds,
        pendingPath: cfg.hmis.pendingPath,
        acknowledgePath: cfg.hmis.acknowledgePath,
        resultsPath: cfg.hmis.resultsPath,
        timeoutMs: cfg.hmis.timeoutMs,
        tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
        logger: logger.child({ mod: 'hmis' }),
        audit: openAudit(cfg.hmis.auditLog, 'hmis-audit'),
      });
    }
    if (usesGenx) {
      gateways.genx = new GenxHmisClient({
        baseUrl: g.baseUrl,
        tokenPath: g.tokenPath,
        revokePath: g.revokePath,
        worklistPath: g.worklistPath,
        acknowledgePath: g.acknowledgePath,
        resultsPath: g.resultsPath,
        clientId: g.clientId,
        clientSecret: g.clientSecret,
        scope: g.scope,
        clientAuth: g.clientAuth,
        apiKey: g.apiKey || undefined,
        apiKeyHeader: g.apiKeyHeader,
        barcodeField: g.barcodeField,
        serviceTests: g.serviceTests,
        equipmentServices: g.equipmentServices,
        pendingLineStatuses: g.pendingLineStatuses,
        batchDays: g.batchDays,
        batchPageSize: g.batchPageSize,
        accessionCacheFile: g.accessionCacheFile ? resolve(g.accessionCacheFile) : undefined,
        timeoutMs: cfg.hmis.timeoutMs,
        tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized,
        logger: logger.child({ mod: 'hmis-genx' }),
        audit: openAudit(genxLog, usesHinai ? 'hmis-genx-audit' : 'hmis-audit'),
        autoCertifyPath: g.autoCertifyPath,
        autoCertifyMethod: g.autoCertifyMethod,
        autoCertifyParam: g.autoCertifyParam,
      });
    }

    const spoolRoot = resolve(cfg.spoolDir);
    for (const a of cfg.analyzers) {
      // Wire frames go to logs/wire-<id>-YYYY-MM-DD.log beside the HMIS
      // transaction log, so "the instrument says it sent that sample" stays
      // answerable after a restart — for retention.logDays, after which the
      // sweeper removes the day file.
      const wireLogFile = resolve(cfg.retention.logDir, `wire-${a.id}.log`);
      // Each runtime gets the gateways of ITS lanes only.
      const own: LaneGateways = {};
      for (const l of perAnalyzer.get(a.id) ?? []) own[l] = gateways[l];
      this.runtimes.set(a.id, new AnalyzerRuntime(a, own, spoolRoot, logger, wireLogFile, cfg.retention.days || 7, cfg.hmis.patientCheck !== false));
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

    this.autoCertifyService = new AutoCertifyService(cfg.autoCertify, logger.child({ mod: 'auto-certify' }));

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
    this.autoCertifyService.start();

    // A loopback/placeholder HMIS URL starts cleanly but files nothing —
    // results just accumulate in the spool. Say so loudly rather than let a
    // placeholder reach go-live unnoticed.
    for (const url of this.runtimes.size ? this.hmisUrls : []) {
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/i.test(url)) continue;
      this.logger.warn(
        { baseUrl: url },
        'HMIS base URL points at this machine — results will queue in the spool until it is set to the real gateway',
      );
    }
    for (const w of this.cfg.startupWarnings ?? []) this.logger.warn(w);
    if (this.cfg.hmis.patientCheck === false && this.runtimes.size) {
      this.logger.warn('hmis.patientCheck is off — in both HMIS mode a sample is filed even when HINAI and GenX name different patients for its barcode');
    }

    // Printed exactly once, on the start that seeds the auth file. File it with
    // the lab runbook: it is the only way back in if the password is lost.
    if (this.auth.seededRecoveryKey) {
      this.logger.warn(
        { username: this.auth.username, recoveryKey: this.auth.seededRecoveryKey, authFile: this.cfg.admin.authFile },
        'admin credential seeded — record the recovery key now, it is not shown again',
      );
    }

    if (!this.runtimes.size) {
      this.logger.info(
        { autoCertify: this.autoCertifyService.snapshot().config.certifyUrl, dashboard: `http://${this.cfg.admin.host}:${this.cfg.admin.port}/auto-certify` },
        'lab-connector started in Auto-Certify-only mode (no analyzers configured)',
      );
      return;
    }

    this.logger.info(
      {
        analyzers: [...this.runtimes.keys()],
        autoCertify: this.autoCertifyService.enabled ? 'enabled' : 'disabled',
        hmisApi: this.cfg.hmis.api,
        hmis: this.hmisUrls.length === 1 ? this.hmisUrls[0] : this.hmisUrls,
        // Single HINAI: the line it always was. GenX only: its log is
        // hmis.auditLog. Both lanes: each its own.
        ...(this.lanesInUse.length > 1 ? { hmisLanes: describeLanes(this.lanesInUse) } : {}),
        hmisLog: this.lanesInUse.includes('hinai') ? dayLog(this.cfg.hmis.auditLog) : dayLog(this.genxAuditFile),
        ...(this.lanesInUse.length > 1 ? { hmisGenxLog: dayLog(this.genxAuditFile) } : {}),
        wireLogs: `${this.cfg.retention.logDir}/wire-<analyzer>-YYYY-MM-DD.log`,
        retentionDays: this.cfg.retention.days || 'disabled',
        logRetentionDays: this.cfg.retention.days ? this.cfg.retention.logDays : 'disabled',
      },
      'lab-connector started',
    );
  }

  async stop(): Promise<void> {
    this.retention?.stop();
    this.autoCertifyService.stop();
    await this.admin.stop();
    for (const rt of this.runtimes.values()) await rt.stop();
    this.logger.info('lab-connector stopped');
  }

  // ---- AdminBackend ---------------------------------------------------------
  autoCertify(): AutoCertifyService {
    return this.autoCertifyService;
  }

  /** A machine reached over two channels — the IM order push and/or a
   *  separate result listener. Decided from config, exactly as
   *  AnalyzerRuntime.channelStatus() decides it, without touching disk. */
  hasChannels(): boolean {
    return this.cfg.analyzers.some(
      (a) => !!a.resultTransport || (a.protocol === 'hl7' && !!a.hl7.orderPush?.enabled),
    );
  }

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
}

/** ./logs/hmis.log -> "./logs/hmis-YYYY-MM-DD.log", as the start-up line shows it. */
function dayLog(file: string | null): string {
  return file ? file.replace(/(\.[^./\\]+)?$/, '-YYYY-MM-DD$1') : 'disabled';
}
