import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Logger } from '../logger.js';
import type { HmisResultUpload } from '../types.js';
import { safeSpoolId } from '../queue/spool.js';
import { normalizeBarcode } from '../mapping/mapper.js';
import type { Lane } from '../hmis/lanes.js';

// =============================================================================
// ResultStore — the per-sample result store behind `filing.mode: "staged"`.
//
// This is the retired middleware's `equipment_data` table rebuilt on files.
// That app wrote every value it received into a row keyed on sample ID + test
// ID + machine, with no check that an order existed, and a separate pass later
// joined those rows to whatever orders HMIS had by then. The two properties
// the lab relied on fall out of that shape, and this store keeps both:
//
//   * a value is never lost or parked — it sits here until it files or ages
//     out, and a sample run before its order was raised files when the order
//     appears;
//   * samples are independent — one sample with no order cannot hold up the
//     next one, because there is no queue, only a set of files to walk.
//
// One JSON file per barcode under spool/<analyzer>/results/. A re-transmitted
// message with the same values changes nothing; a rerun with a different value
// replaces it and marks it unfiled again so the correction goes out. A
// mistyped barcode is fixed with `rekey`, the equivalent of the old app's
// "UPDATE equipment_data SET sample_ID = …".
// =============================================================================

export interface StagedValue {
  testCode: string;
  value: string;
  unit: string | null;
  abnormalFlag: string | null;
  status: string | null;
  completedAt: string | null;
  receivedAt: string;
  /** When HMIS accepted it; null while it is still waiting for an order row. */
  filedAt: string | null;
  /** The instrument that produced this value, when the message named one
   *  (ASTM R field 14). Only the Sysmex U-WAM link populates it here: it
   *  fronts a UC-3500 and a UF-4000 that share one tube, so the filing pass
   *  needs to know which of the two a value came from. Null everywhere else. */
  instrument: string | null;
  /** The pending row it was filed against, for tracing. */
  identifier: string | null;
  labResultId: number | null;
  /** Set when the value will never be filed: a non-interfaced code, or a
   *  placeholder the analyzer sent instead of a number. Not counted as
   *  waiting. */
  dropped: 'ignored' | 'void' | null;
  /** Per-lane filing state (src/hmis/lanes.ts). `filedAt` above keeps its
   *  meaning — DONE — and is set once the value is filed (or skipped by the
   *  operator) in EVERY lane of the analyzer. In single mode this is set
   *  alongside filedAt and changes nothing. A rerun that replaces the value
   *  starts it with no lanes, so the correction goes to every lane again. */
  lanes?: Partial<Record<Lane, LaneFiling>>;
}

export interface LaneFiling {
  filedAt: string | null;
  identifier: string | null;
  labResultId: number | null;
  /** The operator filed the sample with this lane holding no order for it
   *  ("File now" on a held sample) — counted done for the lane, never sent. */
  skipped?: 'operator';
  /** GenX only: the full code list of the result line it was filed under
   *  (addendum D1) — what that line needs filed before it is certified. */
  lineCodes?: string[];
  /** Filed against a row the C1 migration attributed — its line is never
   *  auto-certified. */
  migrated?: boolean;
}

/** One value just filed, as the filer reports it to the store. */
export interface FiledValue {
  testCode: string;
  identifier: string | null;
  labResultId: number | null;
  lineCodes?: string[];
  migrated?: boolean;
}

/** The value and receipt time each code had when its upload was built. A
 *  value replaced by a rerun while the post was in flight no longer matches
 *  and is not marked (addendum D6): it goes out on the next pass. */
export type UploadSnapshot = Record<string, { value: string; receivedAt: string }>;

export function snapshotOf(s: StagedSample): UploadSnapshot {
  const out: UploadSnapshot = {};
  for (const v of Object.values(s.values)) out[v.testCode] = { value: v.value, receivedAt: v.receivedAt };
  return out;
}

