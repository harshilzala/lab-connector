import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { HmisGateway } from '../hmis/client.js';
import type { HmisResultUpload, HostQuery, MirthAcknowledgeItem, OrderDownload, ParsedMessage, PendingOrders } from '../types.js';
import type { ProtocolLink, WireEvent } from '../codec/types.js';
import { createTransport } from '../transport/index.js';
import type { Transport } from '../transport/types.js';
import { createProtocolLink } from '../codec/index.js';
import { SpoolQueue } from '../queue/spool.js';
import { ResultStore, type StagedSummary } from '../results/store.js';
import { StagedFiler } from '../results/filer.js';
import { compileCompletion } from '../results/complete.js';
import {
  interfacedCodeFilter,
  isQcSample,
  isVoidResult,
  keepInterfacedResults,
  normalizeBarcode,
  rerunBaseBarcode,
  strippedRerunBarcode,
  toLisResultRows,
  toResultUploads,
  willSyncIdentifier,
} from '../mapping/mapper.js';
import {
  formatApiDate,
  formatApiDateDaysAgo,
  groupPendingByBarcode,
  mergePending,
  normalizePending,
} from '../hmis/pending.js';
import { assayKey } from '../codec/astm/records.js';
import { encodeTestCode } from '../codec/kermit/vitros250.js';
import { OrderStore, ORDER_RETENTION_DAYS, codeKey } from '../orders/store.js';
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

// A VITROS that answers a download with E 0000 RECEIVER BUSY is alive and
// talking; Ortho's spec says to "attempt the session again after a minute or
// longer has elapsed". E 0002 RECEIVER DISABLED means an operator has turned
// RECEIVE TESTS off at the console, which no amount of retrying fixes. Neither
// is evidence of a dead link, so neither counts toward the breaker — the push
// simply waits.
const VITROS_BUSY_WAIT_MS = 60_000;
const VITROS_DISABLED_WAIT_MS = 5 * 60_000;

export interface WireLogEntry {
  at: string;
  direction: 'IN' | 'OUT';
  text: string;
  /** Packet-level exchange behind the frame, where the protocol has one. */
  trace?: string;
}

export interface AnalyzerStatus {
  id: string;
  equipmentCode: string;
  protocol: string;
  endpoint: string;
  connected: boolean;
  /** "connected"  — a socket to the instrument is open now;
   *  "listening"  — server mode, no socket right now, but the port is open and
   *                 the instrument dials in when it has something to send (the
   *                 GH900 does exactly that — normal, not a fault);
   *  "offline"    — client mode and the dial is failing, or the listener is
   *                 down. `linkError` says why when known. */
  link: 'connected' | 'listening' | 'offline';
  linkError: string | null;
  lastMessageAt: string | null;
  /** VITROS 250 only: when the analyzer last said it can accept downloads. */
  lastSolicitAt: string | null;
  spool: { pending: number; failed: number };
  /** See config `filing.mode`. */
  filing: 'queue' | 'staged';
  /** Staged analyzers only: samples still waiting / fully filed. */
  staged: { waiting: number; complete: number } | null;
  orders: OrderPollStatus;
  /** What this machine is scoped to send — the console's "parameters" line. */
  interface: InterfaceScope;
  /** The same scope checked against what HMIS has actually offered, which is
   *  what the console's parameter chips are coloured from. */
  filter: FilterScope;
}

export interface FilterScope {
  /** allowTestCodes as configured; empty means "no allow-list". */
  allow: string[];
  /** Instrument channels configured as non-results. */
  ignore: string[];
  /** HMIS identifiers this analyzer's pending rows have actually carried. An
   *  allowed code missing from here is a master-data gap, not a wiring fault —
   *  the console shows those amber rather than hiding them. */
  hmis: string[];
}

export interface InterfaceScope {
  /** allowTestCodes as configured; empty means "everything the instrument
   *  sends that is not ignored". */
  syncCodes: string[];
  /** Instrument code → HMIS identifier it is filed as, where they differ. */
  aliases: Record<string, string>;
  /** HMIS identifiers this machine never files into. */
  excluded: string[];
  /** Instrument channels configured as non-results. */
  ignored: string[];
}

/** What the console's "Force" push did for one sample. */
export interface ForceReport {
  barcode: string;
  /** Interfaced values the sample holds (filed + waiting). */
  values: number;
  /** How many of them resolved to an HMIS parameter and were sent. */
  sent: number;
  /** How many HMIS reported accepted. */
  accepted: number;
  /** The gateway's message, or why nothing was sent. */
  message: string;
  /** Analyzer codes that resolved to no parameter — not sent, not guessed. */
  unresolved: string[];
  rows: Array<{ testCode: string; identifier: string; parameterId: number | null; value: string }>;
}

/** One order (barcode) as the console shows it: every HMIS row, marked. */
export interface OrderView {
  barcode: string;
  sampleId: string;
  firstSeenAt: string;
  updatedAt: string;
  source: string;
  rows: Array<{
    identifier: string;
    parameterId: number | null;
    labResultId: number | null;
    /** Will this analyzer file into this row? */
    sync: boolean;
    /** Already sent to the instrument (download). */
    downloaded: boolean;
  }>;
  syncCount: number;
  noSyncCount: number;
}

/** What the console's "Re-send" did for one barcode. */
export interface ResendReport {
  barcode: string;
  /** Every assay identifier handed to the analyzer — the whole order, not
   *  just what the poller had not sent yet. */
  tests: string[];
  /** 'hmis' when the rows came from a live lookup made for this push; 'store'
   *  when HMIS offered nothing for the barcode now and the cached order went. */
  source: 'hmis' | 'store';
}

