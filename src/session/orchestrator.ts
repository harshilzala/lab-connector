import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { HmisClient } from '../hmis/client.js';
import type { HmisResultUpload, MirthAcknowledgeItem, OrderDownload, ParsedMessage, PendingOrders } from '../types.js';
import type { ProtocolLink, WireEvent } from '../codec/types.js';
import { createTransport } from '../transport/index.js';
import type { Transport } from '../transport/types.js';
import { createProtocolLink } from '../codec/index.js';
import { SpoolQueue } from '../queue/spool.js';
import { ResultStore, type StagedSummary } from '../results/store.js';
import { StagedFiler } from '../results/filer.js';
import { isQcSample, isVoidResult, normalizeBarcode, toLisResultRows, toResultUploads } from '../mapping/mapper.js';
import {
  formatApiDate,
  formatApiDateDaysAgo,
  groupPendingByBarcode,
  mergePending,
  normalizePending,
} from '../hmis/pending.js';
import { assayKey } from '../codec/astm/records.js';
import { OrderStore, ORDER_RETENTION_DAYS } from '../orders/store.js';
import { ParameterCatalogue } from '../orders/parameters.js';
import { WireAudit } from './wire-audit.js';

/** How often the order store drops entries past ORDER_RETENTION_DAYS. */
const ORDER_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** First poll waits for the link to settle before pushing orders down it. */
const FIRST_POLL_DELAY_MS = 5000;

// ---- Order-download circuit breaker ----------------------------------------
// An analyzer that is powered off, or out of host-communication mode, still
// presents a healthy TCP socket when it sits behind a Moxa serial-device
// server: the Moxa accepts the connection whether or not anything is alive on
// the serial side. Every download then burns its full retry budget before
// failing — for the VITROS 250 that is 5 Kermit retries x 10s ACK timeout,
// ~50s per order. That floods the log and, because a tick cannot overlap
// itself, starves the 30s order poll so HMIS stops being read for that
// analyzer at all.
//
// After DOWNLOAD_FAIL_THRESHOLD consecutive failures the PUSH is suspended for
// a doubling interval. Polling itself never stops: orders keep flowing into the
// order store, so nothing is missed and a result arriving later is still
// joinable to its labResultId. The breaker resets on the first success and on
// reconnect, so a machine coming back is picked up immediately.
const DOWNLOAD_FAIL_THRESHOLD = 3;
const DOWNLOAD_BACKOFF_BASE_MS = 2 * 60_000; // first pause, after the threshold
const DOWNLOAD_BACKOFF_MAX_MS = 30 * 60_000; // ceiling on the doubling

export interface WireLogEntry {
  at: string;
  direction: 'IN' | 'OUT';
  text: string;
}

export interface AnalyzerStatus {
  id: string;
  equipmentCode: string;
  protocol: string;
  endpoint: string;
  connected: boolean;
  lastMessageAt: string | null;
  spool: { pending: number; failed: number };
  /** See config `filing.mode`. */
  filing: 'queue' | 'staged';
  /** Staged analyzers only: samples still waiting / fully filed. */
  staged: { waiting: number; complete: number } | null;
  orders: OrderPollStatus;
}

export interface OrderPollStatus {
  /** Barcodes held in the order store. */
  stored: number;
  pollEnabled: boolean;
  lastPollAt: string | null;
  /** Last poll's failure, or null once a poll succeeds again. */
  lastPollError: string | null;
  /** Samples handed to the analyzer by the poller since start. */
  downloaded: number;
  /** Set while the download circuit breaker is open — the analyzer holds a
   *  socket but is not answering, so pushes are suspended until this time.
   *  Order COLLECTION continues throughout; only the push pauses. */
  downloadPausedUntil: string | null;
  /** Consecutive failed downloads. 0 once one succeeds. */
  downloadFailStreak: number;
  /** How many HMIS services, and parameters within them, this analyzer has
   *  learned the shape of. Only used to rebuild a withdrawn order row, and only
   *  when `fillMissingOrderRows` is on, but always collected — so the console
   *  shows whether the catalogue is warm before the flag is turned on. */
  parameterCatalogue: { services: number; parameters: number; enabled: boolean };
}

