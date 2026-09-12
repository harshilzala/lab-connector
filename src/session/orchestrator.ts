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
import { isVoidResult, normalizeBarcode, toLisResultRows, toResultUploads } from '../mapping/mapper.js';
import {
  formatApiDate,
  formatApiDateDaysAgo,
  groupPendingByBarcode,
  mergePending,
  normalizePending,
} from '../hmis/pending.js';
import { assayKey } from '../codec/astm/records.js';
import { OrderStore, ORDER_RETENTION_DAYS } from '../orders/store.js';

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
  private lastMessageAt: string | null = null;
  /** Every order row this analyzer has been offered, keyed by barcode, so a
   *  result can be joined to its labResultId long after the row was
   *  acknowledged — see src/orders/store.ts. */
  private readonly orders: OrderStore;
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
  ) {
    this.log = logger.child({ analyzer: cfg.id });
    this.transport = createTransport(cfg.transport, this.log);
    this.link = createProtocolLink(cfg, this.transport, this.log);
    this.spool = new SpoolQueue<HmisResultUpload>(join(spoolRoot, cfg.id), this.log);
    this.orders = new OrderStore(join(spoolRoot, cfg.id, 'orders'), this.log);

    // A reconnect is the cheapest evidence the instrument may be back, so give
    // it an immediate attempt rather than waiting out the backoff.
    this.transport.on('connect', () => this.resumeDownloads('the analyzer link reconnected'));

    this.link.on('message', (m: ParsedMessage) => void this.onMessage(m));
    this.link.on('wire', (w: WireEvent) => this.recordWire(w));
    this.link.on('error', (e: Error) => this.log.error({ err: e.message }, 'protocol link error'));
  }

  async start(): Promise<void> {
    // Deliver spooled results to HMIS; a throw here keeps the item queued.
    this.spool.start(async (payload) => {
      // The results endpoint files against labResultId, which only the order
      // row carries — so join the analyzer's values back to the pending rows
      // for this barcode before sending. Done HERE, at delivery time, so a
      // lookup failure is retried by the spool rather than losing the result.
      //
      // HMIS spells the assay identifier the way the ANALYZER does, which for a
      // VITROS is the full "1.000000+032+1" rather than the "032" the codec
      // reports. Join on the dialect's canonical key so the two meet.
      const canonical = this.cfg.protocol === 'astm' ? assayKey(this.cfg.astm.dialect) : undefined;
      const join = (orderRows: MirthAcknowledgeItem[]) =>
        toLisResultRows(payload, orderRows, canonical, this.cfg.testCodeAliases);

      let orderRows = await this.resolveOrderRows(payload.barcode);
      let { rows, unmatched, matched, voided } = join(orderRows);
      if (unmatched.length) {
        // The store may simply be behind: a test added to the order after the
        // rows were cached. Ask HMIS once more before giving up on the codes.
        orderRows = await this.resolveOrderRows(payload.barcode, { refresh: true });
        ({ rows, unmatched, matched, voided } = join(orderRows));
      }

      if (voided.length) {
        this.log.warn({ barcode: payload.barcode, voided }, 'analyzer reported no value for these assays — not filed; the rerun will file');
        if (rows.length === 0 && unmatched.length === 0) return; // nothing real in this item
      }

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
        };
        this.spool.enqueue(remainder, remainder.messageId);
        this.log.warn(
          { barcode: payload.barcode, requeued: unmatched, id: remainder.messageId },
          'results without an order row re-queued on their own — they will file once the order exists',
        );
      }
    });
    await this.link.start();

    this.orders.sweep(ORDER_RETENTION_DAYS);
    this.sweepTimer = setInterval(() => this.orders.sweep(ORDER_RETENTION_DAYS), ORDER_SWEEP_INTERVAL_MS);

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
    this.spool.stop();
    await this.link.stop();
  }

  status(): AnalyzerStatus {
    return {
      id: this.cfg.id,
      equipmentCode: this.cfg.equipmentCode,
      protocol: this.cfg.protocol,
      endpoint: describeTransport(this.cfg),
      connected: this.transport.connected,
      lastMessageAt: this.lastMessageAt,
      spool: this.spool.counts(),
      orders: {
        stored: this.orders.count(),
        pollEnabled: this.cfg.orderPoll.enabled,
        lastPollAt: this.lastPollAt,
        lastPollError: this.lastPollError,
        downloaded: this.downloadedCount,
        downloadPausedUntil: this.downloadPausedUntil ? new Date(this.downloadPausedUntil).toISOString() : null,
        downloadFailStreak: this.downloadFailStreak,
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
    const { lookbackDays, download } = this.cfg.orderPoll;
    let samples = 0;
    let pushed = 0;
    let held = 0; // ready to send, but the download breaker is open
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
            const { order, newCodes } = this.orders.upsert(pending.sampleId, pending, 'poll');
            if (!download || newCodes.length === 0) continue;
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
      if (samples || pushed || held) this.log.debug({ samples, pushed, held }, 'order poll complete');
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
        this.spool.enqueue(u, u.messageId); // messageId is deterministic → idempotent
        this.log.info({ barcode: u.barcode, count: u.results.length, qc: u.isQc }, 'results queued for upload');
      }
    }
  }

  private async answerQuery(barcode: string): Promise<void> {
    // HMIS matches barcodes case-sensitively; look up with the canonical
    // uppercase form so a lowercase-entered sample still resolves its order.
    const lookup = normalizeBarcode(barcode);
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
    return mergePending(parts);
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
    this.wireLog.push({ at: new Date().toISOString(), direction: w.direction, text: w.text });
    if (this.wireLog.length > 200) this.wireLog.shift();
  }
}

function describeTransport(cfg: AnalyzerConfig): string {
  const t = cfg.transport;
  return t.type === 'tcp' ? `tcp://${t.host}:${t.port} (${t.mode})` : `serial://${t.path}@${t.baudRate}`;
}
