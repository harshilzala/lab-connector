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
//
// Differences from the old service, each from its own logs (Jun-Oct 2026):
//   - The portal answers HTTP 200 even when it did NOT certify:
//     {"Statue":"Fail","Error":"... optimistic locking failed ..."} (155 times
//     in the 35 days studied). The old service logged those as successes.
//     Here a call counts as certified only when the body says so (see
//     portalVerdict); the result is found again and retried next run.
//   - A row the portal confirmed is not called again for skipRecertifyHours,
//     even if the database still lists it as ready (the old service called
//     some every 30 s for hours).
//   - The two parameter lookups are made for all of a run's results at once
//     (source.blockingParametersFor / allParametersFor), not once per result.
//   - `concurrency` results may be certified at the same time (default 1 =
//     the old order exactly). A result's own parameters always go one by one.
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
  /** Rows not called because the portal confirmed them within
   *  skipRecertifyHours (the database still lists them as ready). */
  skipped: number;
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
    concurrency: number;
    skipRecertifyHours: number;
    oracle: { user: string; connectString: string; passwordSet: boolean };
    logFile: string | null;
  };
}

/**
 * Did the portal certify it? HTTP 2xx is necessary but not enough: the HIS
 * portal answers 200 with {"Statue":"Success"} or {"Statue":"Fail","Error":…}
 * ("Statue" is the portal's own spelling; "Status" is accepted too, any case).
 * A body with no such field, or one that is not JSON, is judged by the HTTP
 * status alone — what the old service did for every answer.
 */
export function portalVerdict(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  const field = Object.entries(parsed as Record<string, unknown>).find(([k]) => /^(statue|status)$/i.test(k));
  if (!field) return true;
  return String(field[1]).trim().toLowerCase() === 'success';
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
  /** "result:<id>" / "parameter:<id>" -> when the portal confirmed it. */
  private readonly confirmed = new Map<string, number>();
  /** Rows already reported as "confirmed but still listed ready". */
  private readonly skipWarned = new Set<string>();

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
      const { blocking, params } = await this.parameterLookups(source, results);
      const candidates: PreviewCandidate[] = results.map((r) => {
        if (!r.hasParameter) return { ...r, blockingParameterIds: null, parameterIds: null };
        const b = blocking.get(r.labResultId) ?? [];
        return { ...r, blockingParameterIds: b, parameterIds: b.length ? [] : (params.get(r.labResultId) ?? []) };
      });
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
        concurrency: this.concurrency(),
        skipRecertifyHours: this.skipHours(),
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
      skipped: 0,
      error: null,
    };
    this.lastRun = run;
    this.dayLog?.append(JSON.stringify({ at: run.startedAt, event: 'run-started', manual }));
    const source = this.makeSource();
    try {
      const results = await source.pendingResults();
      run.found = results.length;
      if (results.length) this.logger.info({ found: results.length, manual }, 'auto certify: results ready');
      this.forgetOldConfirmations();

      // Both parameter lookups for the whole run first: two database round
      // trips (per IN_CHUNK results) instead of two per result.
      const { blocking, params } = await this.parameterLookups(source, results);

      await this.eachConcurrently(results, async (r) => {
        if (r.hasParameter) {
          if ((blocking.get(r.labResultId) ?? []).length) {
            run.waiting++;
            return;
          }
          // A result's own parameters: one after another, always.
          for (const p of params.get(r.labResultId) ?? []) await this.certifyOnce(run, 'parameter', r, p, manual);
        } else {
          await this.certifyOnce(run, 'result', r, null, manual);
        }
      });
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
        { certified: run.certified, failed: run.failed, waiting: run.waiting, skipped: run.skipped, manual },
        'auto certify run completed',
      );
    }
    return run;
  }

  private concurrency(): number {
    return Math.min(8, Math.max(1, Math.floor(this.cfg.concurrency ?? 1)));
  }

  private skipHours(): number {
    return Math.max(0, this.cfg.skipRecertifyHours ?? 24);
  }

  /** Blocking and all-parameter ids for every result with parameters: batched
   *  when the source can, else one result at a time (the old way). The
   *  all-parameter lookup is made only for results with nothing blocking. */
  private async parameterLookups(
    source: CertifySource,
    results: CertifyCandidate[],
  ): Promise<{ blocking: Map<string, string[]>; params: Map<string, string[]> }> {
    const withParams = results.filter((r) => r.hasParameter).map((r) => r.labResultId);
    const blocking = await this.lookup(withParams, source.blockingParametersFor?.bind(source), (id) => source.blockingParameters(id));
    const finished = withParams.filter((id) => !(blocking.get(id) ?? []).length);
    const params = await this.lookup(finished, source.allParametersFor?.bind(source), (id) => source.allParameters(id));
    return { blocking, params };
  }

  private async lookup(
    ids: string[],
    batch: ((ids: string[]) => Promise<Map<string, string[]>>) | undefined,
    one: (id: string) => Promise<string[]>,
  ): Promise<Map<string, string[]>> {
    if (!ids.length) return new Map();
    if (batch) return batch(ids);
    const out = new Map<string, string[]>();
    for (const id of ids) out.set(id, await one(id));
    return out;
  }

  /** Run fn over items, at most concurrency() at a time, in order of start. */
  private async eachConcurrently<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length) await fn(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency(), items.length) }, worker));
  }

  /** Certify one row unless the portal confirmed it within skipRecertifyHours. */
  private async certifyOnce(
    run: AutoCertifyRun,
    kind: CertifyKind,
    r: CertifyCandidate,
    parameterId: string | null,
    manual: boolean,
  ): Promise<void> {
    const key = `${kind}:${parameterId ?? r.labResultId}`;
    const at = this.confirmed.get(key);
    if (at !== undefined && this.skipHours() > 0) {
      run.skipped++;
      if (!this.skipWarned.has(key)) {
        this.skipWarned.add(key);
        this.logger.warn(
          { kind, labResultId: r.labResultId, parameterId, sampleId: r.sampleId, confirmedAt: new Date(at).toISOString(), hours: this.skipHours() },
          'auto certify: the portal already confirmed this, yet the database still lists it as ready — not called again within the skip window',
        );
      }
      return;
    }
    const attempt = await this.certify(kind, r, parameterId, manual);
    this.tally(run, attempt);
    if (attempt.ok) this.confirmed.set(key, Date.now());
  }

  /** Drop confirmations older than the skip window, so the map stays small. */
  private forgetOldConfirmations(): void {
    const cutoff = Date.now() - this.skipHours() * 3_600_000;
    for (const [key, at] of this.confirmed) {
      if (at < cutoff) {
        this.confirmed.delete(key);
        this.skipWarned.delete(key);
      }
    }
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
      ok = portalVerdict(res.status, res.body);
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