// =============================================================================
// AnalyzerRuntime — everything for ONE analyzer: the byte transport, the
// protocol link, order download (host-query and proactive), and durable result
// upload.
//
//   order poll      → GET  {pendingPath} per code+day → order store
//                                                     → sendOrders() what is new
//   inbound query   → GET  {pendingPath} → order store → sendOrders() back
//   inbound results → spool.enqueue      → order store (or live lookup)
//                                        → worker POSTs {resultsPath}
//                                        → POST {acknowledgePath}
//                                          (durable store-and-forward)
//
// The acknowledge is the LAST step, not part of the download. A pending row is
// retired when its RESULT is filed, not when the order is handed to the
// analyzer — so an order that is downloaded and then never resulted stays
// pending and is offered again, rather than being silently retired with no
// value against it.
// =============================================================================
export class AnalyzerRuntime {
  private readonly link: ProtocolLink;
  private readonly transport: Transport;
  private readonly spool: SpoolQueue<HmisResultUpload>;
  private readonly log: Logger;
  private readonly wireLog: WireLogEntry[] = [];
  /** Durable copy of the same frames. The ring buffer above is 200 entries
   *  and is lost on restart, so it cannot answer "the machine says it sent
   *  that sample" — this file can. */
  private readonly wireAudit: WireAudit | null;
  private lastMessageAt: string | null = null;
  /** Every order row this analyzer has been offered, keyed by barcode, so a
   *  result can be joined to its labResultId long after the row was
   *  acknowledged — see src/orders/store.ts. */
  private readonly orders: OrderStore;
  /** What each HMIS service's parameter list looks like — see
   *  src/orders/parameters.ts. Always LEARNED, so switching
   *  `fillMissingOrderRows` on takes effect immediately instead of after a
   *  warm-up; only READ when that flag is set. */
  private readonly parameters: ParameterCatalogue;
  /** filing.mode "staged": the per-sample result store and its filing pass.
   *  Null on a "queue" analyzer, which delivers through the spool instead. */
  private readonly staged: ResultStore | null;
  private readonly filer: StagedFiler | null;
  private fileTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: string | null = null;
  private lastPollError: string | null = null;
  private downloadedCount = 0;
  /** Circuit breaker for order download — see `pauseDownloads`. */
  private downloadFailStreak = 0;
  private downloadPausedUntil = 0;

  constructor(
    private readonly cfg: AnalyzerConfig,
    private readonly hmis: HmisClient,
    spoolRoot: string,
    logger: Logger,
    /** Where to persist the wire log. Omitted (tests, ad-hoc runs) = memory only. */
    wireLogFile?: string,
    /** retention.days — how long a staged value waits for its order before it
     *  is discarded. */
    private readonly retentionDays = 7,
  ) {
    this.log = logger.child({ analyzer: cfg.id });
    this.transport = createTransport(cfg.transport, this.log);
    this.link = createProtocolLink(cfg, this.transport, this.log);
    this.spool = new SpoolQueue<HmisResultUpload>(join(spoolRoot, cfg.id), this.log);
    this.orders = new OrderStore(join(spoolRoot, cfg.id, 'orders'), this.log);
    this.parameters = new ParameterCatalogue(ParameterCatalogue.fileFor(join(spoolRoot, cfg.id)), this.log);
    this.wireAudit = wireLogFile ? new WireAudit(wireLogFile, this.log) : null;

    if (cfg.filing.mode === 'staged') {
      this.staged = new ResultStore(join(spoolRoot, cfg.id, 'results'), this.log);
      this.filer = new StagedFiler({
        store: this.staged,
        orderRows: (barcode, opts) => this.resolveOrderRows(barcode, opts),
        join: (upload, rows) => this.joinRows(upload, rows),
        postResults: (rows) => this.hmis.postResults(rows, this.cfg.equipmentCode),
        acknowledge: (rows) => this.hmis.acknowledge(rows),
        log: this.log,
        recheckMs: cfg.filing.recheckMs,
      });
    } else {
      this.staged = null;
      this.filer = null;
    }

    // A reconnect is the cheapest evidence the instrument may be back, so give
    // it an immediate attempt rather than waiting out the backoff.
    this.transport.on('connect', () => this.resumeDownloads('the analyzer link reconnected'));

    this.link.on('message', (m: ParsedMessage) => void this.onMessage(m));
    this.link.on('wire', (w: WireEvent) => this.recordWire(w));
    this.link.on('error', (e: Error) => this.log.error({ err: e.message }, 'protocol link error'));
  }