function unchangedSince(v: StagedValue, snap: UploadSnapshot | undefined): boolean {
  if (!snap) return true;
  const was = snap[v.testCode];
  return !!was && was.value === v.value && was.receivedAt === v.receivedAt;
}

export interface StagedSample {
  /** Canonical (uppercase) barcode — the store key and what HMIS is asked for. */
  barcode: string;
  eqCode: string;
  equipmentId: string | number | null;
  isQc: boolean;
  firstReceivedAt: string;
  updatedAt: string;
  /** Last filing pass that looked at this sample, whatever the outcome. */
  lastAttemptAt: string | null;
  /** Last time HMIS itself was asked for this barcode's rows (not the poll). */
  lastCheckedAt: string | null;
  /** Why the last pass could not finish it — "no order row yet for …" or a
   *  gateway error. Null once it files. */
  lastError: string | null;
  attempts: number;
  /** The barcode this sample was moved from by an operator, if any. */
  rekeyedFrom: string | null;
  /** Keyed on the analyzer's own test code, exactly as it was sent. */
  values: Record<string, StagedValue>;
  /** Last raw frame received for this sample, for the gateway's message log. */
  raw: string | null;
  /** GenX result lines (labResultId = GenX sampleLineId) already certified
   *  for this tube — never certified twice. */
  certified?: { genx: number[] };
  /** GenX lines whose certify call failed; the sample stays in the filing
   *  pass until they succeed. */
  certifyFailed?: { genx: number[]; error: string | null; at: string | null };
}

export interface StagedCounts {
  /** Samples with at least one value still waiting for an order row. */
  waiting: number;
  /** Samples where every value has filed or been dropped. */
  complete: number;
}

export interface StagedSummary {
  barcode: string;
  isQc: boolean;
  firstReceivedAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  attempts: number;
  rekeyedFrom: string | null;
  total: number;
  filed: number;
  waiting: number;
  dropped: number;
  waitingCodes: string[];
  /** Waiting values the connector holds back on purpose: HMIS offers a row
   *  for the code, but every such row is excluded in config (the smear row
   *  HMIS named "PCT"). They will not file until the HMIS master is fixed, so
   *  the console shows them as withheld, not as waiting for an order. Filled
   *  in by the analyzer runtime; the store alone cannot know. */
  withheld?: number;
  withheldCodes?: string[];
  complete: boolean;
  /** Both HMIS mode only (filled in by the analyzer runtime): per-lane counts
   *  of this sample's interfaced values. */
  lanes?: LaneCounts[];
  /** Both HMIS mode only: the sample is held because its tube is in only
   *  some lanes (`in`), waiting for the rest — lane names, which the page
   *  spells ("held: only in HINAI"). Null when it is not held. */
  held?: { in: Lane[]; waitingFor: Lane[] } | { mismatch: { hinai: string; genx: string } } | null;
  /** The interfaced parameters of this sample, in the order received — what
   *  the console lists under the barcode. Values the interface is not scoped
   *  to (dropped as "ignored") are left out; a void placeholder is shown so
   *  the lab can see the analyzer withheld that value. */
  values: StagedValueView[];
}

export interface StagedValueView {
  testCode: string;
  value: string;
  unit: string | null;
  abnormalFlag: string | null;
  /** "filed" — accepted by HMIS; "waiting" — no order row yet; "void" — the
   *  analyzer sent a placeholder instead of a number. */
  state: 'filed' | 'waiting' | 'void' | 'withheld';
  /** Why a value is withheld — shown beside it. */
  note?: string;
  filedAt: string | null;
  /** The HMIS identifier it was filed against, once filed. */
  identifier: string | null;
}

export interface UpsertResult {
  sample: StagedSample;
  /** Codes that are new or whose value changed — what this message added. */
  changed: string[];
  /** Codes already held with the same value — a re-transmit. */
  unchanged: string[];
}

