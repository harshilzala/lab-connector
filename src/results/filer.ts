import type { Logger } from '../logger.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';
import type { toLisResultRows } from '../mapping/mapper.js';
import { ResultStore, summarize, type StagedSample } from './store.js';

// =============================================================================
// StagedFiler — the filing pass for `filing.mode: "staged"`.
//
// The retired middleware's matching step, on the HMIS API: walk every sample
// with something left to file, join it to the order rows known right now,
// post what matches, acknowledge those rows, and leave the rest waiting. It
// runs on a timer, after every order poll (new rows may have arrived), and
// the moment a result comes in.
//
// The rules that make it behave like the old system rather than the queue:
//
//   * samples are independent — a failure or a missing order on one never
//     stops the next from being tried in the same pass;
//   * "no order row yet" is not an error and costs nothing — the order poll
//     brings the rows in on its own, and HMIS is only asked about a specific
//     barcode at a slow, fixed cadence (recheckMs) as a safety net;
//   * nothing is parked — a value waits until it files or ages out.
//
// A run of consecutive GATEWAY errors (not "no rows") does stop the pass, so
// an HMIS outage does not turn into one failed POST per sample every tick.
// =============================================================================

export type JoinResult = ReturnType<typeof toLisResultRows>;

export interface FilerDeps {
  store: ResultStore;
  /** Order rows for a barcode; `refresh` forces a live HMIS lookup. */
  orderRows(barcode: string, opts: { refresh: boolean }): Promise<MirthAcknowledgeItem[]>;
  /** The analyzer's join — aliases, ignore list, allow-list, unit scaling. */
  join(upload: HmisResultUpload, rows: MirthAcknowledgeItem[]): JoinResult;
  postResults(rows: LisInboundResultRow[]): Promise<{ filed: number; message: string }>;
  acknowledge(rows: MirthAcknowledgeItem[]): Promise<void>;
  log: Logger;
  /** Minimum gap between two live HMIS lookups for the same waiting barcode. */
  recheckMs: number;
}

export interface FilerReport {
  reason: string;
  samples: number;
  filed: number;
  partial: number;
  waiting: number;
  errors: number;
  skipped: boolean;
}

export type SampleOutcome = 'filed' | 'partial' | 'waiting' | 'error' | 'nothing';

/** Gateway failures in a row before the pass gives up until the next tick. */
const MAX_CONSECUTIVE_ERRORS = 3;

export class StagedFiler {
  private running = false;
  /** Barcodes asked for while a pass was already running — handled at the
   *  end of that pass rather than dropped, so a result that lands mid-pass is
   *  still tried straight away. */
  private readonly followUp = new Set<string>();

  constructor(private readonly deps: FilerDeps) {}