  async start(): Promise<void> {
    // A staged analyzer files from its result store (see startStaged); a
    // queued one delivers spooled items in order — a throw here keeps the
    // item queued.
    if (this.staged && this.filer) {
      this.startStaged(this.staged, this.filer);
    } else this.spool.start(async (payload) => {
      // The results endpoint files against labResultId, which only the order
      // row carries — so join the analyzer's values back to the pending rows
      // for this barcode before sending. Done HERE, at delivery time, so a
      // lookup failure is retried by the spool rather than losing the result.
      const join = (orderRows: MirthAcknowledgeItem[]) => this.joinRows(payload, orderRows);

      let orderRows = await this.resolveOrderRows(payload.barcode);
      let { rows, unmatched, matched, voided, ignored, scaled } = join(orderRows);
      if (unmatched.length) {
        // The store may simply be behind: a test added to the order after the
        // rows were cached. Ask HMIS once more before giving up on the codes.
        orderRows = await this.resolveOrderRows(payload.barcode, { refresh: true });
        ({ rows, unmatched, matched, voided, ignored, scaled } = join(orderRows));
      }

      // Not a warning: these are configured as non-results, or fall outside the
      // analyzer's allowTestCodes list, so their absence from HMIS is expected
      // rather than something the lab should chase.
      if (ignored.length) {
        this.log.debug({ barcode: payload.barcode, ignored }, 'codes not interfaced to HMIS dropped — not filed, not retried');
      }

      // Logged at info, not debug: a unit conversion changes the number that
      // reaches the patient report, so the lab must be able to see it happened
      // and check it against the analyzer printout.
      if (scaled.length) {
        this.log.info({ barcode: payload.barcode, scaled }, "unit conversion applied before filing");
      }

      if (voided.length) {
        this.log.warn({ barcode: payload.barcode, voided }, 'analyzer reported no value for these assays — not filed; the rerun will file');
      }

      // Nothing filable and nothing outstanding — every value in this item was
      // a placeholder or a configured non-result. Returning clears it from the
      // spool; throwing would retry a message that can never produce a row.
      if (rows.length === 0 && unmatched.length === 0) return;

      if (unmatched.length) {
        this.log.warn(
          { barcode: payload.barcode, unmatched, known: orderRows.map((r) => r.identifier) },
          'no pending order row for these assay codes — they cannot be filed',
        );
      }
      if (rows.length === 0) {
        // Throwing keeps the item spooled: the order may simply not be raised
        // in HMIS yet. It parks in failed/ once attempts run out.
        throw new Error(`no order rows matched barcode ${payload.barcode} — nothing to file`);
      }

      // eqCode rides along so the audit entry names the interface that filed
      // the value — without it a result line in hmis.log cannot be attributed
      // to a machine, only inferred from the identifier's spelling.
      const res = await this.hmis.postResults(rows, this.cfg.equipmentCode);
      this.log.info(
        { barcode: payload.barcode, filed: res.filed, sent: rows.length, message: res.message },
        'results filed to HMIS',
      );

      // Acknowledge LAST — only rows whose result the server has actually
      // filed are marked transmitted. A row stays pending until its value is
      // in, so an order that is downloaded but never resulted (analyzer error,
      // sample recollected, connector restarted mid-run) is still offered on
      // the next host query instead of being silently retired.
      //
      // Deliberately NOT fatal: the results are already saved, so throwing
      // would requeue the item and re-POST them. The cost of a failure here is
      // that the rows stay pending and may be downloaded again — the same cost
      // the acknowledge has always had, and much cheaper than a double file.
      try {
        await this.hmis.acknowledge(matched);
        this.log.info({ barcode: payload.barcode, rows: matched.length }, 'pending rows acknowledged after filing');
      } catch (err) {
        this.log.error(
          { barcode: payload.barcode, rows: matched.length, err: err instanceof Error ? err.message : String(err) },
          'acknowledge failed AFTER results were filed — rows stay pending and may be downloaded again',
        );
      }

      // A partial file must not drop the rest. The assays with no order row
      // yet (the order was raised for some tests before others, or under a
      // code that was only registered later) go back into the queue as their
      // own item, so they keep being retried until their rows appear — and
      // park visibly in failed/ if they never do. Seen live: three thyroid
      // values were lost when only the PSA on the same tube had a row.
      if (unmatched.length) {
        const keep = new Set(unmatched);
        const remainder: HmisResultUpload = {
          ...payload,
          results: payload.results.filter((r) => keep.has(r.testCode)),
          messageId: `${payload.messageId}-r${unmatched.length}`,
          // Carry the running total, so the console can show this item as the
          // leftovers of a sample that is already interfaced rather than as an
          // upload that never reached HMIS. Accumulated, because a remainder
          // that later files some of its codes splits again.
          filedAnalytes: (payload.filedAnalytes ?? 0) + rows.length,
        };
        this.spool.enqueue(remainder, remainder.messageId);
        this.log.warn(
          { barcode: payload.barcode, requeued: unmatched, id: remainder.messageId },
          'results without an order row re-queued on their own — they will file once the order exists',
        );
      }
    });
    await this.link.start();

    const sweep = () => {
      this.orders.sweep(ORDER_RETENTION_DAYS);
      if (this.staged) {
        const r = this.staged.sweep(this.retentionDays, this.cfg.filing.keepFiledDays);
        if (r.discarded || r.cleared) {
          this.log.info(
            { ...r, unfiledDays: this.retentionDays, filedDays: this.cfg.filing.keepFiledDays },
            'staged result store swept',
          );
        }
      }
    };
    sweep();
    this.sweepTimer = setInterval(sweep, ORDER_SWEEP_INTERVAL_MS);

    if (this.cfg.orderPoll.enabled) {
      const { intervalMs, lookbackDays, download } = this.cfg.orderPoll;
      this.pollTimer = setTimeout(() => {
        void this.pollOrders();
        this.pollTimer = setInterval(() => void this.pollOrders(), intervalMs);
      }, FIRST_POLL_DELAY_MS);
      this.log.info(
        { codes: this.equipmentCodes(), siteId: this.cfg.siteId ?? null, intervalMs, lookbackDays, download },
        'order polling enabled',
      );
    }

    this.log.info({ endpoint: this.cfg.transport.type }, 'analyzer runtime started');
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.fileTimer) clearInterval(this.fileTimer);
    this.fileTimer = null;
    this.spool.stop();
    await this.link.stop();
  }

  status(): AnalyzerStatus {
    const stagedCounts = this.staged?.counts() ?? null;
    return {
      id: this.cfg.id,
      equipmentCode: this.cfg.equipmentCode,
      protocol: this.cfg.protocol,
      endpoint: describeTransport(this.cfg),
      connected: this.transport.connected,
      lastMessageAt: this.lastMessageAt,
      // On a staged analyzer "pending" is the samples still waiting for an
      // order row, so the console tiles keep meaning "not yet in HMIS".
      spool: stagedCounts ? { pending: stagedCounts.waiting, failed: this.spool.counts().failed } : this.spool.counts(),
      filing: this.cfg.filing.mode,
      staged: stagedCounts,
      orders: {
        stored: this.orders.count(),
        pollEnabled: this.cfg.orderPoll.enabled,
        lastPollAt: this.lastPollAt,
        lastPollError: this.lastPollError,
        downloaded: this.downloadedCount,
        downloadPausedUntil: this.downloadPausedUntil ? new Date(this.downloadPausedUntil).toISOString() : null,
        downloadFailStreak: this.downloadFailStreak,
        parameterCatalogue: { ...this.parameters.counts(), enabled: this.cfg.fillMissingOrderRows },
      },
    };
  }

  /** Every HMIS equipment code this machine's orders may be registered under. */
  private equipmentCodes(): string[] {
    return [this.cfg.equipmentCode, ...this.cfg.extraEquipmentCodes];
  }

  // ---------------------------------------------------------------------------
  // Proactive order download. One tick: ask HMIS for each code × each day in
  // the look-back window, fold every row into the order store, and push to the
  // analyzer only the tests it has not been given. Nothing is acknowledged —
  // that still happens after the result is filed — so the same rows come back
  // on the next tick and the store is what makes the download idempotent.
  // ---------------------------------------------------------------------------
  private async pollOrders(): Promise<void> {
    if (this.polling) return; // a slow gateway must not stack ticks
    this.polling = true;
    const { lookbackDays, download, downloadPrefixes } = this.cfg.orderPoll;
    let samples = 0;
    let pushed = 0;
    let held = 0; // ready to send, but the download breaker is open
    let notOurs = 0; // cached but outside downloadPrefixes — never sent
    const downloadable = (barcode: string): boolean =>
      downloadPrefixes.length === 0 ||
      downloadPrefixes.some((p) => barcode.toUpperCase().startsWith(p.toUpperCase()));
    try {
      for (const eqCode of this.equipmentCodes()) {
        for (let daysAgo = 0; daysAgo <= lookbackDays; daysAgo++) {
          const body = await this.hmis.getPending({
            sampleId: '',
            eqCode,
            siteId: this.cfg.siteId,
            showCulture: this.cfg.showCulture,
            date: formatApiDateDaysAgo(daysAgo),
          });
          const groups = groupPendingByBarcode(body, {
            eqCode,
            equipmentId: this.cfg.equipmentId ?? null,
            ipAddress: this.ackIpAddress,
            portNo: this.ackPortNo,
          });
          for (const [, pending] of groups) {
            samples++;
            // The poll is where a complete panel is most likely to be seen, so
            // it is the catalogue's main source.
            this.parameters.learn(pending.ackItems);
            const { order, newCodes } = this.orders.upsert(pending.sampleId, pending, 'poll');
            if (!download || newCodes.length === 0) continue;
            if (!downloadable(order.sampleId)) {
              // The gateway lists this barcode under our eqCode, but the
              // analyzer does not run it (see orderPoll.downloadPrefixes). The
              // rows stay cached for result-time joins; nothing is programmed.
              notOurs++;
              continue;
            }
            if (!this.transport.connected) {
              // Leave it un-downloaded; the next tick after reconnect sends it.
              this.log.warn({ barcode: order.sampleId, tests: newCodes }, 'order waiting — analyzer link is down');
              continue;
            }
            if (this.downloadsPaused()) {
              // The instrument is not answering. Keep the order in the store,
              // un-downloaded, so it goes out as soon as the breaker closes.
              held++;
              continue;
            }
            try {
              await this.link.sendOrders([
                {
                  sampleId: order.sampleId,
                  testCodes: newCodes,
                  priority: order.priority,
                  patient: this.cfg.sendDemographics ? order.patient : null,
                  specimenType: order.specimenType,
                },
              ]);
              this.orders.markDownloaded(order.sampleId, newCodes);
              this.downloadedCount++;
              pushed++;
              this.resumeDownloads('an order was accepted');
              this.log.info({ barcode: order.sampleId, tests: newCodes, eqCode }, 'order downloaded to analyzer');
            } catch (err) {
              // Not marked downloaded, so it is retried once the breaker closes.
              this.downloadFailStreak++;
              this.log.error(
                {
                  barcode: order.sampleId,
                  tests: newCodes,
                  consecutiveFailures: this.downloadFailStreak,
                  err: err instanceof Error ? err.message : String(err),
                },
                'order download failed — will retry on the next poll',
              );
              if (this.downloadFailStreak >= DOWNLOAD_FAIL_THRESHOLD) {
                this.pauseDownloads();
                break; // stop hammering the rest of this tick's orders
              }
            }
          }
        }
      }
      this.lastPollAt = new Date().toISOString();
      if (this.lastPollError) this.log.info('order polling recovered');
      this.lastPollError = null;
      // New rows may have arrived for a staged sample that was waiting.
      if (this.filer) void this.filer.run('poll');
      if (samples || pushed || held || notOurs) {
        this.log.debug({ samples, pushed, held, notOurs }, 'order poll complete');
      }
    } catch (err) {
      this.lastPollError = err instanceof Error ? err.message : String(err);
      this.log.error({ err: this.lastPollError }, 'order poll failed — new orders are not reaching this analyzer');
    } finally {
      this.polling = false;
    }
  }

  // ---- order-download circuit breaker ---------------------------------------

  /** True while downloads are suspended. Logs once, as it closes. */
  private downloadsPaused(): boolean {
    if (this.downloadPausedUntil === 0) return false;
    if (Date.now() < this.downloadPausedUntil) return true;
    this.log.info(
      { afterFailures: this.downloadFailStreak },
      'order download backoff elapsed — trying the analyzer again',
    );
    this.downloadPausedUntil = 0;
    return false;
  }

  /**
   * Suspend downloads for a doubling interval. The streak is NOT reset here:
   * one more failure after the pause elapses doubles the next wait, so a
   * machine that stays off settles at one attempt every 30 minutes instead of
   * one every 30 seconds.
   */
  private pauseDownloads(): void {
    const steps = this.downloadFailStreak - DOWNLOAD_FAIL_THRESHOLD;
    const wait = Math.min(DOWNLOAD_BACKOFF_BASE_MS * 2 ** Math.max(0, steps), DOWNLOAD_BACKOFF_MAX_MS);
    this.downloadPausedUntil = Date.now() + wait;
    this.log.warn(
      { consecutiveFailures: this.downloadFailStreak, pausedForMs: wait, resumesAt: new Date(this.downloadPausedUntil).toISOString() },
      'order download suspended — the analyzer is connected but not answering. ' +
        'Orders keep being collected and will be sent when it responds again.',
    );
  }

  /** Close the breaker: the analyzer is talking to us again. */
  private resumeDownloads(why: string): void {
    if (this.downloadFailStreak === 0 && this.downloadPausedUntil === 0) return;
    this.log.info({ why, afterFailures: this.downloadFailStreak }, 'order download resumed');
    this.downloadFailStreak = 0;
    this.downloadPausedUntil = 0;
  }

  recentWire(limit = 50): WireLogEntry[] {
    return this.wireLog.slice(-limit);
  }

  /** Empties the in-memory wire log so the operator can watch one exchange in
   *  isolation. The rolling file log keeps the full record either way. */
  clearWire(): void {
    this.wireLog.length = 0;
  }

  spoolPending(limit = 100) {
    return this.spool.listPending(limit);
  }

  spoolFailed(limit = 100) {
    return this.spool.listFailed(limit);
  }

  retryFailed(id: string): boolean {
    return this.spool.requeueFailed(id);
  }

  /** Drops a queued or parked sample — it will never be sent to the HMIS. */
  discardSpooled(id: string): boolean {
    const dropped = this.spool.discard(id);
    if (dropped) this.log.warn({ id }, 'spool item removed from the queue by an operator');
    return dropped;
  }

  // ---- staged result store (filing.mode "staged") ---------------------------

  /** Null on a queued analyzer. */
  stagedSummaries(): StagedSummary[] | null {
    return this.staged?.summaries() ?? null;
  }

  /** Operator "file now": one immediate pass for this barcode, with a live
   *  HMIS lookup regardless of the recheck cadence. */
  async stagedFileNow(barcode: string): Promise<boolean> {
    if (!this.staged || !this.filer) return false;
    const s = this.staged.get(barcode);
    if (!s) return false;
    await this.filer.run('operator', s.barcode);
    return true;
  }

  /** Move a mistyped sample to its real barcode and file it. Returns the
   *  barcode it now sits under, or null when `from` is unknown. */
  stagedRekey(from: string, to: string): string | null {
    if (!this.staged || !this.filer) return null;
    const moved = this.staged.rekey(from, to);
    if (!moved) return null;
    void this.filer.run('rekey', moved.barcode);
    return moved.barcode;
  }

  /** Drops a staged sample — its unfiled values will never reach HMIS. */
  stagedRemove(barcode: string): boolean {
    const ok = this.staged?.remove(normalizeBarcode(barcode)) ?? false;
    if (ok) this.log.warn({ barcode: normalizeBarcode(barcode) }, 'staged sample removed by an operator');
    return ok;
  }

  /**
   * Bring up staged filing. Whatever the upload queue still holds from before
   * the switch is folded into the store — every value it carried, under its
   * original receipt time — so nothing already received is lost and the
   * queue is left empty. Then the filing pass runs on its timer; it also runs
   * after every order poll and on every inbound result.
   */
  private startStaged(store: ResultStore, filer: StagedFiler): void {
    let imported = 0;
    for (const env of [...this.spool.listPending(10_000), ...this.spool.listFailed(10_000)]) {
      const { changed } = store.upsert(env.payload, env.createdAt);
      this.spool.discard(env.id);
      imported++;
      this.log.info(
        { id: env.id, barcode: env.payload.barcode, values: changed.length, attempts: env.attempts },
        'queued item moved into the staged result store',
      );
    }
    if (imported) this.log.warn({ imported, ...store.counts() }, 'upload queue migrated into the staged result store');

    this.fileTimer = setInterval(() => void filer.run('timer'), this.cfg.filing.passIntervalMs);
    setTimeout(() => void filer.run('startup'), FIRST_POLL_DELAY_MS);
    this.log.info(
      { ...store.counts(), passIntervalMs: this.cfg.filing.passIntervalMs, recheckMs: this.cfg.filing.recheckMs },
      'staged result filing enabled — results wait for their order instead of queueing',
    );
  }

  /** The analyzer's result-to-order join: aliases, ignore list, allow-list,
   *  unit scaling, and the dialect's canonical assay key — HMIS spells a
   *  VITROS identifier as the full "1.000000+032+1" where the codec reports
   *  "032", so the two meet on the canonical form. */
  private joinRows(payload: HmisResultUpload, orderRows: MirthAcknowledgeItem[]) {
    const canonical = this.cfg.protocol === 'astm' ? assayKey(this.cfg.astm.dialect) : undefined;
    const join = (rows: MirthAcknowledgeItem[]) =>
      toLisResultRows(
        payload,
        rows,
        canonical,
        this.cfg.testCodeAliases,
        this.cfg.ignoreTestCodes,
        this.cfg.testCodeScale,
        this.cfg.allowTestCodes,
      );

    const joined = join(orderRows);
    if (!this.cfg.fillMissingOrderRows || joined.unmatched.length === 0) return joined;

    // Every value here is one HMIS is not currently offering a row for. If the
    // catalogue has seen the parameter on this service before, the row can be
    // rebuilt from it plus this sample's own labResultId — see
    // src/orders/parameters.ts for why that is exact rather than a guess.
    //
    // Both spellings are offered: the analyzer's own code, and the alias the
    // config maps it to, because either may be how HMIS names the parameter.
    const candidates: string[] = [];
    for (const code of joined.unmatched) {
      candidates.push(code);
      const alias = this.aliasFor(code);
      if (alias) candidates.push(alias);
    }

    const { rows: rebuilt, unknown } = this.parameters.synthesize(orderRows, candidates, canonical);
    if (rebuilt.length === 0) return joined;

    const filled = join([...orderRows, ...rebuilt]);
    this.log.warn(
      {
        barcode: payload.barcode,
        rebuilt: rebuilt.map((r) => r.identifier),
        labResultIds: [...new Set(rebuilt.map((r) => r.labResultId))],
        stillUnknown: filled.unmatched,
        fixInHmis: unknown.length > 0 ? unknown : undefined,
      },
      'HMIS is not offering an order row for these parameters — rebuilt from the parameter catalogue so the values file instead of leaving the report blank',
    );
    return filled;
  }

  /** The configured alias for an analyzer assay code, matched the way the
   *  mapper matches it: case-insensitively, exact spelling. */
  private aliasFor(code: string): string | null {
    const k = (code ?? '').trim().toUpperCase();
    if (!k) return null;
    for (const [from, to] of Object.entries(this.cfg.testCodeAliases)) {
      if ((from ?? '').trim().toUpperCase() === k) return to;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  private async onMessage(msg: ParsedMessage): Promise<void> {
    this.lastMessageAt = new Date().toISOString();
    // The instrument just spoke to us, so it is plainly alive — the strongest
    // signal there is that a suspended download should be tried again.
    this.resumeDownloads('the analyzer sent us a message');

    // 1) Host-query → answer with the ordered tests.
    if (msg.queries.length > 0) {
      if (!this.cfg.hostQuery) {
        this.log.warn('received host query but hostQuery is disabled — ignoring');
      } else {
        for (const q of msg.queries) await this.answerQuery(q.sampleId);
      }
    }

    // 2) Results → durable upload.
    if (msg.results.length > 0) {
      const voids = msg.results.filter((r) => isVoidResult(r.value));
      if (voids.length) {
        this.log.warn(
          { samples: [...new Set(voids.map((r) => r.sampleId))], codes: voids.map((r) => r.testCode) },
          'analyzer reported no value for these assays — not filed; the rerun will file',
        );
      }
      const uploads = toResultUploads(this.cfg, msg);
      for (const u of uploads) {
        // A control run has no order row in HMIS. Filing it would query pending
        // for a barcode the gateway has never heard of, find nothing, and retry
        // the upload for as long as the spool allows — which is exactly what
        // sample 89772 did. The legacy app dropped these at the same point.
        if (u.isQc && !this.cfg.qc.upload) {
          this.log.info({ barcode: u.barcode, count: u.results.length }, 'QC/control run — not sent to HMIS');
          continue;
        }
        if (this.staged && this.filer) {
          // Stored first, filed after — the old middleware's order of events.
          const { changed, unchanged } = this.staged.upsert(u);
          this.log.info(
            { barcode: u.barcode, values: u.results.length, changed: changed.length, unchanged: unchanged.length },
            changed.length ? 'results staged for filing' : 'results re-sent by the analyzer — already held, nothing new',
          );
          void this.filer.run('message', u.barcode);
          continue;
        }
        this.spool.enqueue(u, u.messageId); // messageId is deterministic → idempotent
        this.log.info({ barcode: u.barcode, count: u.results.length, qc: u.isQc }, 'results queued for upload');
      }
    }
  }

  private async answerQuery(barcode: string): Promise<void> {
    // HMIS matches barcodes case-sensitively; look up with the canonical
    // uppercase form so a lowercase-entered sample still resolves its order.
    const lookup = normalizeBarcode(barcode);

    // A control barcode has no order in HMIS. Asking anyway just adds a round
    // trip per retry (89772 produced 100 identical pending queries), so answer
    // the instrument locally with no order instead.
    if (isQcSample(lookup, this.cfg.qc)) {
      this.log.info({ barcode: lookup }, 'QC/control barcode — not queried against HMIS');
      return;
    }
    try {
      // One row per pending test — collapse the rows for this barcode into a
      // single order, keeping each row so it can be acknowledged afterwards.
      const pending = await this.fetchPending(lookup);

      // Remember the rows: the result comes back in a LATER message and needs
      // their labResultId to be filable.
      if (pending.ackItems.length) this.orders.upsert(lookup, pending, 'query');

      if (!pending.found) {
        this.log.info({ barcode, lookup }, 'no pending orders — sending empty download');
        await this.link.sendOrders([]); // header + terminator = "no work"
        return;
      }

      const order: OrderDownload = {
        // Reply with the barcode the analyzer sent so it matches its own sample.
        sampleId: barcode,
        testCodes: pending.testCodes,
        priority: pending.priority,
        patient: this.cfg.sendDemographics ? pending.patient : null,
        specimenType: pending.specimenType,
      };
      await this.link.sendOrders([order]);
      // A query answer is a full download, so the poller need not repeat it.
      this.orders.markDownloaded(lookup, pending.testCodes);
      this.log.info({ barcode, tests: pending.testCodes }, 'order download sent to analyzer');

      // NOT acknowledged here. A downloaded order is not finished work — the
      // row is retired only once its result has been filed, in the spool
      // handler. Until then it stays pending, so re-querying the same barcode
      // simply downloads it again, which is harmless and self-healing.
    } catch (err) {
      this.log.error({ barcode, err: err instanceof Error ? err.message : String(err) }, 'host-query failed');
    }
  }

  /** Load and normalise the pending rows for one barcode, under every code
   *  this machine is registered as, merged into one order. */
  private async fetchPending(lookup: string, includeTransmitted = false): Promise<PendingOrders> {
    const parts: PendingOrders[] = [];
    for (const eqCode of this.equipmentCodes()) {
      const body = await this.hmis.getPending({
        sampleId: lookup,
        eqCode,
        siteId: this.cfg.siteId,
        showCulture: this.cfg.showCulture,
        // Off by default: an order raised yesterday for a tube run today would
        // otherwise not be found.
        date: this.cfg.sendDate ? formatApiDate(new Date()) : undefined,
      });
      parts.push(
        normalizePending(body, {
          sampleId: lookup,
          eqCode,
          equipmentId: this.cfg.equipmentId ?? null,
          ipAddress: this.ackIpAddress,
          portNo: this.ackPortNo,
          includeTransmitted,
        }),
      );
    }
    const merged = mergePending(parts);
    this.parameters.learn(merged.ackItems);
    return merged;
  }

  /**
   * Order rows for a barcode, for joining an incoming result to its
   * labResultId. The order store answers first — it holds every row this
   * analyzer was ever offered, including rows HMIS has since acknowledged and
   * will not return again. A live lookup is the fallback (a tube the poller
   * never saw), and `refresh` forces one even when the store has rows, for a
   * result whose test was added after the rows were cached.
   */
  private async resolveOrderRows(barcode: string, opts: { refresh?: boolean } = {}): Promise<MirthAcknowledgeItem[]> {
    const lookup = normalizeBarcode(barcode);
    const stored = this.orders.get(lookup);
    if (stored?.rows.length && !opts.refresh) return stored.rows;

    // includeTransmitted: a re-sent or corrected result must still find its
    // rows after a previous upload already acknowledged them.
    const pending = await this.fetchPending(lookup, true);
    if (pending.ackItems.length) {
      return this.orders.upsert(lookup, pending, 'result').order.rows;
    }
    return stored?.rows ?? [];
  }

  /** Reported in the acknowledge body; derived from a TCP transport when the
   *  analyzer config does not set it explicitly. */
  private get ackIpAddress(): string {
    if (this.cfg.ipAddress) return this.cfg.ipAddress;
    return this.cfg.transport.type === 'tcp' ? this.cfg.transport.host : '';
  }

  private get ackPortNo(): string {
    if (this.cfg.portNo) return this.cfg.portNo;
    return this.cfg.transport.type === 'tcp' ? String(this.cfg.transport.port) : '';
  }

  private recordWire(w: WireEvent): void {
    const entry: WireLogEntry = { at: new Date().toISOString(), direction: w.direction, text: w.text };
    this.wireLog.push(entry);
    if (this.wireLog.length > 200) this.wireLog.shift();
    this.wireAudit?.record(entry);
  }
}

function describeTransport(cfg: AnalyzerConfig): string {
  const t = cfg.transport;
  return t.type === 'tcp' ? `tcp://${t.host}:${t.port} (${t.mode})` : `serial://${t.path}@${t.baudRate}`;
}