/**
 * Is this value done? `filedAt` says so, and so does an entry in EVERY lane
 * the analyzer uses NOW. The second half matters after a switch from both
 * HMIS mode to single (addendum B3): a value filed in HINAI and still owed to
 * GenX is done once GenX is no longer one of the lanes — it must not be
 * re-posted to HINAI, nor waited for. With no lanes given (or values with no
 * lane entries, everything written before lanes existed) this is `filedAt`
 * alone, exactly as before.
 */
export function isFiled(v: StagedValue, lanes?: readonly Lane[]): boolean {
  if (v.filedAt !== null) return true;
  return !!lanes && lanes.length > 0 && lanes.every((l) => !!v.lanes?.[l]?.filedAt);
}

function isWaiting(v: StagedValue, lanes?: readonly Lane[]): boolean {
  return v.dropped === null && !isFiled(v, lanes);
}

/**
 * The instruments this sample has heard from, upper-cased for comparison.
 *
 * Read only by the U-WAM pairing gate (src/results/pairing.ts). Every value is
 * counted, filed or not: once the UC-3500 half of a tube has been filed, a
 * later rerun of a UF-4000 parameter must not re-open the wait for a strip
 * result that has already been and gone.
 */
export function devicesOf(s: StagedSample): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(s.values)) {
    if (v.dropped === 'ignored') continue;
    const d = (v.instrument ?? '').trim();
    if (d) out.add(d.toUpperCase());
  }
  return out;
}

export interface LaneCounts {
  lane: Lane;
  /** Filed in this lane (operator skips not counted). */
  filed: number;
  /** Not yet filed in this lane. */
  waiting: number;
  /** Released by the operator with this lane holding no order. */
  skipped: number;
}

/** GenX lines (labResultId) this sample has values filed against in GenX
 *  but has not certified yet. Whether a line is COMPLETE needs its order
 *  rows; the filer decides that. */
export function uncertifiedGenxLines(s: StagedSample): number[] {
  const done = new Set(s.certified?.genx ?? []);
  const k = (c: string | null | undefined) => (c ?? '').trim().toUpperCase();
  const byLine = new Map<number, LaneFiling[]>();
  for (const v of Object.values(s.values)) {
    const e = v.lanes?.genx;
    if (!e?.filedAt || e.skipped || e.labResultId === null || done.has(e.labResultId)) continue;
    const list = byLine.get(e.labResultId) ?? [];
    list.push(e);
    byLine.set(e.labResultId, list);
  }
  // Only lines that CAN certify (addendum D7): every code of the line filed
  // under it. A line whose code list is not known (filed before D1) is judged
  // by the codes filed under it.
  //
  // A value filed while its row was still a C1-migrated copy is NOT excluded
  // here: once GenX itself sends that row (same line id), the line may
  // certify. Whether it may is decided by certifyLines() against the CURRENT
  // GenX rows — it refuses while any row of the line is still migrated and
  // requires the filed line id to match. The revisit this costs reads only
  // the local order cache, at most once per certifyRecheckMs.
  const out: number[] = [];
  for (const [line, entries] of byLine) {
    const codes = new Set(entries.flatMap((e) => e.lineCodes ?? [e.identifier ?? '']).map(k));
    const have = new Set(entries.map((e) => k(e.identifier)));
    if ([...codes].every((c) => c && have.has(c))) out.push(line);
  }
  return out;
}

/** The patient-mismatch `lastError` the filer writes (addendum C2). */
export function isPatientHold(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.startsWith('patient differs between ');
}

/** The lane-hold `lastError` the filer writes (src/results/filer.ts). */
export function isLaneHold(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && /^order (only in|in neither) /.test(lastError);
}

/** Per-lane counts for one sample. A value filed before lanes existed (no
 *  `lanes`) counts as filed in a single-lane analyzer's lane. */