export interface OrderPollStatus {
  /** What the pending calls are keyed on — BOTH are sent, and a reply that
   *  is empty for this pair is taken as "no work here", never widened. */
  eqCodes: string[];
  siteId: string | null;
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
  /** Last NAK ZERO download solicitation from a VITROS 250; null on other links. */
  private lastSolicitAt: string | null = null;
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
    private readonly hmis: HmisGateway,
    spoolRoot: string,
    logger: Logger,
    /** Where to persist the wire log. Omitted (tests, ad-hoc runs) = memory only. */
    wireLogFile?: string,
    /** retention.days — how long a staged value waits for its order before it
     *  is discarded. */
    private readonly retentionDays = 7,
  ) {
    this.log = logger.child({ analyzer: cfg.id });
    this.interfacedIdentifiers = AnalyzerRuntime.interfacedIdentifiersFor(cfg);
    this.transport = createTransport(cfg.transport, this.log);
    this.link = createProtocolLink(cfg, this.transport, this.log);
    this.spool = new SpoolQueue<HmisResultUpload>(join(spoolRoot, cfg.id), this.log);
    this.orders = new OrderStore(join(spoolRoot, cfg.id, 'orders'), this.log);
    this.parameters = new ParameterCatalogue(ParameterCatalogue.fileFor(join(spoolRoot, cfg.id)), this.log);
    this.wireAudit = wireLogFile ? new WireAudit(wireLogFile, this.log) : null;
    // Start the console's Wire log from what is already on disk, so a restart
    // does not blank it while the analyzer's last exchanges are still relevant.
    if (this.wireAudit) this.wireLog.push(...this.wireAudit.recent(200));

    if (cfg.filing.mode === 'staged') {
      this.staged = new ResultStore(join(spoolRoot, cfg.id, 'results'), this.log);
      this.filer = new StagedFiler({
        store: this.staged,
        orderRows: (barcode, opts) => this.resolveOrderRows(barcode, opts),
        join: (upload, rows) => this.joinRows(upload, rows),
        postResults: (rows) => this.hmis.postResults(rows, this.cfg.equipmentCode),
        acknowledge: (rows) => this.hmis.acknowledge(rows, this.cfg.equipmentCode),
        log: this.log,
        recheckMs: cfg.filing.recheckMs,
        completeBarcode: cfg.barcodeCompletion ? compileCompletion(cfg.barcodeCompletion) : undefined,
        // Optional-chained: the schema always fills this in, but the test
        // harnesses build an analyzer config by hand and must not have to
        // know about a feature only one machine uses.
        pairing: cfg.filing.pairing?.devices.length ? cfg.filing.pairing : null,
      });
      if (cfg.barcodeCompletion) {
        this.log.info(
          { short: cfg.barcodeCompletion.short, full: cfg.barcodeCompletion.full },
          'barcode completion enabled — short instrument ids are tried under the full HMIS barcode',
        );
      }
      if (cfg.filing.pairing?.devices.length) {
        this.log.info(
          { devices: cfg.filing.pairing.devices, maxWaitMs: cfg.filing.pairing.maxWaitMs },
          cfg.filing.pairing.maxWaitMs === null
            ? 'paired instruments — a sample is not sent to HMIS until every one of them has reported on it (no time limit)'
            : 'paired instruments — a sample is not sent to HMIS until every one of them has reported on it',
        );
      }
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
    // VITROS 250 NAK ZERO: the analyzer says, once a minute while idle, that
    // it can accept sample programs. That is the strongest possible evidence
    // it is receptive, so anything the breaker is holding goes now.
    this.link.on('solicit', () => {
      this.lastSolicitAt = new Date().toISOString();
      if (this.downloadPausedUntil === 0) return;
      this.resumeDownloads('the analyzer solicited a download');
      void this.pollOrders();
    });
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
        // A repeat the operator marked on the sample id can never match a row,
        // so retrying it 50 times only delays the day it is discarded unnamed.
        const base = rerunBaseBarcode(payload.barcode, (b) => this.orders.get(b) !== null);
        if (base) {
          this.reportRerun(payload, base);
          return;
        }
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
        await this.hmis.acknowledge(matched, this.cfg.equipmentCode);
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
      // Log the sites the pending calls will really carry.
      this.log.info(
        {
          codes: this.equipmentCodes(),
          siteIds: this.siteIds().map((s) => s ?? null),
          intervalMs,
          lookbackDays,
          download,
        },
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
      link: this.transport.connected ? 'connected' : this.transport.listening ? 'listening' : 'offline',
      linkError: this.transport.connected ? null : (this.transport.lastDialError ?? null),
      lastMessageAt: this.lastMessageAt,
      lastSolicitAt: this.lastSolicitAt,
      // On a staged analyzer "pending" is the samples still waiting for an
      // order row, so the console tiles keep meaning "not yet in HMIS".
      spool: stagedCounts ? { pending: stagedCounts.waiting, failed: this.spool.counts().failed } : this.spool.counts(),
      filing: this.cfg.filing.mode,
      staged: stagedCounts,
      interface: {
        syncCodes: [...this.cfg.allowTestCodes],
        aliases: { ...this.cfg.testCodeAliases },
        excluded: [...this.cfg.excludeIdentifiers, ...this.cfg.excludeParameterIds.map((id) => `param ${id}`)],
        ignored: [...this.cfg.ignoreTestCodes],
      },
      orders: {
        eqCodes: this.equipmentCodes(),
        siteId: this.cfg.siteId ?? this.hmis.siteId ?? null,
        stored: this.orders.count(),
        pollEnabled: this.cfg.orderPoll.enabled,
        lastPollAt: this.lastPollAt,
        lastPollError: this.lastPollError,
        downloaded: this.downloadedCount,
        downloadPausedUntil: this.downloadPausedUntil ? new Date(this.downloadPausedUntil).toISOString() : null,
        downloadFailStreak: this.downloadFailStreak,
        parameterCatalogue: { ...this.parameters.counts(), enabled: this.cfg.fillMissingOrderRows },
      },
      filter: {
        allow: [...this.cfg.allowTestCodes],
        ignore: [...this.cfg.ignoreTestCodes],
        hmis: this.parameters.identifiers(),
      },
    };
  }

  /** Every HMIS equipment code this machine's orders may be registered under. */
  private equipmentCodes(): string[] {
    return [this.cfg.equipmentCode, ...this.cfg.extraEquipmentCodes];
  }

  /** The HMIS sites every pending call is repeated over: the analyzer's own
   *  `siteIds`, else its `siteId`, else the site-wide list (`hmis.siteIds`
   *  / `hmis.siteId`), else one unfiltered call. */
  private siteIds(): (string | undefined)[] {
    if (this.cfg.siteIds.length) return this.cfg.siteIds;
    if (this.cfg.siteId) return [this.cfg.siteId];
    // A client without the list (a test double) means one unfiltered call.
    return this.hmis.defaultSiteIds ?? [undefined];
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
    const neverDownload = this.neverDownload();
    let samples = 0;
    let pushed = 0;
    let held = 0; // ready to send, but the download breaker is open
    let notOurs = 0; // cached but outside downloadPrefixes — never sent
    let notInterfaced = 0; // every offered row was for a parameter outside allowTestCodes
    const downloadable = (barcode: string): boolean =>
      downloadPrefixes.length === 0 ||
      downloadPrefixes.some((p) => barcode.toUpperCase().startsWith(p.toUpperCase()));
    try {
      for (const eqCode of this.equipmentCodes()) {
        for (const siteId of this.siteIds()) {
          for (let daysAgo = 0; daysAgo <= lookbackDays; daysAgo++) {
            const body = await this.hmis.getPending({
              sampleId: '',
              eqCode,
              siteId,
              showCulture: this.cfg.showCulture,
              date: formatApiDateDaysAgo(daysAgo),
            });
            const groups = groupPendingByBarcode(body, {
              eqCode,
              equipmentId: this.cfg.equipmentId ?? null,
              ipAddress: this.ackIpAddress,
              portNo: this.ackPortNo,
            });
            for (const [, offered] of groups) {
              samples++;
              const pending = this.interfacedOnly(offered);
              if (!pending.found) {
                // Every row HMIS raised for this tube is for a parameter this
                // interface does not carry — nothing to store, nothing to wait
                // for, and nothing to acknowledge.
                notInterfaced++;
                continue;
              }
              // The poll is where a complete panel is most likely to be seen, so
              // it is the catalogue's main source.
              this.parameters.learn(pending.ackItems, { excludeParameterIds: this.cfg.excludeParameterIds });
              // `neverDownload` (orderPoll.excludeTestCodes) has to be passed
              // here as well as on the query path: the row is stored either way
              // so a result can still be joined, but the code must not come back
              // as waiting to be programmed. Leaving it off is what put the
              // derived values into the VITROS 250's sample program.
              const { order, newCodes } = this.orders.upsert(pending.sampleId, pending, 'poll', { neverDownload });
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
              // What goes on the wire. An analyzer that keeps ONE program per
              // sample and lets a later download replace it (VITROS 250, see
              // KermitLink.downloadReplacesProgram) must be given the whole
              // panel every time — a delta of the newly seen tests would wipe
              // the ones it already had. Everything else takes just the delta.
              const codes = this.link.downloadReplacesProgram ? this.programmable(order.testCodes) : newCodes;
              try {
                await this.link.sendOrders([
                  {
                    sampleId: order.sampleId,
                    // `codes`, not `newCodes`: on a replace-program link the whole
                    // panel goes down every time, and downloadCodeAliases is
                    // applied to whatever is actually being sent.
                    testCodes: this.downloadCodes(codes),
                    priority: order.priority,
                    patient: this.cfg.sendDemographics ? order.patient : null,
                    specimenType: order.specimenType,
                  },
                ]);
                this.orders.markDownloaded(order.sampleId, codes);
                this.downloadedCount++;
                pushed++;
                this.resumeDownloads('an order was accepted');
                this.log.info(
                  { barcode: order.sampleId, tests: codes, ...(codes.length !== newCodes.length ? { added: newCodes } : {}), eqCode },
                  'order downloaded to analyzer',
                );
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
      }
      this.lastPollAt = new Date().toISOString();
      if (this.lastPollError) this.log.info('order polling recovered');
      this.lastPollError = null;
      // New rows may have arrived for a staged sample that was waiting.
      if (this.filer) void this.filer.run('poll');
      if (samples || pushed || held || notOurs || notInterfaced) {
        this.log.debug({ samples, pushed, held, notOurs, notInterfaced }, 'order poll complete');
      }
    } catch (err) {
      this.lastPollError = err instanceof Error ? err.message : String(err);
      this.log.error({ err: this.lastPollError }, 'order poll failed — new orders are not reaching this analyzer');
    } finally {
      this.polling = false;
    }
  }

  // ---- what may be programmed ---------------------------------------------

  /** orderPoll.excludeTestCodes, normalised the way the order store compares codes. */
  private neverDownload(): ReadonlySet<string> {
    return new Set(this.cfg.orderPoll.excludeTestCodes.map(codeKey));
  }

  /** The codes of a panel that this analyzer may actually be given. */
  private programmable(codes: readonly string[]): string[] {
    const skip = this.neverDownload();
    return codes.filter((c) => !skip.has(codeKey(c)));
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
  /** allowTestCodes / ignoreTestCodes as one predicate — see mapper.ts. */
  private get codeFilter() {
    return interfacedCodeFilter({
      allowTestCodes: this.cfg.allowTestCodes,
      ignoreTestCodes: this.cfg.ignoreTestCodes,
      canonicalCode: this.cfg.protocol === 'astm' ? assayKey(this.cfg.astm.dialect) : undefined,
    });
  }

  /** The stored orders, newest first, each HMIS row marked sync / no-sync. */
  ordersView(limit = 50): OrderView[] {
    const cfg = {
      allowTestCodes: this.cfg.allowTestCodes,
      ignoreTestCodes: this.cfg.ignoreTestCodes,
      testCodeAliases: this.cfg.testCodeAliases,
      excludeIdentifiers: this.cfg.excludeIdentifiers,
      excludeParameterIds: this.cfg.excludeParameterIds,
      canonicalCode: this.cfg.protocol === 'astm' ? assayKey(this.cfg.astm.dialect) : undefined,
    };
    return this.orders
      .list()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((o) => {
        const downloaded = new Set(o.downloaded.map((d) => d.trim().toUpperCase()));
        const rows = o.rows.map((r) => ({
          identifier: r.identifier,
          parameterId: r.parameterId ?? null,
          labResultId: r.labResultId ?? null,
          sync: willSyncIdentifier(r.identifier, cfg, r.parameterId),
          downloaded: downloaded.has((r.identifier ?? '').trim().toUpperCase()),
        }));
        return {
          barcode: o.barcode,
          sampleId: o.sampleId,
          firstSeenAt: o.firstSeenAt,
          updatedAt: o.updatedAt,
          source: o.source,
          rows,
          syncCount: rows.filter((r) => r.sync).length,
          noSyncCount: rows.filter((r) => !r.sync).length,
        };
      });
  }

  /**
   * Operator "Re-send": push one barcode's order to the analyzer again, now.
   * The poller only ever hands over what the instrument has not been given
   * yet, so an order the machine lost — a worklist cleared on the instrument,
   * a download that was ACKed but never took — sits in the store as
   * "downloaded" and is never offered twice. This is the way to offer it.
   *
   * The rows are read from HMIS afresh (a test added since the poll is
   * included), and the WHOLE order goes, not just the un-downloaded part; the
   * cached order is the fallback when HMIS has nothing for the barcode now.
   * Skips the download breaker on purpose — the operator is asking to try —
   * and a success closes it. Throws with a plain-language reason when the
   * push cannot be made; returns null for a barcode neither side knows.
   */
  async resendOrder(barcode: string): Promise<ResendReport | null> {
    const lookup = normalizeBarcode(barcode);
    if (this.cfg.protocol === 'hl7') {
      // The HL7 link can only answer a query the instrument opened — there is
      // no unsolicited worklist message it will accept.
      throw new Error('this analyzer only takes a worklist in reply to its own host query — it cannot be pushed from here');
    }
    if (!this.transport.connected) throw new Error('the analyzer link is down');
    const { downloadPrefixes } = this.cfg.orderPoll;
    if (downloadPrefixes.length > 0 && !downloadPrefixes.some((p) => lookup.startsWith(p.toUpperCase()))) {
      throw new Error(`barcode is outside this analyzer's downloadPrefixes (${downloadPrefixes.join(', ')})`);
    }

    let pending: PendingOrders | null = null;
    try {
      // includeTransmitted: a re-send is exactly the case where HMIS may
      // already have flagged the rows as handed over.
      pending = await this.fetchPending(lookup, true);
    } catch (err) {
      this.log.warn(
        { barcode: lookup, err: err instanceof Error ? err.message : String(err) },
        're-send: HMIS lookup failed — using the cached order',
      );
    }
    const source: ResendReport['source'] = pending?.found ? 'hmis' : 'store';
    const stored = pending?.found ? this.orders.upsert(lookup, pending, 'resend').order : this.orders.get(lookup);
    if (!stored) return null;
    const order: OrderDownload = {
      sampleId: stored.sampleId,
      testCodes: this.programmable(stored.testCodes),
      priority: stored.priority,
      patient: this.cfg.sendDemographics ? stored.patient : null,
      specimenType: stored.specimenType,
    };
    if (order.testCodes.length === 0) throw new Error('the order has no tests to send');

    this.log.warn({ barcode: lookup, tests: order.testCodes, source }, 're-send requested by an operator');
    try {
      await this.link.sendOrders([order]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ barcode: lookup, tests: order.testCodes, err: message }, 're-send failed — the analyzer did not take the order');
      throw new Error(`the analyzer did not accept the order: ${message}`);
    }
    this.orders.markDownloaded(lookup, order.testCodes);
    this.downloadedCount++;
    this.resumeDownloads('an operator re-sent an order');
    this.log.info({ barcode: lookup, tests: order.testCodes, source }, 'order re-sent to analyzer');
    return { barcode: order.sampleId, tests: order.testCodes, source };
  }

  stagedSummaries(): StagedSummary[] | null {
    const list = this.staged?.summaries() ?? null;
    return list ? list.map((s) => this.markWithheld(s)) : null;
  }

  /**
   * Re-label the waiting values that are held back on purpose. A code is
   * WITHHELD when the cached order rows for the sample do name it (directly,
   * or as its alias target) but every such row is excluded by
   * excludeParameterIds / excludeIdentifiers — ZHPN001's "PCT" is parameter
   * 2162, the peripheral-smear platelet line, so plateletcrit is never filed
   * into it. Such a value is not waiting for an order that may yet arrive; it
   * waits for the HMIS master to be corrected, and the console says so. Only
   * the view changes: the filer still retries it, so fixing HMIS files it.
   */
  private markWithheld(s: StagedSummary): StagedSummary {
    if (!s.waiting) return s;
    const rows = this.orders.get(s.barcode)?.rows ?? [];
    if (!rows.length) return s;
    const key = this.assayJoinKey();
    const exIds = new Set(this.cfg.excludeIdentifiers.map(key));
    const exParams = new Set(this.cfg.excludeParameterIds.map(Number));
    const reasonFor = (code: string): string | null => {
      const names = new Set([key(code)]);
      const alias = this.aliasFor(code);
      if (alias) names.add(key(alias));
      const hits = rows.filter((r) => names.has(key(r.identifier)));
      if (!hits.length) return null;
      const blocked = hits.filter((r) => exIds.has(key(r.identifier)) || (r.parameterId != null && exParams.has(Number(r.parameterId))));
      if (blocked.length !== hits.length) return null;
      const ids = [...new Set(blocked.map((r) => r.parameterId).filter((p) => p != null))];
      return `withheld — HMIS row "${blocked[0]!.identifier}"${ids.length ? ' (parameter ' + ids.join(', ') + ')' : ''} is excluded in config; fix the HMIS master to file it`;
    };
    const withheldCodes: string[] = [];
    const values = s.values.map((v) => {
      if (v.state !== 'waiting') return v;
      const note = reasonFor(v.testCode);
      if (!note) return v;
      withheldCodes.push(v.testCode);
      return { ...v, state: 'withheld' as const, note };
    });
    if (!withheldCodes.length) return s;
    const waitingCodes = s.waitingCodes.filter((c) => !withheldCodes.includes(c));
    return {
      ...s,
      values,
      waiting: waitingCodes.length,
      waitingCodes,
      withheld: withheldCodes.length,
      withheldCodes,
      complete: waitingCodes.length === 0,
    };
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
   * Operator "Force": push EVERY interfaced value of a staged sample to the
   * HMIS results endpoint now, filed or not, without asking HMIS for the
   * sample's pending rows. The parameter ids come from the order rows already
   * cached for the barcode and, for anything those do not cover, from the
   * parameter catalogue (the way fillMissingOrderRows rebuilds a withdrawn
   * row) — so a value HMIS has stopped offering a row for can still be filed
   * against the parameter it belongs to. Values that resolve to nothing are
   * reported back, not guessed. The rows sent are acknowledged afterwards, as
   * a normal filing is. Returns null for an unknown barcode.
   */
  async stagedForce(barcode: string): Promise<ForceReport | null> {
    if (!this.staged) return null;
    const s = this.staged.get(normalizeBarcode(barcode));
    if (!s) return null;
    const upload = this.staged.forceUpload(s, `${s.barcode}-force-${Date.now()}`);
    const cached = this.orders.get(s.barcode)?.rows ?? [];
    const joined = this.joinRows(upload, cached, { force: true });
    const report: ForceReport = {
      barcode: s.barcode,
      values: upload.results.length,
      sent: joined.rows.length,
      accepted: 0,
      message: '',
      unresolved: joined.unmatched,
      // rows and filedCodes are built in lockstep by the mapper: index i of
      // each is the same value.
      rows: joined.rows.map((r, i) => ({
        testCode: joined.filedCodes[i]?.testCode ?? r.identifier,
        identifier: r.identifier,
        parameterId: r.parameterId,
        value: r.resultValue,
      })),
    };
    this.log.warn(
      { barcode: s.barcode, values: report.values, sending: report.sent, unresolved: joined.unmatched, cachedRows: cached.length },
      'FORCE push to HMIS from the admin console — pending rows NOT checked; ids from the cached order rows and the parameter catalogue',
    );
    if (joined.rows.length === 0) {
      report.message = 'nothing could be mapped to an HMIS parameter from the cached order rows or the catalogue';
      return report;
    }
    const res = await this.hmis.postResults(joined.rows, this.cfg.equipmentCode);
    report.accepted = res.filed;
    report.message = res.message;
    this.staged.markFiled(s.barcode, joined.filedCodes);
    try {
      await this.hmis.acknowledge(joined.matched, this.cfg.equipmentCode);
    } catch (err) {
      this.log.error(
        { barcode: s.barcode, err: err instanceof Error ? err.message : String(err) },
        'acknowledge failed AFTER a forced push — results are filed, rows may still show pending',
      );
    }
    this.log.warn({ barcode: s.barcode, accepted: res.filed, sent: joined.rows.length, message: res.message }, 'FORCE push: HMIS answered');
    return report;
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
  private joinRows(payload: HmisResultUpload, orderRows: MirthAcknowledgeItem[], opts: { force?: boolean } = {}) {
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
        this.cfg.excludeIdentifiers,
        this.cfg.excludeParameterIds,
        this.cfg.testValueMap,
        this.cfg.testCodeDecimals,
      );

    const joined = join(orderRows);
    if (joined.ambiguous.length) {
      // Loud on purpose: values are being held back because the HMIS master
      // offers the same identifier on more than one parameter for this sample.
      this.log.warn(
        { barcode: payload.barcode, ambiguous: joined.ambiguous },
        'HMIS names several parameters the same — these values are NOT filed until the master is unambiguous (or the wrong row is listed in excludeParameterIds)',
      );
    }
    // A forced push always tries the catalogue: the whole point of it is a
    // row HMIS is no longer offering.
    if ((!this.cfg.fillMissingOrderRows && !opts.force) || joined.unmatched.length === 0) return joined;

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

    const { rows: rebuilt, unknown } = this.parameters.synthesize(orderRows, candidates, canonical, {
      excludeParameterIds: this.cfg.excludeParameterIds,
    });
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

  /** The test codes to put in an order DOWNLOAD: the HMIS codes as they are,
   *  plus, for each one that has a downloadCodeAliases entry, the code the
   *  instrument recognises. Both go, so results still return under the HMIS
   *  spelling and an unrecognised extra costs nothing. Order preserved,
   *  duplicates dropped case-insensitively. */
  private downloadCodes(codes: string[]): string[] {
    const aliases = Object.entries(this.cfg.downloadCodeAliases);
    if (!aliases.length) return codes;
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (c: string) => {
      const k = c.trim().toUpperCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(c);
    };
    for (const code of codes) {
      add(code);
      const k = code.trim().toUpperCase();
      for (const [from, to] of aliases) {
        if (from.trim().toUpperCase() !== k) continue;
        for (const t of Array.isArray(to) ? to : [to]) add(t);
      }
    }
    return out;
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
        for (const q of msg.queries) await this.answerQuery(q);
      }
    }

    // 2) Results → durable upload.
    if (msg.results.length > 0) {
      if (this.cfg.rerunSuffix === 'strip') msg = this.stripRerunSuffixes(msg);
      const voids = msg.results.filter((r) => isVoidResult(r.value));
      if (voids.length) {
        this.log.warn(
          {
            samples: [...new Set(voids.map((r) => r.sampleId))],
            // With the analyzer's own condition code where it gives one — the
            // VITROS 250's "76 (060MENSPF)" is the difference between a short
            // sample and an assay the instrument cannot run at all.
            codes: voids.map((r) => (r.abnormalFlag ? `${r.testCode} (${r.abnormalFlag})` : r.testCode)),
          },
          'analyzer reported no value for these assays — not filed; the rerun will file',
        );
      }
      this.reportOutstandingProgrammedAssays(msg);
      const uploads = toResultUploads(this.cfg, msg);
      for (const full of uploads) {
        // A control run has no order row in HMIS. Filing it would query pending
        // for a barcode the gateway has never heard of, find nothing, and retry
        // the upload for as long as the spool allows — which is exactly what
        // sample 89772 did. The legacy app dropped these at the same point.
        if (full.isQc && !this.cfg.qc.upload) {
          this.log.info({ barcode: full.barcode, count: full.results.length }, 'QC/control run — not sent to HMIS');
          continue;
        }

        // Only the parameters the interface is scoped to go any further. The
        // instrument's other channels (a BC-5150 sends 60 numeric values, 22
        // interfaced) are dropped here — not stored, not counted, not waited
        // for — so the console shows "x of 22", not "x of 60".
        const { upload: u, dropped } = keepInterfacedResults(full, this.codeFilter);
        if (dropped.length) {
          this.log.debug({ barcode: u.barcode, dropped }, 'codes not interfaced to HMIS dropped at intake — not stored');
        }
        if (u.results.length === 0) {
          this.log.info(
            { barcode: u.barcode, received: full.results.length },
            'message carried no interfaced parameter — nothing to file',
          );
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

  /**
   * Name the assays an analyzer was PROGRAMMED with and then answered without.
   *
   * An assay the instrument simply omits — no value and not even the
   * "NO RESULT" placeholder — leaves no trace anywhere: the sample files its
   * other values, HMIS keeps the missing row pending for ever, and the lab
   * reasonably concludes the worklist never reached the machine at all. That
   * is what "the VITROS 250 is working one-directional" meant on 2026-09-23.
   * It was not: between 16 and 23 Sep every one of 10/10 sample programs was
   * acknowledged packet by packet and every result came back on the same
   * barcode. What did not come back were particular ASSAYS — 107, 108 and 109
   * (the calculated members of HMIS service 3221) programmed 7 times each and
   * returned zero times, while 36, 37 and 89 on the very same tubes filed
   * normally, and 76 programmed 29 times across 12 samples with never a value.
   *
   * So the difference the log must show is "the order reached the analyzer and
   * this assay did not run" versus "the order never got there". Logged per
   * transmission, which is also per rerun: an assay still missing on the third
   * run of a tube is worth saying three times.
   *
   * Both sides are compared on the dialect's CANONICAL assay key, for the same
   * reason joinRows does it: HMIS spells an ECiQ assay as the full
   * "1.000000+035+1" where the analyzer's R record reports "035". Compared
   * raw, every assay that did come back was also named as outstanding — 31
   * such false alarms on the ECiQ between 16 and 27 Sep 2026, beside 33
   * genuine ones on the VITROS 250, which reports bare codes and was never
   * affected.
   */
  private reportOutstandingProgrammedAssays(msg: ParsedMessage): void {
    const key = this.assayJoinKey();
    for (const sampleId of new Set(msg.results.map((r) => r.sampleId))) {
      const order = this.orders.get(normalizeBarcode(sampleId));
      if (!order?.downloaded.length) continue; // never programmed from here
      const returned = new Set(
        msg.results.filter((r) => r.sampleId === sampleId).map((r) => key(r.testCode)),
      );
      const outstanding = order.downloaded
        // A code the wire could never carry was dropped before transmission, so
        // "the order did reach it" would be a lie about this one. markDownloaded
        // records it all the same — deliberately, or the poller would re-send it
        // every 30s for ever — so the exclusion belongs here. HMIS code 986 on
        // PL2609240002 (2026-09-24) is the case: no single byte can hold it.
        .filter((c) => this.couldReachAnalyzer(c))
        .filter((c) => !returned.has(key(c)));
      if (!outstanding.length) continue;
      this.log.warn(
        { barcode: order.sampleId, outstanding, returned: [...returned] },
        'analyzer answered this sample without these programmed assays — the order did reach it; these assays did not run',
      );
    }
  }

  /**
   * A repeat the operator keyed with a suffix — "PL2609240011/R" for a rerun of
   * PL2609240011 — put on the record instead of thrown away.
   *
   * HMIS holds no such barcode, so the join finds nothing, and until now the
   * item retried 50 times, parked in failed/ and was then discarded past the
   * retention window without ever being named: that is how 32=117 on
   * PL2609190003R went missing on 20 Sep 2026.
   *
   * The suffix is NOT stripped and the values are NOT filed under the base
   * barcode. Every rerun seen here repeated an assay HMIS had already accepted
   * — PL2609240011 filed 90=57 and its rerun said 56; PL2609260017 filed 46=1.3
   * and its rerun said 1.3 — so filing them would overwrite an acknowledged
   * result with a duplicate or a near-miss, silently, on a judgement that is
   * the lab's to make. What the connector owes is the record: which barcode
   * this repeats, what the instrument now reports, and which of those assays
   * the original order covers. Warn, drop the item, let the lab decide.
   */
  /**
   * `rerunSuffix: "strip"`: re-key every result whose sample id carries a rerun
   * mark onto the base barcode, BEFORE anything else sees it — so the
   * outstanding-assay report, the staged store / spool and the messageId all
   * work on the barcode HMIS actually holds. Logged per sample so a filed
   * rerun can always be traced back to what the instrument sent.
   */
  private stripRerunSuffixes(msg: ParsedMessage): ParsedMessage {
    const known = (b: string) => this.orders.get(b) !== null;
    const renamed = new Map<string, string>();
    const results = msg.results.map((r) => {
      const base = r.sampleId ? strippedRerunBarcode(r.sampleId, known) : null;
      if (!base) return r;
      renamed.set(r.sampleId, base);
      return { ...r, sampleId: base };
    });
    if (renamed.size === 0) return msg;
    for (const [from, to] of renamed) {
      this.log.warn(
        {
          barcode: from,
          filedAs: to,
          values: msg.results.filter((r) => r.sampleId === from).map((r) => `${r.testCode}=${r.value}`),
        },
        'rerun suffix stripped (rerunSuffix = strip) — these values are filed under the base barcode',
      );
    }
    return { ...msg, results };
  }

  private reportRerun(payload: HmisResultUpload, base: string): void {
    const key = this.assayJoinKey();
    const ordered = new Set((this.orders.get(base)?.downloaded ?? []).map(key));
    const values = payload.results.map((r) => `${r.testCode}=${r.value}`);
    this.log.warn(
      {
        barcode: payload.barcode,
        rerunOf: base,
        values,
        onOriginalOrder: payload.results.filter((r) => ordered.has(key(r.testCode))).map((r) => r.testCode),
      },
      'rerun of an existing barcode — HMIS has no such sample, so these values were NOT filed; check them against the original at the instrument and re-key under the base barcode if the repeat should stand',
    );
  }

  /**
   * How an assay identifier is compared, whichever side named it.
   *
   * HMIS and the instrument do not always spell the same assay alike: on the
   * ECiQ the pending row's identifier is the full "1.000000+035+1" where the
   * analyzer's R record reports "035". Everything that matches a returned code
   * against an ordered one goes through here, for the same reason joinRows
   * does it — compared raw, an assay that did come back looks like one that
   * never ran.
   */
  private assayJoinKey(): (identifier: string) => string {
    const canonical = this.cfg.protocol === 'astm' ? assayKey(this.cfg.astm.dialect) : undefined;
    return (identifier) => codeKey(canonical ? canonical(identifier) : identifier);
  }

  /** Whether this assay code can physically go down this link. The VITROS 250
   *  carries a code as ONE byte, so anything outside 1–126 is dropped by the
   *  codec before the transfer (see unencodableTestCodes) — it was ordered in
   *  HMIS but never programmed on the instrument. */
  private couldReachAnalyzer(code: string): boolean {
    return this.cfg.protocol === 'kermit' ? encodeTestCode(code) !== null : true;
  }

  private async answerQuery(query: HostQuery): Promise<void> {
    const barcode = query.sampleId;
    // HMIS matches barcodes case-sensitively; look up with the canonical
    // uppercase form so a lowercase-entered sample still resolves its order.
    const lookup = normalizeBarcode(barcode);

    // A control barcode has no order in HMIS. Asking anyway just adds a round
    // trip per retry (89772 produced 100 identical pending queries), so answer
    // the instrument locally with no order instead.
    if (isQcSample(lookup, this.cfg.qc)) {
      // The instrument is still waiting for an answer: a query left hanging
      // holds its sampler until the host timeout. The Maglumi X6's "$lc$"
      // control query of 2026-09-17 19:52Z got nothing back at all. Send the
      // empty download, exactly as for a barcode with no order.
      this.log.info({ barcode: lookup }, 'QC/control barcode — not queried against HMIS, answered with an empty download');
      try {
        await this.link.sendOrders([]);
      } catch (err) {
        this.log.error({ barcode, err: err instanceof Error ? err.message : String(err) }, 'host-query reply failed');
      }
      return;
    }
    try {
      // One row per pending test — collapse the rows for this barcode into a
      // single order, keeping each row so it can be acknowledged afterwards.
      const pending = await this.fetchPending(lookup);

      // Remember the rows: the result comes back in a LATER message and needs
      // their labResultId to be filable.
      if (pending.ackItems.length) this.orders.upsert(lookup, pending, 'query', { neverDownload: this.neverDownload() });

      // HMIS drops a sample's rows from the pending list and offers them
      // again later. LB2609180027, 2026-09-17: 21 rows on the 18:42Z poll,
      // none on the live lookup at 19:08Z when the U-WAM asked (the reply
      // was an empty download), 27 values filed from the CACHED rows at
      // 19:48Z. The order store holds every row this analyzer was ever
      // offered, so a barcode HMIS cannot see right now is still answered
      // from there — the rule resolveOrderRows already applies when filing.
      // Only a barcode neither side knows gets the empty download.
      const stored = pending.found ? null : this.orders.get(lookup);
      const source = pending.found ? pending : stored?.rows.length ? stored : null;
      if (!source) {
        this.log.info({ barcode, lookup }, 'no pending orders — sending empty download');
        await this.link.sendOrders([]); // header + terminator = "no work"
        return;
      }

      const order: OrderDownload = {
        // Reply with the barcode the analyzer sent so it matches its own sample.
        sampleId: barcode,
        testCodes: this.downloadCodes(source.testCodes),
        priority: source.priority,
        patient: this.cfg.sendDemographics ? source.patient : null,
        specimenType: source.specimenType,
        queryReply: true,
        specimenIdField: query.specimenIdField,
      };
      await this.link.sendOrders([order]);
      // A query answer is a full download, so the poller need not repeat it.
      this.orders.markDownloaded(lookup, source.testCodes);
      this.log.info(
        { barcode, tests: this.downloadCodes(source.testCodes), from: pending.found ? 'hmis' : 'order store' },
        pending.found ? 'order download sent to analyzer' : 'HMIS lists no pending rows — order download sent from the cached rows',
      );

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
    // Same door as the poll: a row for a parameter this interface does not carry
    // is not stored, not waited for and not acknowledged, whichever path fetched
    // it. Filtering in both places is what keeps a host-query answer and a poll
    // answer describing the same tube identically.
    const merged = this.interfacedOnly(mergePending(parts));
    this.parameters.learn(merged.ackItems, { excludeParameterIds: this.cfg.excludeParameterIds });
    return merged;
  }

  // ---- interfaced-parameter filter -------------------------------------------
  // HMIS raises a pending row for EVERY parameter of a service, whether or not
  // this interface can file it. On the BC-6000 that is 22 analyzer mnemonics
  // the lab has interfaced plus 16 parameters registered under a bare number
  // (290, 460, 76 …) that the connector never files — see allowTestCodes in
  // config.json. Left in, those rows sit in the order store, are "learned" by
  // the parameter catalogue, and make every CBC look permanently incomplete.
  //
  // So when an allow-list is configured, a pending row is kept only if its
  // identifier is one of the allowed analyzer codes or one of the HMIS
  // spellings testCodeAliases maps them to (RDW-CV → RDW). The rows are
  // dropped here, at the door, and nothing downstream ever sees them. They are
  // NOT acknowledged: HMIS keeps listing them until the lab clears them or
  // fixes the equipment-parameter master (the lab's decision, 2026-09-11).
  //
  // Matching is exact and case-insensitive, like the allow-list itself. An
  // empty allowTestCodes means no filter — every other analyzer is untouched.

  /** Lower-cased identifiers a pending row may carry and still be interfaced;
   *  null when no allow-list is configured. Built in the constructor — a class
   *  field initialiser would run before `cfg` is assigned under ES2022. */
  private readonly interfacedIdentifiers: Set<string> | null;

  private static interfacedIdentifiersFor(cfg: AnalyzerConfig): Set<string> | null {
    const allow = cfg.allowTestCodes ?? [];
    if (allow.length === 0) return null;
    const set = new Set(allow.map((c) => c.trim().toLowerCase()));
    for (const [code, alias] of Object.entries(cfg.testCodeAliases ?? {})) {
      if (set.has(code.trim().toLowerCase())) set.add(alias.trim().toLowerCase());
    }
    return set;
  }

  /** Drop the rows (and test codes) of parameters this interface does not carry. */
  private interfacedOnly(pending: PendingOrders): PendingOrders {
    const keep = this.interfacedIdentifiers;
    if (!keep || pending.ackItems.length === 0) return pending;
    const ok = (id: string) => keep.has(id.trim().toLowerCase());
    const ackItems = pending.ackItems.filter((r) => ok(r.identifier));
    if (ackItems.length === pending.ackItems.length) return pending;

    const dropped = pending.ackItems.filter((r) => !ok(r.identifier)).map((r) => r.identifier);
    this.log.debug(
      { barcode: pending.sampleId, dropped, kept: ackItems.map((r) => r.identifier) },
      'pending rows for parameters outside allowTestCodes ignored — not stored, not waited for, not acknowledged',
    );
    const testCodes = pending.testCodes.filter(ok);
    return { ...pending, ackItems, testCodes, found: ackItems.length > 0 };
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
    if (w.trace) entry.trace = w.trace;
    this.wireLog.push(entry);
    if (this.wireLog.length > 200) this.wireLog.shift();
    this.wireAudit?.record(entry);
  }
}

function describeTransport(cfg: AnalyzerConfig): string {
  const t = cfg.transport;
  return t.type === 'tcp' ? `tcp://${t.host}:${t.port} (${t.mode})` : `serial://${t.path}@${t.baudRate}`;
}