  /**
   * One pass. `only` limits it to a single barcode (a result just arrived, or
   * the operator pressed "file now"); that barcode is always allowed one live
   * HMIS lookup regardless of the recheck cadence.
   */
  async run(reason: string, only?: string): Promise<FilerReport> {
    const report: FilerReport = { reason, samples: 0, filed: 0, partial: 0, waiting: 0, errors: 0, skipped: false };
    if (this.running) {
      if (only) this.followUp.add(only);
      report.skipped = true;
      return report;
    }
    this.running = true;
    try {
      const targets = only ? [this.deps.store.get(only)].filter((s): s is StagedSample => !!s) : this.deps.store.waiting();
      // Anything that arrived during the previous pass rides along with this one.
      for (const b of this.followUp) {
        const s = this.deps.store.get(b);
        if (s && !targets.some((t) => t.barcode === s.barcode)) targets.push(s);
      }
      this.followUp.clear();
      let consecutiveErrors = 0;
      for (const sample of targets) {
        report.samples++;
        const outcome = await this.fileOne(sample, reason, only !== undefined);
        if (outcome === 'error') {
          report.errors++;
          if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.deps.log.warn(
              { reason, consecutiveErrors },
              'filing pass stopped — the HMIS gateway is failing; the rest will be tried on the next pass',
            );
            break;
          }
          continue;
        }
        consecutiveErrors = 0;
        if (outcome === 'filed') report.filed++;
        else if (outcome === 'partial') report.partial++;
        else if (outcome === 'waiting') report.waiting++;
      }
      if (report.filed || report.partial || report.errors) {
        this.deps.log.info(report, 'filing pass complete');
      } else if (report.samples) {
        this.deps.log.debug(report, 'filing pass complete — everything is still waiting for order rows');
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private async fileOne(sample: StagedSample, reason: string, forced: boolean): Promise<SampleOutcome> {
    const { store, log } = this.deps;
    const barcode = sample.barcode;
    const upload = store.pendingUpload(sample, `${barcode}-${Date.now()}`);
    if (upload.results.length === 0) return 'nothing';

    try {
      let rows = await this.deps.orderRows(barcode, { refresh: false });
      let joined = this.deps.join(upload, rows);
      let checked = false;

      // Nothing matched from the cache, or only part of it did: ask HMIS
      // itself, but only at the recheck cadence — or once, straight away, for
      // a sample that just arrived or that the operator pointed at.
      if (joined.unmatched.length > 0 && this.mayRecheck(sample, forced)) {
        rows = await this.deps.orderRows(barcode, { refresh: true });
        joined = this.deps.join(upload, rows);
        checked = true;
      }

      // Values that will never file, whatever the order says.
      if (joined.ignored.length) {
        store.markDropped(barcode, joined.ignored, 'ignored');
        log.debug({ barcode, ignored: joined.ignored }, 'codes not interfaced to HMIS dropped — not filed, not retried');
      }
      if (joined.voided.length) {
        store.markDropped(barcode, joined.voided, 'void');
        log.warn({ barcode, voided: joined.voided }, 'analyzer reported no value for these assays — not filed; the rerun will file');
      }
      if (joined.scaled.length) {
        log.info({ barcode, scaled: joined.scaled }, 'unit conversion applied before filing');
      }

      if (joined.rows.length > 0) {
        const res = await this.deps.postResults(joined.rows);
        store.markFiled(barcode, joined.filedCodes);
        log.info(
          { barcode, filed: res.filed, sent: joined.rows.length, stillWaiting: joined.unmatched, message: res.message, reason },
          'results filed to HMIS',
        );
        // Acknowledge LAST, and never fatally: the values are already saved.
        try {
          await this.deps.acknowledge(joined.matched);
          log.info({ barcode, rows: joined.matched.length }, 'pending rows acknowledged after filing');
        } catch (err) {
          log.error(
            { barcode, rows: joined.matched.length, err: err instanceof Error ? err.message : String(err) },
            'acknowledge failed AFTER results were filed — rows stay pending and may be downloaded again',
          );
        }
      }

      const after = summarize(store.get(barcode) ?? sample);
      if (after.waiting === 0) {
        store.recordAttempt(barcode, { error: null, checkedHmis: checked });
        return joined.rows.length > 0 ? 'filed' : 'nothing';
      }

      // Still waiting for order rows. Not an error — say so once per change
      // of state rather than on every pass.
      const why = `no order row yet for: ${after.waitingCodes.join(', ')}`;
      if (sample.lastError !== why) {
        log.info(
          { barcode, waiting: after.waitingCodes, filed: after.filed, known: rows.map((r) => r.identifier), checkedHmis: checked },
          'results waiting for their HMIS order — will file when the order appears',
        );
      }
      store.recordAttempt(barcode, { error: why, checkedHmis: checked });
      return joined.rows.length > 0 ? 'partial' : 'waiting';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.recordAttempt(barcode, { error: message });
      log.warn({ barcode, err: message, reason }, 'filing failed for this sample — will retry on the next pass');
      return 'error';
    }
  }

  private mayRecheck(sample: StagedSample, forced: boolean): boolean {
    if (sample.lastCheckedAt === null) return true; // first look at this barcode
    if (forced) return true;
    return Date.now() - Date.parse(sample.lastCheckedAt) >= this.deps.recheckMs;
  }
}