export function laneCounts(s: StagedSample, lanes: readonly Lane[]): LaneCounts[] {
  // A value complete before a lane was added (filedAt set, no entry for it)
  // counts as done in that lane: it is never sent there (addendum B1).
  const values = Object.values(s.values).filter((v) => v.dropped === null);
  return lanes.map((lane) => {
    let filed = 0;
    let waiting = 0;
    let skipped = 0;
    for (const v of values) {
      const e = v.lanes?.[lane];
      if (e?.skipped) skipped++;
      else if (e?.filedAt || v.filedAt) filed++;
      else waiting++;
    }
    return { lane, filed, waiting, skipped };
  });
}

export function summarize(s: StagedSample, lanes?: readonly Lane[]): StagedSummary {
  // Channels the interface is not scoped to are not part of the sample: they
  // are filtered before intake now, and a sample stored before that filter
  // existed still shows as "x of 22", not "x of 60".
  const values = Object.values(s.values).filter((v) => v.dropped !== 'ignored');
  const waiting = values.filter((v) => isWaiting(v, lanes));
  const filed = values.filter((v) => isFiled(v, lanes)).length;
  const dropped = values.filter((v) => v.dropped !== null).length;
  return {
    barcode: s.barcode,
    isQc: s.isQc,
    firstReceivedAt: s.firstReceivedAt,
    updatedAt: s.updatedAt,
    lastAttemptAt: s.lastAttemptAt,
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.lastError,
    attempts: s.attempts,
    rekeyedFrom: s.rekeyedFrom,
    total: values.length,
    filed,
    waiting: waiting.length,
    dropped,
    waitingCodes: waiting.map((v) => v.testCode),
    complete: waiting.length === 0,
    values: values
      .filter((v) => v.dropped !== 'ignored')
      .map((v) => ({
        testCode: v.testCode,
        value: v.value,
        unit: v.unit,
        abnormalFlag: v.abnormalFlag,
        state: isFiled(v, lanes) ? 'filed' : v.dropped === 'void' ? 'void' : 'waiting',
        filedAt: v.filedAt,
        identifier: v.identifier,
      })),
  };
}

export class ResultStore {
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    /** The analyzer's CURRENT HMIS lanes — see isFiled. Omitted = filedAt
     *  alone decides, as before lanes existed. */
    readonly lanes?: readonly Lane[],
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Fold a message's values for one sample into the store. */
  upsert(upload: HmisResultUpload, receivedAt = new Date().toISOString()): UpsertResult {
    const barcode = normalizeBarcode(upload.barcode);
    const existing = this.get(barcode);
    const sample: StagedSample = existing ?? {
      barcode,
      eqCode: upload.eqCode,
      equipmentId: upload.equipmentId ?? null,
      isQc: upload.isQc ?? false,
      firstReceivedAt: receivedAt,
      updatedAt: receivedAt,
      lastAttemptAt: null,
      lastCheckedAt: null,
      lastError: null,
      attempts: 0,
      rekeyedFrom: null,
      values: {},
      raw: null,
    };

    // Values a previous build stored for channels outside the interface are
    // dead weight: forget them on the first re-transmit or rerun.
    let pruned = 0;
    for (const [code, v] of Object.entries(sample.values)) {
      if (v.dropped === 'ignored') {
        delete sample.values[code];
        pruned += 1;
      }
    }

    const changed: string[] = [];
    const unchanged: string[] = [];
    /** A re-transmit that carries no new value can still carry something the
     *  store did not have: the unit, or the name of the instrument that
     *  produced it. Worth a write — the unit reaches the patient report, and
     *  the instrument name is what the U-WAM pairing gate reads. */
    let learned = false;
    for (const r of upload.results) {
      const have = sample.values[r.testCode];
      const unit = r.unit ?? null;
      const instrument = (r.instrument ?? '').trim() || null;
      if (have && have.value === r.value && (have.unit === unit || have.unit === null)) {
        // The same value again. A held value with no unit (restored from the
        // HMIS transaction log, which does not carry one) learns the unit from
        // the analyzer's own transmission without becoming unfiled — the ECi
        // re-sent exactly such a sample at 12:36 on 19 Sep 2026, and treating
        // it as a change would have re-posted a result HMIS already had.
        if (have.unit === null && unit !== null) {
          have.unit = unit;
          learned = true;
        }
        if (instrument && have.instrument !== instrument) {
          have.instrument = instrument;
          learned = true;
        }
        unchanged.push(r.testCode);
        continue;
      }
      // New, or a rerun with a different number: (re)file it. A previous
      // filing is deliberately forgotten — the correction must go out.
      sample.values[r.testCode] = {
        testCode: r.testCode,
        value: r.value,
        unit,
        abnormalFlag: r.abnormalFlag ?? null,
        status: r.status ?? null,
        completedAt: r.completedAt ?? null,
        receivedAt,
        filedAt: null,
        instrument: instrument ?? have?.instrument ?? null,
        identifier: null,
        labResultId: null,
        dropped: null,
      };
      changed.push(r.testCode);
    }

    if (changed.length || pruned || learned || !existing) {
      sample.updatedAt = receivedAt;
      sample.raw = upload.raw ?? sample.raw;
      // A new value re-opens the sample: the last error described a state
      // that no longer holds.
      if (changed.length) sample.lastError = null;
      this.write(sample);
    }
    return { sample, changed, unchanged };
  }

