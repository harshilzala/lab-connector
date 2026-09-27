import { resolve } from 'node:path';
import type { AutoCertifyConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { DailyLogFile } from '../maintenance/daily-log.js';
import { OracleCertifySource, type CertifyCandidate, type CertifySource } from './source.js';

// =============================================================================
// AUTO CERTIFY — the port of the old Certify_Results Windows service.
//
// Each tick:
//   1. read the results that are ready to certify from the HIS Oracle database
//      (see source.ts for the query),
//   2. a result with parameters (ithasparameter = 'Y') waits while any of this
//      equipment's parameter rows is still in a parameterResultStatus. Once
//      none is, every parameter row of the result is certified:
//        GET <baseUrl><certifyPath>?labparameterresultid=<id>
//      any other result is certified as a whole:
//        GET <baseUrl><certifyPath>?labresultid=<id>
//   3. record every call, and each run's start and end, in the day log, and
//      every call in the console history.
//
// The HIS portal does the certification. This job only reads Oracle and calls
// the portal, the same split as the old service.
//
// A call that fails is not retried inside the run. The result is still in its
// "ready" status, so the next tick picks it up again, as the old service did.
// =============================================================================

export type CertifyKind = 'result' | 'parameter';

export interface CertifyAttempt {
  at: string;
  kind: CertifyKind;
  labResultId: string;
  labResultParameterId: string | null;
  sampleId: string;
  labOrderId: string;
  equipmentId: string;
  labServiceId: string;
  autoCertifyLab: string | null;
  ok: boolean;
  httpStatus: number | null;
  /** The portal's answer, trimmed. On a transport failure, the error message. */
  response: string;
  durationMs: number;
  /** Set when a person started the run from the console. */
  manual?: boolean;
}

export interface AutoCertifyRun {
  startedAt: string;
  finishedAt: string | null;
  manual: boolean;
  found: number;
  certified: number;
  failed: number;
  /** Results with parameters still in a parameterResultStatus: not finished,
   *  so nothing was sent. The next run looks at them again. */
  waiting: number;
  error: string | null;
}

export interface AutoCertifySnapshot {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  intervalSeconds: number;
  nextRunAt: string | null;
  lastRun: AutoCertifyRun | null;
  totals: { runs: number; certified: number; failed: number; since: string };
  config: {
    certifyUrl: string;
    siteId: string | null;
    equipmentIds: string[];
    resultStatus: string[];
    parameterResultStatus: string[];
    lookbackDays: number;
    requireHod: boolean;
    oracle: { user: string; connectString: string; passwordSet: boolean };
    logFile: string | null;
  };
}

/** What a run would do with one result, without doing it. */
export interface PreviewCandidate extends CertifyCandidate {
  /** Parameters still in a parameterResultStatus. When non-empty, the result waits. Null for a whole result. */
  blockingParameterIds: string[] | null;
  /** Parameter rows that would be certified. Null for a whole result. */
  parameterIds: string[] | null;
}

export interface CertifyTransport {
  get(url: string, timeoutMs: number): Promise<{ status: number; body: string }>;
}

const fetchTransport: CertifyTransport = {
  async get(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  },
};

const RESPONSE_CAP = 500;

export class AutoCertifyService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private paused = false;
  private nextRunAt: number | null = null;
  private lastRun: AutoCertifyRun | null = null;
  private readonly recent: CertifyAttempt[] = [];
  private readonly totals = { runs: 0, certified: 0, failed: 0, since: new Date().toISOString() };
  private readonly dayLog: DailyLogFile | null;
  private readonly makeSource: () => CertifySource;
  private readonly transport: CertifyTransport;

  constructor(
    private readonly cfg: AutoCertifyConfig,
    private readonly logger: Logger,
    deps: { source?: () => CertifySource; transport?: CertifyTransport } = {},
  ) {
    this.makeSource = deps.source ?? (() => new OracleCertifySource(cfg));
    this.transport = deps.transport ?? fetchTransport;
    this.dayLog = cfg.logFile ? new DailyLogFile(resolve(cfg.logFile), logger) : null;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.logger.info('auto certify is disabled (autoCertify.enabled = false)');
      return;
    }
    this.logger.info(
      {
        certifyUrl: this.certifyUrl(),
        siteId: this.cfg.siteId,
        equipmentIds: this.cfg.equipmentIds,
        intervalSeconds: this.cfg.intervalSeconds,
      },
      'auto certify started',
    );
    this.schedule(5_000); // the first run shortly after start, not a whole interval later
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Pause or resume the scheduled runs. Runtime only: a restart goes back to config. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.logger.warn({ paused }, paused ? 'auto certify paused from the console' : 'auto certify resumed from the console');
  }

  /**
   * Run once now. Refused while a run is already going, because two runs would
   * certify the same results twice.
   */
  async runNow(): Promise<AutoCertifyRun> {
    if (!this.cfg.enabled) throw new Error('Auto Certify is disabled in config.json (autoCertify.enabled)');
    if (this.running) throw new Error('a run is already in progress');
    return this.run(true);
  }

  /** Read what would be certified now, without calling the portal. */
  async preview(): Promise<{ candidates: PreviewCandidate[] }> {
    if (!this.cfg.enabled) throw new Error('Auto Certify is disabled in config.json (autoCertify.enabled)');
    const source = this.makeSource();
    try {
      const results = await source.pendingResults();
      const candidates: PreviewCandidate[] = [];
      for (const r of results) {
        if (!r.hasParameter) {
          candidates.push({ ...r, blockingParameterIds: null, parameterIds: null });
          continue;
        }
        const blocking = await source.blockingParameters(r.labResultId);
        candidates.push({
          ...r,
          blockingParameterIds: blocking,
          parameterIds: blocking.length ? [] : await source.allParameters(r.labResultId),
        });
      }
      return { candidates };
    } finally {
      await source.close();
    }
  }

  history(): CertifyAttempt[] {
    return [...this.recent].reverse();
  }

  snapshot(): AutoCertifySnapshot {
    return {
      enabled: this.cfg.enabled,
      paused: this.paused,
      running: this.running,
      intervalSeconds: this.cfg.intervalSeconds,
      nextRunAt: this.nextRunAt && !this.paused ? new Date(this.nextRunAt).toISOString() : null,
      lastRun: this.lastRun,
      totals: { ...this.totals },
      config: {
        certifyUrl: this.certifyUrl(),
        siteId: this.cfg.siteId ?? null,
        equipmentIds: this.cfg.equipmentIds,
        resultStatus: this.cfg.resultStatus,
        parameterResultStatus: this.cfg.parameterResultStatus,
        lookbackDays: this.cfg.lookbackDays,
        requireHod: this.cfg.requireHod,
        oracle: {
          user: this.cfg.oracle.user,
          connectString: this.cfg.oracle.connectString,
          passwordSet: !!this.cfg.oracle.password,
        },
        logFile: this.dayLog ? this.dayLog.currentPath() : null,
      },
    };
  }

  // ---------------------------------------------------------------------------

  private certifyUrl(): string {
    return (this.cfg.baseUrl ?? '').replace(/\/+$/, '') + this.cfg.certifyPath;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = Date.now() + delayMs;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      if (!this.paused && !this.running) await this.run(false);
    } finally {
      this.schedule(this.cfg.intervalSeconds * 1000);
    }
  }

  private async run(manual: boolean): Promise<AutoCertifyRun> {
    this.running = true;
    const run: AutoCertifyRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      manual,
      found: 0,
      certified: 0,
      failed: 0,
      waiting: 0,
      error: null,
    };
    this.lastRun = run;
    this.dayLog?.append(JSON.stringify({ at: run.startedAt, event: 'run-started', manual }));
    const source = this.makeSource();
    try {
      const results = await source.pendingResults();
      run.found = results.length;
      if (results.length) this.logger.info({ found: results.length, manual }, 'auto certify: results ready');

      for (const r of results) {
        if (r.hasParameter) {
          if ((await source.blockingParameters(r.labResultId)).length) {
            run.waiting++;
            continue;
          }
          for (const p of await source.allParameters(r.labResultId)) {
            this.tally(run, await this.certify('parameter', r, p, manual));
          }
        } else {
          this.tally(run, await this.certify('result', r, null, manual));
        }
      }
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: run.error }, 'auto certify run failed');
    } finally {
      await source.close();
      run.finishedAt = new Date().toISOString();
      this.totals.runs++;
      this.running = false;
      this.dayLog?.append(JSON.stringify({ at: run.finishedAt, event: run.error ? 'run-failed' : 'run-completed', ...run }));
    }
    if (run.certified || run.failed) {
      this.logger.info(
        { certified: run.certified, failed: run.failed, waiting: run.waiting, manual },
        'auto certify run completed',
      );
    }
    return run;
  }

  private tally(run: AutoCertifyRun, a: CertifyAttempt): void {
    if (a.ok) {
      run.certified++;
      this.totals.certified++;
    } else {
      run.failed++;
      this.totals.failed++;
    }
  }

  private async certify(
    kind: CertifyKind,
    r: CertifyCandidate,
    parameterId: string | null,
    manual: boolean,
  ): Promise<CertifyAttempt> {
    const query = kind === 'parameter' ? `labparameterresultid=${encodeURIComponent(parameterId!)}` : `labresultid=${encodeURIComponent(r.labResultId)}`;
    const url = `${this.certifyUrl()}?${query}`;
    const t0 = Date.now();
    let httpStatus: number | null = null;
    let response = '';
    let ok = false;
    try {
      const res = await this.transport.get(url, this.cfg.timeoutMs);
      httpStatus = res.status;
      response = res.body;
      ok = res.status >= 200 && res.status < 300;
    } catch (err) {
      response = err instanceof Error ? (err.name === 'AbortError' ? `timed out after ${this.cfg.timeoutMs} ms` : err.message) : String(err);
    }

    const attempt: CertifyAttempt = {
      at: new Date().toISOString(),
      kind,
      labResultId: r.labResultId,
      labResultParameterId: parameterId,
      sampleId: r.sampleId,
      labOrderId: r.labOrderId,
      equipmentId: r.equipmentId,
      labServiceId: r.labServiceId,
      autoCertifyLab: r.autoCertifyLab,
      ok,
      httpStatus,
      response: response.length > RESPONSE_CAP ? response.slice(0, RESPONSE_CAP) + '…' : response,
      durationMs: Date.now() - t0,
      ...(manual ? { manual } : {}),
    };

    this.recent.push(attempt);
    if (this.recent.length > this.cfg.historySize) this.recent.splice(0, this.recent.length - this.cfg.historySize);
    this.dayLog?.append(JSON.stringify({ ...attempt, url }));

    const log = { kind, labResultId: r.labResultId, parameterId, sampleId: r.sampleId, httpStatus };
    if (ok) this.logger.info(log, 'auto certify: certified');
    else this.logger.warn({ ...log, response: attempt.response }, 'auto certify: certify call failed');
    return attempt;
  }
}
