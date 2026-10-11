import type { Logger } from '../logger.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';
import type { toLisResultRows } from '../mapping/mapper.js';
import { ResultStore, isLaneHold, isPatientHold, snapshotOf, summarize, uncertifiedGenxLines, type FiledValue, type StagedSample } from './store.js';
import { pairingVerdict, wasHeld, type PairingRule } from './pairing.js';
import { laneLabel, type Lane } from '../hmis/lanes.js';

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
  /** The analyzer's join — aliases, ignore list, allow-list, unit scaling.
   *  `lane` is passed in both HMIS mode, where the rows are one lane's. */
  join(upload: HmisResultUpload, rows: MirthAcknowledgeItem[], lane?: Lane): JoinResult;
  postResults(rows: LisInboundResultRow[]): Promise<{ filed: number; message: string; unmatched?: string[] }>;
  acknowledge(rows: MirthAcknowledgeItem[]): Promise<void>;
  log: Logger;
  /** Minimum gap between two live HMIS lookups for the same waiting barcode. */
  recheckMs: number;
  /** The analyzer's barcodeCompletion rule, if it has one: the full HMIS
   *  barcode a short instrument id stands for, or null when the id is not of
   *  that shape. See src/results/complete.ts. */
  completeBarcode?: (barcode: string, receivedAt: Date) => string | null;
  /** Instruments that must all have reported before a sample is filed — the
   *  Sysmex U-WAM's UC-3500 + UF-4000 pair, and nothing else in this
   *  deployment. Null or an empty device list means no hold, which is what
   *  every other analyzer gets. See src/results/pairing.ts. */
  pairing?: PairingRule | null;
  /** Single HMIS mode: the analyzer's one lane, recorded on every value it
   *  files (StagedValue.lanes) beside filedAt. */
  lane?: Lane;
  /** Both HMIS mode: one gateway per lane. Present = the sample is filed lane
   *  by lane, under the hold rule (see fileLanes). */
  lanes?: LaneFilerDeps;
  /** GenX auto-certify of one result line (analyzer genxAutoCertify, with
   *  genx among its lanes). Throws when GenX refuses or is down. */
  certify?: (lineId: number, barcode: string) => Promise<void>;
  /** Minimum gap between two certify-only looks at a fully filed sample
   *  (the analyzer's passIntervalMs). */
  certifyRecheckMs?: number;
  /** Both mode: the hold message when HINAI and GenX name different patients
   *  for the barcode (addendum C2), else null. */
  patientMismatch?: (barcode: string) => string | null;
  /** Both mode, "File now" (D3): does this lane hold ANY row for the code
   *  (its alias and canonical spelling included, excluded rows too)? A code
   *  with a row is withheld or ambiguous, never skipped. */
  hasRowFor?: (rows: MirthAcknowledgeItem[], code: string) => boolean;
}

/** Both HMIS mode: what the filer needs per lane. */
export interface LaneFilerDeps {
  /** The analyzer's lanes, HINAI first. */
  names: readonly Lane[];
  /** That lane's order rows only; `refresh` forces a live lookup. */
  orderRows(lane: Lane, barcode: string, opts: { refresh: boolean; cachedOnly?: boolean }): Promise<MirthAcknowledgeItem[]>;
  postResults(lane: Lane, rows: LisInboundResultRow[]): Promise<{ filed: number; message: string; unmatched?: string[] }>;
  acknowledge(lane: Lane, rows: MirthAcknowledgeItem[]): Promise<void>;
}

export interface FilerReport {
  reason: string;
  samples: number;
  filed: number;
  partial: number;
  waiting: number;
  /** Samples deliberately not filed this pass because the other instrument on
   *  a paired analyzer has not reported yet. U-WAM only. */
  held: number;
  errors: number;
  skipped: boolean;
}

export type SampleOutcome = 'filed' | 'partial' | 'waiting' | 'held' | 'error' | 'nothing';

/** Gateway failures in a row before the pass gives up until the next tick. */
const MAX_CONSECUTIVE_ERRORS = 3;