  get(barcode: string): StagedSample | null {
    return this.read(this.pathOf(barcode));
  }

  /** Every sample, newest activity first. */
  list(): StagedSample[] {
    const out: StagedSample[] = [];
    for (const f of this.files()) {
      const s = this.read(join(this.dir, f));
      if (s) out.push(s);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  summaries(): StagedSummary[] {
    return this.list().map((s) => summarize(s, this.lanes));
  }

  /** Samples with something left to file, oldest first — the filing order.
   *  With `certifyGenx` (GenX auto-certify on) a fully filed sample whose
   *  GenX lines are not all certified stays in it too — a certify that
   *  failed, or auto-certify switched on after the values were filed. */
  waiting(opts: { certifyGenx?: boolean } = {}): StagedSample[] {
    return this.list()
      .filter((s) => Object.values(s.values).some((v) => isWaiting(v, this.lanes)) || (opts.certifyGenx === true && uncertifiedGenxLines(s).length > 0))
      .sort((a, b) => (a.firstReceivedAt < b.firstReceivedAt ? -1 : a.firstReceivedAt > b.firstReceivedAt ? 1 : 0));
  }

  counts(): StagedCounts {
    let waiting = 0;
    let complete = 0;
    for (const s of this.list()) {
      if (Object.values(s.values).some((v) => isWaiting(v, this.lanes))) waiting++;
      else complete++;
    }
    return { waiting, complete };
  }

  /** The values still to be filed, in the shape the join wants. */
  pendingUpload(sample: StagedSample, messageId: string): HmisResultUpload {
    return this.uploadOf(sample, messageId, (v) => isWaiting(v, this.lanes));
  }

  /** Both mode: the values still to be filed in ONE lane — not done, not
   *  dropped, and not yet filed (or skipped) in that lane. */
  pendingUploadFor(sample: StagedSample, messageId: string, lane: Lane): HmisResultUpload {
    return this.uploadOf(sample, messageId, (v) => isWaiting(v, this.lanes) && !v.lanes?.[lane]?.filedAt);
  }

  /** Every interfaced value the sample holds, filed or not — what the console's
   *  "Force" push sends. Void placeholders and non-interfaced codes stay out. */
  forceUpload(sample: StagedSample, messageId: string): HmisResultUpload {
    return this.uploadOf(sample, messageId, (v) => v.dropped === null);
  }

  private uploadOf(sample: StagedSample, messageId: string, pick: (v: StagedValue) => boolean): HmisResultUpload {
    const results = Object.values(sample.values)
      .filter(pick)
      .map((v) => ({
        testCode: v.testCode,
        value: v.value,
        unit: v.unit,
        abnormalFlag: v.abnormalFlag,
        status: v.status ?? 'F',
        completedAt: v.completedAt,
      }));
    return {
      equipmentId: sample.equipmentId,
      eqCode: sample.eqCode,
      barcode: sample.barcode,
      isQc: sample.isQc,
      results,
      raw: sample.raw ?? undefined,
      messageId,
    };
  }

  markFiled(
    barcode: string,
    filed: Array<{ testCode: string; identifier: string; labResultId: number | null; lineCodes?: string[]; migrated?: boolean }>,
    at = new Date().toISOString(),
    /** Single mode: the analyzer's one lane, recorded beside filedAt. */
    lane?: Lane,
    /** The values as uploaded; a value changed since is left pending. */
    expect?: UploadSnapshot,
  ): void {
    const s = this.get(barcode);
    if (!s) return;
    for (const f of filed) {
      const v = s.values[f.testCode];
      if (!v || !unchangedSince(v, expect)) continue;
      v.filedAt = at;
      v.identifier = f.identifier;
      v.labResultId = f.labResultId;
      v.dropped = null;
      if (lane) {
        const entry: LaneFiling = { filedAt: at, identifier: f.identifier, labResultId: f.labResultId };
        if (f.lineCodes) entry.lineCodes = f.lineCodes;
        if (f.migrated) entry.migrated = true;
        v.lanes = { ...(v.lanes ?? {}), [lane]: entry };
      }
    }
    s.lastError = null;
    s.updatedAt = at;
    this.write(s);
  }

  /**
   * Both mode: these values are now filed in ONE lane. A value becomes done
   * (`filedAt`) only once every lane in `all` has it — filed, or skipped by
   * the operator. The top-level identifier / labResultId follow the first
   * lane, for tracing.
   */
  markLaneFiled(
    barcode: string,
    lane: Lane,
    filed: FiledValue[],
    all: readonly Lane[],
    at = new Date().toISOString(),
    opts: { skipped?: 'operator'; expect?: UploadSnapshot } = {},
  ): void {
    const s = this.get(barcode);
    if (!s) return;
    for (const f of filed) {
      const v = s.values[f.testCode];
      if (!v || !unchangedSince(v, opts.expect)) continue;
      const entry: LaneFiling = { filedAt: at, identifier: f.identifier, labResultId: f.labResultId };
      if (opts.skipped) entry.skipped = opts.skipped;
      if (f.lineCodes) entry.lineCodes = f.lineCodes;
      if (f.migrated) entry.migrated = true;
      v.lanes = { ...(v.lanes ?? {}), [lane]: entry };
      v.dropped = null;
      if (all.every((l) => v.lanes?.[l]?.filedAt)) {
        v.filedAt = at;
        const first = all.map((l) => v.lanes?.[l]).find((e) => e && !e.skipped) ?? null;
        v.identifier = first?.identifier ?? null;
        v.labResultId = first?.labResultId ?? null;
      }
    }
    s.updatedAt = at;
    this.write(s);
  }

  /**
   * Addendum C3, run once at start: a value filed in every lane the analyzer
   * uses NOW but still without `filedAt` — it was owed to a lane that is no
   * longer configured (both mode switched to single) — is complete, and gets
   * its filedAt, so every reader (summaries, waiting(), the filing pass, the
   * sweep) agrees without re-posting it anywhere.
   */
  settleLanes(): number {
    const lanes = this.lanes;
    if (!lanes?.length) return 0;
    let settled = 0;
    for (const s of this.list()) {
      let changed = false;
      for (const v of Object.values(s.values)) {
        if (v.filedAt !== null || v.dropped !== null) continue;
        if (!lanes.every((l) => !!v.lanes?.[l]?.filedAt)) continue;
        const entries = lanes.map((l) => v.lanes![l]!);
        v.filedAt = entries.map((e) => e.filedAt!).sort().at(-1)!;
        const first = entries.find((e) => !e.skipped) ?? null;
        v.identifier = first?.identifier ?? null;
        v.labResultId = first?.labResultId ?? null;
        changed = true;
        settled++;
      }
      if (!changed) continue;
      const done = !Object.values(s.values).some((v) => isWaiting(v, lanes));
      if (done && (isLaneHold(s.lastError) || isPatientHold(s.lastError) || /^no order row yet/.test(s.lastError ?? ''))) {
        s.lastError = null;
      }
      this.write(s);
    }
    if (settled) {
      this.log.info({ values: settled, lanes }, 'values owed only to an HMIS lane no longer in use are complete');
    }
    return settled;
  }

  /** GenX line certified: remembered so it is never certified twice. */
  markCertified(barcode: string, lineId: number, at = new Date().toISOString()): void {
    const s = this.get(barcode);
    if (!s) return;
    const done = new Set(s.certified?.genx ?? []);
    done.add(lineId);
    s.certified = { genx: [...done] };
    if (s.certifyFailed) {
      const left = s.certifyFailed.genx.filter((id) => id !== lineId);
      s.certifyFailed = left.length ? { ...s.certifyFailed, genx: left } : undefined;
    }
    s.updatedAt = at;
    this.write(s);
  }

  /** GenX certify failed: kept so the next pass tries the line again. */
  recordCertifyFailure(barcode: string, lineId: number, error: string, at = new Date().toISOString()): void {
    const s = this.get(barcode);
    if (!s) return;
    const lines = new Set(s.certifyFailed?.genx ?? []);
    lines.add(lineId);
    s.certifyFailed = { genx: [...lines], error, at };
    this.write(s);
  }

  markDropped(barcode: string, codes: string[], reason: 'ignored' | 'void'): void {
    if (codes.length === 0) return;
    const s = this.get(barcode);
    if (!s) return;
    for (const c of codes) {
      const v = s.values[c];
      if (v && v.filedAt === null) v.dropped = reason;
    }
    this.write(s);
  }

  recordAttempt(barcode: string, outcome: { error: string | null; checkedHmis?: boolean }, at = new Date().toISOString()): void {
    const s = this.get(barcode);
    if (!s) return;
    s.attempts += 1;
    s.lastAttemptAt = at;
    s.lastError = outcome.error;
    if (outcome.checkedHmis) s.lastCheckedAt = at;
    this.write(s);
  }

  /**
   * Move a sample to the barcode it should have carried — the fix for an
   * operator who typed an MRN, a short number or a name on the instrument.
   * Every value is re-opened for filing under the new barcode (including any
   * the old barcode had somehow filed), and merged over whatever the target
   * already holds. Returns null when `from` does not exist.
   */
  rekey(from: string, to: string, at = new Date().toISOString(), by: 'operator' | 'completion' = 'operator'): StagedSample | null {
    const src = this.get(from);
    const target = normalizeBarcode(to);
    if (!src || !target) return null;
    if (src.barcode === target) return src;
    let dst = this.get(target);
    if (!dst) {
      dst = { ...src, barcode: target, values: {}, firstReceivedAt: src.firstReceivedAt };
      // A different tube: what was certified under the old barcode does not
      // apply. (A target that already exists keeps its own record.)
      delete dst.certified;
      delete dst.certifyFailed;
    }
    for (const v of Object.values(src.values)) {
      const reopened: StagedValue = { ...v, filedAt: null, identifier: null, labResultId: null, dropped: null };
      delete reopened.lanes; // re-opened in every lane
      dst.values[v.testCode] = reopened;
    }
    dst.rekeyedFrom = src.barcode;
    dst.isQc = false; // an operator says this is a patient sample
    dst.lastError = null;
    dst.lastCheckedAt = null; // ask HMIS afresh under the new barcode
    dst.updatedAt = at;
    dst.raw = src.raw ?? dst.raw;
    this.write(dst);
    this.remove(src.barcode);
    this.log.warn(
      { from: src.barcode, to: target, values: Object.keys(src.values).length, by },
      by === 'operator'
        ? 'staged sample re-keyed by an operator'
        : 'short instrument id completed to the HMIS barcode — an order exists under it',
    );
    return dst;
  }

  remove(barcode: string): boolean {
    try {
      unlinkSync(this.pathOf(barcode));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Age out: a sample still waiting after `unfiledDays` is discarded (logged
   * at warn with its barcode — this line is all that survives), and a fully
   * filed one is dropped quietly after `filedDays`.
   */
  sweep(unfiledDays: number, filedDays: number, now = Date.now()): { discarded: number; cleared: number } {
    const DAY = 24 * 60 * 60 * 1000;
    let discarded = 0;
    let cleared = 0;
    for (const s of this.list()) {
      const sum = summarize(s, this.lanes);
      if (sum.complete) {
        if (now - Date.parse(s.updatedAt) >= filedDays * DAY) {
          this.remove(s.barcode);
          cleared++;
        }
        continue;
      }
      if (now - Date.parse(s.firstReceivedAt) >= unfiledDays * DAY) {
        this.log.warn(
          { barcode: s.barcode, waiting: sum.waitingCodes, filed: sum.filed, days: unfiledDays, since: s.firstReceivedAt },
          'discarding staged results that never found an order row within the retention window',
        );
        this.remove(s.barcode);
        discarded++;
      }
    }
    return { discarded, cleared };
  }

  // ---------------------------------------------------------------------------
  private pathOf(barcode: string): string {
    return join(this.dir, `${safeSpoolId(normalizeBarcode(barcode))}.json`);
  }

  private files(): string[] {
    try {
      // Only this directory's own .json files; quarantined ones live in
      // corrupt/ and carry a timestamp suffix, so both are skipped here.
      return readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  /**
   * Read one staged sample, and QUARANTINE the file if it cannot be read.
   *
   * A staged file holds patient values that have not reached HMIS yet, so a
   * file that will not parse is lost work — and it used to vanish in silence:
   * this method returned null, list() skipped it, and the sample simply was
   * not there. Seven such files were found on the Prahlad Nagar BC-5150 on
   * 23 Sep 2026, every one 8 KB of NUL bytes and every one stamped 20 Sep
   * 13:05, the signature of an unclean shutdown losing the data blocks of
   * recently written files. (The writer is not at fault: write() goes to a
   * temp file and renames.) Nothing was lost to HMIS that time — all five
   * real barcodes had already filed — but nothing in the logs said so either.
   *
   * So: move the file to <dir>/corrupt/ and say which sample it was. Moving
   * it means the warning is not repeated on every pass, list() stops walking
   * over it, and the file is still on disk for anyone who wants to look. A
   * sample whose values never reached HMIS can then be re-run or forced from
   * the console; one that already filed costs nothing.
   */
  private read(path: string): StagedSample | null {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return null; // gone between readdir and here — nothing to quarantine
    }
    try {
      const s = JSON.parse(raw) as StagedSample;
      if (!s || typeof s.barcode !== 'string' || typeof s.values !== 'object') {
        this.quarantine(path, 'staged result file is not a staged sample');
        return null;
      }
      return s;
    } catch (err) {
      this.quarantine(path, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Move an unreadable staged file aside, once, and name it in the log. */
  private quarantine(path: string, why: string): void {
    const dir = join(this.dir, 'corrupt');
    const dst = join(dir, `${basename(path)}.${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      renameSync(path, dst);
    } catch {
      // Could not move it — still worth the warning; the next pass retries.
    }
    this.log.warn(
      { file: basename(path), movedTo: dst, reason: why },
      'staged results for this sample could not be read and were moved aside — if they never reached HMIS the sample must be re-run or forced',
    );
  }

  private write(s: StagedSample): void {
    const path = this.pathOf(s.barcode);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), 'utf8');
    renameSync(tmp, path);
  }
}