export class StagedFiler {
  private running = false;
  /** Barcodes asked for while a pass was already running — handled at the
   *  end of that pass rather than dropped, so a result that lands mid-pass is
   *  still tried straight away. */
  private readonly followUp = new Set<string>();
  /** Both mode: consecutive gateway failures per lane in the current pass.
   *  A lane that reaches MAX_CONSECUTIVE_ERRORS is skipped for the rest of
   *  the pass, while the other lane carries on — a GenX outage must not
   *  stop HINAI filing, and the reverse. */
  private readonly laneFailures = new Map<Lane, number>();
  /** When each fully filed sample was last looked at for GenX certify. */
  private readonly certifyCheckedAt = new Map<string, number>();
  /** Lines skipped for a migrated row — logged once each. */
  private readonly migratedWarned = new Set<string>();

  constructor(private readonly deps: FilerDeps) {}

  /**
   * One pass. `only` limits it to a single barcode (a result just arrived, or
   * the operator pressed "file now"); that barcode is always allowed one live
   * HMIS lookup regardless of the recheck cadence.
   */
  async run(reason: string, only?: string): Promise<FilerReport> {
    const report: FilerReport = { reason, samples: 0, filed: 0, partial: 0, waiting: 0, held: 0, errors: 0, skipped: false };
    if (this.running) {
      // The operator's "File now" is not folded into the next pass under that
      // pass's reason — it would lose what makes it the operator's (D6). It
      // waits for the running pass, then runs as asked.
      if (reason === 'operator' && only) {
        await this.acquire();
      } else {
        if (only) this.followUp.add(only);
        report.skipped = true;
        return report;
      }
    } else {
      this.running = true;
    }
    this.laneFailures.clear();
    try {
      const targets = only ? [this.deps.store.get(only)].filter((s): s is StagedSample => !!s) : this.deps.store.waiting({ certifyGenx: !!this.deps.certify });
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
          // Both mode stops a failing LANE, not the pass (see laneFailures).
          if (!this.deps.lanes && ++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
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
        else if (outcome === 'held') report.held++;
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

  /** Wait until no pass is running, then hold the lock. The check and the
   *  set happen in one turn of the event loop, so two waiters cannot both
   *  take it. */
  private async acquire(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 20));
    this.running = true;
  }

  /** Run `fn` under the filing lock — never alongside a pass (D6: the
   *  console's Force). */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }

  private async fileOne(sample: StagedSample, reason: string, forced: boolean): Promise<SampleOutcome> {
    const { store, log } = this.deps;
    const barcode = sample.barcode;
    const upload = store.pendingUpload(sample, `${barcode}-${Date.now()}`);
    if (upload.results.length === 0) {
      // Everything is filed; only GenX certification may be owed (a certify
      // that failed, or auto-certify switched on later). Looked at no more
      // often than certifyRecheckMs, and never re-posts a result.
      if (this.deps.certify && uncertifiedGenxLines(sample).length) {
        const last = this.certifyCheckedAt.get(barcode) ?? 0;
        if (forced || Date.now() - last >= (this.deps.certifyRecheckMs ?? 15_000)) {
          if (this.certifyCheckedAt.size > 20_000) this.certifyCheckedAt.clear(); // bounded memory
          this.certifyCheckedAt.set(barcode, Date.now());
          await this.retryCertify(sample);
        }
      }
      // Complete, but still labelled with a hold or a wait from before (a
      // lane dropped from config, C3): the label no longer holds.
      if (sample.lastError && (isLaneHold(sample.lastError) || isPatientHold(sample.lastError) || sample.lastError.startsWith('no order row yet'))) {
        store.recordAttempt(barcode, { error: null });
      }
      return 'nothing';
    }

    // ---- paired instruments (Sysmex U-WAM) ---------------------------------
    // One urine tube, two analyzers behind one link. Filing the half that
    // arrived first flips the sample to "result interfaced" in HMIS and the
    // report prints with the other instrument's rows blank, so the sample is
    // held until both have reported or the wait expires. No HMIS call is made
    // while a sample is held, and the operator's "file now" overrides it.
    // Every analyzer that is not the U-WAM has no pairing rule and skips this
    // whole block. See src/results/pairing.ts.
    const pairing = pairingVerdict(sample, this.deps.pairing ?? null);
    if (pairing.hold && reason !== 'operator') {
      if (!wasHeld(sample.lastError)) {
        log.info(
          {
            barcode,
            missing: pairing.missing,
            values: upload.results.length,
            since: sample.firstReceivedAt,
            filesInMs: pairing.remainingMs,
          },
          'holding this sample — the other instrument on this tube has not reported yet',
        );
      }
      store.recordAttempt(barcode, { error: pairing.reason });
      return 'held';
    }
    if (pairing.expired && wasHeld(sample.lastError)) {
      log.warn(
        { barcode, missing: pairing.missing, values: upload.results.length, since: sample.firstReceivedAt },
        'filing without the other instrument — it never reported on this tube within the pairing window',
      );
    }
    if (pairing.hold && reason === 'operator') {
      log.warn(
        { barcode, missing: pairing.missing },
        'operator filed this sample now — going to HMIS without the other instrument on this tube',
      );
    }

    try {
      // A short id keyed on the instrument ("SF0054") is tried under the full
      // barcode it stands for ("SF2608290054") BEFORE anything else — but only
      // moved there if HMIS actually has an order under that barcode. A sample
      // an operator already re-keyed is never completed again.
      let liveLookupUsed = false;
      if (this.deps.completeBarcode && sample.rekeyedFrom === null) {
        const full = this.deps.completeBarcode(barcode, new Date(sample.firstReceivedAt));
        if (full && full !== barcode) {
          let fullRows = await this.deps.orderRows(full, { refresh: false });
          if (fullRows.length === 0 && this.mayRecheck(sample, forced)) {
            fullRows = await this.deps.orderRows(full, { refresh: true });
            liveLookupUsed = true;
          }
          if (fullRows.length > 0) {
            const moved = store.rekey(barcode, full, new Date().toISOString(), 'completion');
            if (moved) return this.fileOne(moved, reason, forced);
          } else if (liveLookupUsed) {
            // Spend this pass's live lookup on the full barcode, not the short
            // one — HMIS never has an order under "SF0054".
            store.recordAttempt(barcode, { error: `no order under ${full} yet (from short id ${barcode})`, checkedHmis: true });
            return 'waiting';
          }
        }
      }

      // Both HMIS mode: filed lane by lane, under the hold rule.
      if (this.deps.lanes) return await this.fileLanes(sample, reason, forced, this.deps.lanes);

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
      if (joined.rounded.length) {
        log.info({ barcode, rounded: joined.rounded }, 'values rounded to whole numbers or fixed decimals before filing');
      }
      if (joined.translated.length) {
        log.info({ barcode, translated: joined.translated }, 'qualitative values reported in the lab\'s words before filing');
      }
      if (joined.scaled.length) {
        log.info({ barcode, scaled: joined.scaled }, 'unit conversion applied before filing');
      }

      // D5 (single GenX lane): a corrected value for an already certified line
      // waits for staff; "File now" sends it.
      let certifiedHold: string | null = null;
      if (this.deps.lane === 'genx' && reason !== 'operator') {
        const split = holdCertifiedLines(joined, sample);
        if (split.blocked.length) {
          joined = split.joined;
          certifiedHold = `GenX result line ${split.blocked.join(', ')} is already certified — the corrected value needs staff; 'File now' sends it`;
          if (sample.lastError !== certifiedHold) log.warn({ barcode, lines: split.blocked, codes: split.codes }, certifiedHold);
        }
      }

      if (joined.rows.length > 0) {
        const res = await this.deps.postResults(joined.rows);
        // GenX: only what it placed is filed (D2), each with its line's code
        // list (D1). HINAI never reports `unmatched`: its rows go as before. A
        // value replaced while the post was in flight stays pending (D6).
        const filed = this.deps.lane === 'genx' ? genxFiled(joined.filedCodes, rows, res.unmatched) : joined.filedCodes;
        store.markFiled(barcode, filed as typeof joined.filedCodes, undefined, this.deps.lane, snapshotOf(sample));
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
      // Single GenX lane with genxAutoCertify: certify each line whose values
      // are now all filed (and retry one that failed on an earlier pass).
      if (this.deps.certify && this.deps.lane === 'genx' && (joined.rows.length > 0 || uncertifiedGenxLines(sample).length)) {
        await this.certifyLines(barcode, rows);
      }

      const after = summarize(store.get(barcode) ?? sample, store.lanes);
      if (after.waiting === 0) {
        store.recordAttempt(barcode, { error: null, checkedHmis: checked });
        return joined.rows.length > 0 ? 'filed' : 'nothing';
      }

      // Still waiting for order rows. Not an error — say so once per change
      // of state rather than on every pass.
      const why = certifiedHold ?? `no order row yet for: ${after.waitingCodes.join(', ')}`;
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

  /**
   * Both HMIS mode: file one sample into HINAI and GenX, each independently.
   *
   * THE HOLD RULE (the lab's requirement, 2026-10): a sample is never filed to
   * one system only on the connector's own initiative. While either lane has
   * no order row at all for the tube, nothing is posted anywhere and the
   * sample says which lane has it; it is re-checked every pass and files the
   * moment both do. There is no timer. Only the operator's "File now" sends
   * it to the lane(s) that have it, marking the values skipped in the other.
   *
   * Once both lanes have the tube, each lane joins its OWN rows (its own
   * labResultIds), posts, is marked and acknowledged on its own. A lane that
   * fails is retried next pass; the other lane's filing is never undone and,
   * because each value remembers the lanes it is filed in, never repeated.
   */
  private async fileLanes(sample: StagedSample, reason: string, forced: boolean, lanes: LaneFilerDeps): Promise<SampleOutcome> {
    const { store, log } = this.deps;
    const barcode = sample.barcode;
    const names = lanes.names;
    const operator = reason === 'operator';
    const may = this.mayRecheck(sample, forced);
    let checked = false;
    const rows = new Map<Lane, MirthAcknowledgeItem[]>();
    const errors = new Map<Lane, string>();
    /** Lanes failing this pass whose CACHED rows were used (D4): no network
     *  call is made to them, and that alone does not make the sample an error. */
    const deferred = new Set<Lane>();
    const refreshed = new Set<Lane>();
    const downNote = (lane: Lane) => `${laneLabel(lane)}: gateway failing — tried again on the next pass`;

    const lookup = async (lane: Lane, refresh: boolean): Promise<void> => {
      if (this.laneDown(lane)) {
        // D4: a lane that is failing this pass is not asked again, but what
        // the cache already knows about the tube still counts.
        try {
          rows.set(lane, await lanes.orderRows(lane, barcode, { refresh: false, cachedOnly: true }));
        } catch {
          rows.set(lane, rows.get(lane) ?? []);
        }
        deferred.add(lane);
        return;
      }
      try {
        rows.set(lane, await lanes.orderRows(lane, barcode, { refresh }));
        if (refresh) {
          refreshed.add(lane);
          checked = true;
        }
        this.laneFailures.set(lane, 0);
      } catch (err) {
        this.laneFailed(lane);
        // Whatever the cache holds still shows whether the lane has the tube.
        if (!rows.has(lane)) {
          try {
            rows.set(lane, await lanes.orderRows(lane, barcode, { refresh: false, cachedOnly: true }));
          } catch {
            rows.set(lane, []);
          }
        }
        // D4: with the tube in the cache this lane is just deferred — the
        // other lane files, this one waits; with nothing cached it is unknown.
        if ((rows.get(lane) ?? []).length) deferred.add(lane);
        else errors.set(lane, `${laneLabel(lane)}: ${errText(err)}`);
      }
    };

    // 1. Each lane's rows: the cache, then a live lookup at the recheck
    //    cadence (or straight away on a first look / for the operator).
    for (const lane of names) {
      await lookup(lane, false);
      if (!errors.has(lane) && !deferred.has(lane) && (rows.get(lane) ?? []).length === 0 && may) await lookup(lane, true);
    }

    // 2a. Patient cross-check (C2): the two systems must name the same
    //     patient for this barcode. Nothing — not File now, not Force —
    //     files a sample while they differ; re-checked every pass, and again
    //     right before every post (D8).
    const mismatchHold = (): SampleOutcome | null => {
      const mismatch = this.deps.patientMismatch?.(barcode) ?? null;
      if (!mismatch) return null;
      if ((store.get(barcode) ?? sample).lastError !== mismatch) log.warn({ barcode, reason }, mismatch);
      store.recordAttempt(barcode, { error: mismatch, checkedHmis: checked });
      return 'held';
    };
    const held0 = mismatchHold();
    if (held0) return held0;

    const has = (lane: Lane) => (rows.get(lane) ?? []).length > 0;
    const missing = names.filter((l) => !has(l) && !errors.has(l) && !deferred.has(l));
    const unknown = names.filter((l) => !has(l) && (errors.has(l) || deferred.has(l)));

    // 2b. The hold rule.
    if (missing.length || unknown.length) {
      if (unknown.length && !operator) {
        // A lane could not be asked and its cache knows nothing about the
        // tube: whether it has it is not known, so the hold rule cannot be
        // judged — try again next pass.
        const message = unknown.map((l) => errors.get(l) ?? downNote(l)).join('; ');
        store.recordAttempt(barcode, { error: message, checkedHmis: checked });
        log.warn({ barcode, err: message, reason }, 'filing failed for this sample — an HMIS lane could not be asked; will retry on the next pass');
        return 'error';
      }
      const present = names.filter(has);
      if (!operator || present.length === 0) {
        const why = present.length
          ? `order only in ${present.map(laneLabel).join(' + ')} — waiting for ${missing.map(laneLabel).join(' + ')}; "File now" sends it to ${present.map(laneLabel).join(' + ')} only`
          : `order in neither ${names.map(laneLabel).join(' nor ')} yet — waiting for both`;
        if (sample.lastError !== why) {
          log.info(
            { barcode, in: present, waitingFor: missing, values: store.pendingUpload(sample, '').results.length, checkedHmis: checked },
            'holding this sample — both HMIS systems must have the order before it is filed to either',
          );
        }
        store.recordAttempt(barcode, { error: why, checkedHmis: checked });
        return 'held';
      }
    }

    // 3. File each lane that has the tube, on its own rows.
    let filedAny = false;
    let notedDrops = false;
    let postedGenx = false;
    let certifiedHold: string | null = null;
    for (const lane of names) {
      let laneRows = rows.get(lane) ?? [];
      if (!laneRows.length) continue;
      const current = store.get(barcode) ?? sample;
      const upload = store.pendingUploadFor(current, `${barcode}-${lane}-${Date.now()}`, lane);
      if (!upload.results.length) continue;
      const snapshot = snapshotOf(current);
      let joined = this.deps.join(upload, laneRows, lane);
      if (joined.unmatched.length > 0 && may && !refreshed.has(lane) && !deferred.has(lane) && !errors.has(lane)) {
        await lookup(lane, true);
        if (refreshed.has(lane)) {
          laneRows = rows.get(lane) ?? laneRows;
          joined = this.deps.join(upload, laneRows, lane);
        }
      }
      // Dropped codes are a property of the code, not the lane: noted once.
      if (!notedDrops) {
        notedDrops = true;
        if (joined.ignored.length) store.markDropped(barcode, joined.ignored, 'ignored');
        if (joined.voided.length) {
          store.markDropped(barcode, joined.voided, 'void');
          log.warn({ barcode, voided: joined.voided }, 'analyzer reported no value for these assays — not filed; the rerun will file');
        }
      }
      if (joined.scaled.length) log.info({ barcode, lane, scaled: joined.scaled }, 'unit conversion applied before filing');
      // D5: a corrected value for a GenX line that is already certified is
      // not sent on the connector's own initiative.
      if (lane === 'genx' && !operator) {
        const split = holdCertifiedLines(joined, current);
        joined = split.joined;
        if (split.blocked.length) {
          certifiedHold = `GenX result line ${split.blocked.join(', ')} is already certified — the corrected value needs staff; 'File now' sends it`;
          if (sample.lastError !== certifiedHold) log.warn({ barcode, lines: split.blocked, codes: split.codes }, certifiedHold);
        }
      }
      if (!joined.rows.length) continue;
      if (deferred.has(lane) || this.laneDown(lane)) {
        deferred.add(lane); // D4: left pending, not an error by itself
        continue;
      }
      // D8: the patient check again, right before anything is posted.
      const heldNow = mismatchHold();
      if (heldNow) return heldNow;

      let res: { filed: number; message: string; unmatched?: string[] };
      try {
        res = await lanes.postResults(lane, joined.rows);
        this.laneFailures.set(lane, 0);
      } catch (err) {
        this.laneFailed(lane);
        errors.set(lane, `${laneLabel(lane)}: ${errText(err)}`);
        log.warn(
          { barcode, lane, err: errText(err), reason },
          'filing failed in this HMIS lane — the other lane is not affected; this one is retried on the next pass',
        );
        continue;
      }
      const filed = lane === 'genx' ? genxFiled(joined.filedCodes, laneRows, res.unmatched) : joined.filedCodes;
      store.markLaneFiled(barcode, lane, filed, names, undefined, { expect: snapshot });
      filedAny = true;
      log.info(
        { barcode, lane, filed: res.filed, sent: joined.rows.length, stillWaiting: joined.unmatched, unplaced: res.unmatched?.length ? res.unmatched : undefined, message: res.message, reason },
        'results filed to HMIS',
      );
      // Acknowledge LAST, and never fatally: the values are already saved.
      try {
        await lanes.acknowledge(lane, joined.matched);
        log.info({ barcode, lane, rows: joined.matched.length }, 'pending rows acknowledged after filing');
      } catch (err) {
        log.error(
          { barcode, lane, rows: joined.matched.length, err: errText(err) },
          'acknowledge failed AFTER results were filed — rows stay pending and may be downloaded again',
        );
      }
      if (lane === 'genx' && this.deps.certify) {
        postedGenx = true;
        await this.certifyLines(barcode, laneRows);
      }
    }

    // GenX lines still owed a certify (an earlier failure), nothing new posted.
    const genxRows = rows.get('genx') ?? [];
    if (this.deps.certify && !postedGenx && !deferred.has('genx') && !errors.has('genx') && genxRows.length && uncertifiedGenxLines(store.get(barcode) ?? sample).length) {
      await this.certifyLines(barcode, genxRows);
    }

    // 4. "File now" closes the sample (B2, D3): in a lane with no order for
    //    the tube every value is skipped; in a lane that has the tube, only a
    //    value with NO row at all for its code is skipped. A withheld value
    //    (its row excluded in config) or an ambiguous one (two candidate rows)
    //    keeps waiting, as in single mode. A lane that failed this pass is
    //    left alone — it is retried, not skipped. (A tube in neither lane
    //    stayed held above.)
    if (operator) {
      for (const lane of names) {
        if (errors.has(lane) || deferred.has(lane)) continue;
        const laneRows = rows.get(lane) ?? [];
        const current = store.get(barcode) ?? sample;
        const codes = store
          .pendingUploadFor(current, '', lane)
          .results.map((r) => r.testCode)
          .filter((code) => !laneRows.length || !(this.deps.hasRowFor?.(laneRows, code) ?? false));
        if (!codes.length) continue;
        store.markLaneFiled(barcode, lane, codes.map((testCode) => ({ testCode, identifier: null, labResultId: null })), names, undefined, { skipped: 'operator' });
        log.warn(
          { barcode, lane, values: codes, tubeInLane: has(lane) },
          has(lane)
            ? 'operator filed this sample now — this HMIS system has no order row for these values, so they were NOT sent there and count as done for it'
            : 'operator filed this sample now — this HMIS system has no order for it, so these values were NOT sent there and count as done for it',
        );
      }
    }

    const after = summarize(store.get(barcode) ?? sample, store.lanes);
    if (errors.size) {
      const message = [...errors.values()].join('; ');
      store.recordAttempt(barcode, { error: message, checkedHmis: checked });
      return 'error';
    }
    if (after.waiting === 0) {
      store.recordAttempt(barcode, { error: null, checkedHmis: checked });
      return filedAny ? 'filed' : 'nothing';
    }
    const now = store.get(barcode) ?? sample;
    const perLane = names
      .filter((l) => !deferred.has(l))
      .map((l) => [l, store.pendingUploadFor(now, '', l).results.map((r) => r.testCode)] as const)
      .filter(([, codes]) => codes.length)
      .map(([l, codes]) => `${codes.join(', ')} (${laneLabel(l)})`);
    const why =
      certifiedHold ??
      [perLane.length ? `no order row yet for: ${perLane.join('; ')}` : '', ...[...deferred].map(downNote)].filter(Boolean).join('; ');
    if (sample.lastError !== why) {
      log.info(
        { barcode, waiting: after.waitingCodes, filed: after.filed, deferred: [...deferred], checkedHmis: checked },
        'results waiting for their HMIS order — will file when the order appears',
      );
    }
    store.recordAttempt(barcode, { error: why || null, checkedHmis: checked });
    return filedAny ? 'partial' : 'waiting';
  }

  /**
   * GenX auto-certify. A GenX result line (labResultId on the GenX rows =
   * GenX sampleLineId) is certified once EVERY code the line expands to —
   * its full list from the worklist (`lineCodes`, D1), not only the rows that
   * survived de-duplication and the interface filter — has a value filed in
   * GenX under THAT line's id. Never a partly filed line, never a line with a
   * code GenX could not place (D2), never a line behind a migrated row (C1),
   * never twice. A failure is kept and tried again next pass; it never
   * un-files anything.
   */
  private async certifyLines(barcode: string, genxRows: MirthAcknowledgeItem[]): Promise<void> {
    const certify = this.deps.certify;
    if (!certify) return;
    const { store, log } = this.deps;
    const s = store.get(barcode);
    if (!s) return;
    const done = new Set(s.certified?.genx ?? []);
    const byLine = new Map<number, MirthAcknowledgeItem[]>();
    for (const r of genxRows) {
      if (r.labResultId === null || r.labResultId === undefined) continue;
      if (r.source && r.source !== 'genx') continue;
      const list = byLine.get(r.labResultId) ?? [];
      list.push(r);
      byLine.set(r.labResultId, list);
    }
    const k = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
    const values = Object.values(s.values);
    const once = (key: string, ctx: Record<string, unknown>, msg: string) => {
      if (this.migratedWarned.has(key)) return;
      this.migratedWarned.add(key);
      log.warn(ctx, msg);
    };
    for (const [lineId, lineRows] of byLine) {
      if (done.has(lineId)) continue;
      // A line backed by a row the C1 migration tagged (not by a GenX
      // response) is never certified: certification cannot be undone, and
      // that attribution was inferred. Left for HMIS staff.
      if (lineRows.some((r) => r.migrated)) {
        once(`${barcode}#${lineId}#m`, { barcode, lineId }, 'GenX line not auto-certified — its order row predates HMIS lanes; certify it in GenX by hand');
        continue;
      }
      const listed = lineRows.flatMap((r) => r.lineCodes ?? []);
      const codes = [...new Set((listed.length ? listed : lineRows.map((r) => r.identifier)).map(k))].filter(Boolean);
      // A code of the line that this tube's GenX rows do not carry under it
      // (outside the interface, or filed under another line) can never be
      // filed here: the line is left for staff.
      const carried = new Set(lineRows.map((r) => k(r.identifier)));
      const never = codes.filter((c) => !carried.has(c));
      if (never.length) {
        once(`${barcode}#${lineId}#n`, { barcode, lineId, codes: never }, 'GenX line not auto-certified — part of it is not filed by this interface; certify it in GenX by hand');
        continue;
      }
      const ready = codes.every((code) =>
        values.some((v) => {
          const e = v.lanes?.genx;
          return !!e?.filedAt && !e.skipped && e.labResultId === lineId && k(e.identifier) === code;
        }),
      );
      if (!ready) continue;
      try {
        await certify(lineId, barcode);
        store.markCertified(barcode, lineId);
        log.info({ barcode, lineId }, 'GenX result line certified — every value of it is filed in GenX');
      } catch (err) {
        store.recordCertifyFailure(barcode, lineId, errText(err));
        log.warn({ barcode, lineId, err: errText(err) }, 'GenX certify failed — the values stay filed; tried again on the next pass');
      }
    }
  }

  /** A sample with nothing left to file but a GenX certify still owed. */
  private async retryCertify(sample: StagedSample): Promise<void> {
    try {
      const rows = this.deps.lanes
        ? await this.deps.lanes.orderRows('genx', sample.barcode, { refresh: false })
        : await this.deps.orderRows(sample.barcode, { refresh: false });
      await this.certifyLines(sample.barcode, rows);
    } catch (err) {
      this.deps.log.warn({ barcode: sample.barcode, err: errText(err) }, 'GenX certify retry could not read the order rows — tried again on the next pass');
    }
  }

  private laneDown(lane: Lane): boolean {
    return (this.laneFailures.get(lane) ?? 0) >= MAX_CONSECUTIVE_ERRORS;
  }

  private laneFailed(lane: Lane): void {
    const n = (this.laneFailures.get(lane) ?? 0) + 1;
    this.laneFailures.set(lane, n);
    if (n === MAX_CONSECUTIVE_ERRORS) {
      this.deps.log.warn({ lane, consecutiveErrors: n }, 'HMIS lane failing — skipped for the rest of this filing pass; the other lane carries on');
    }
  }

  private mayRecheck(sample: StagedSample, forced: boolean): boolean {
    if (sample.lastCheckedAt === null) return true; // first look at this barcode
    if (forced) return true;
    return Date.now() - Date.parse(sample.lastCheckedAt) >= this.deps.recheckMs;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const codeOf = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * What the GenX lane may mark filed after a post (D2): not the codes GenX
 * reported it could not place — they stay pending and are sent again — and
 * each carries its line's full code list and migrated flag for certify (D1).
 */
export function genxFiled(
  filedCodes: JoinResult['filedCodes'],
  rows: MirthAcknowledgeItem[],
  unmatched: string[] | undefined,
): FiledValue[] {
  const unplaced = new Set((unmatched ?? []).map(codeOf));
  return filedCodes
    .filter((f) => !unplaced.has(codeOf(f.identifier)))
    .map((f) => {
      const line = f.labResultId === null ? [] : rows.filter((r) => r.labResultId === f.labResultId);
      const codes = [...new Set(line.flatMap((r) => r.lineCodes ?? []))];
      const out: FiledValue = { ...f };
      if (codes.length) out.lineCodes = codes;
      if (line.some((r) => r.migrated)) out.migrated = true;
      return out;
    });
}

/**
 * D5: keep a value for a GenX line that is ALREADY certified out of an
 * automatic post — a certified result corrected behind staff's back is
 * their call. The rows, filedCodes and matched lists stay in lockstep.
 */
function holdCertifiedLines(joined: JoinResult, sample: StagedSample): { joined: JoinResult; blocked: number[]; codes: string[] } {
  const certified = new Set(sample.certified?.genx ?? []);
  if (!certified.size) return { joined, blocked: [], codes: [] };
  const keep = joined.rows.map((r) => !(r.labResultId != null && certified.has(r.labResultId)));
  if (keep.every(Boolean)) return { joined, blocked: [], codes: [] };
  const blocked = [...new Set(joined.rows.filter((_, i) => !keep[i]).map((r) => r.labResultId as number))];
  const codes = joined.filedCodes.filter((_, i) => !keep[i]).map((f) => f.testCode);
  const keptLines = new Set(joined.rows.filter((_, i) => keep[i]).map((r) => r.labResultId));
  return {
    joined: {
      ...joined,
      rows: joined.rows.filter((_, i) => keep[i]),
      filedCodes: joined.filedCodes.filter((_, i) => keep[i]),
      matched: joined.matched.filter((m) => !(m.labResultId != null && certified.has(m.labResultId)) || keptLines.has(m.labResultId)),
    },
    blocked,
    codes,
  };
}
