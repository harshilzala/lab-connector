import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { HmisResultUpload } from '../types.js';
import { safeSpoolId } from '../queue/spool.js';
import { normalizeBarcode } from '../mapping/mapper.js';

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
  /** The pending row it was filed against, for tracing. */
  identifier: string | null;
  labResultId: number | null;
  /** Set when the value will never be filed: a non-interfaced code, or a
   *  placeholder the analyzer sent instead of a number. Not counted as
   *  waiting. */
  dropped: 'ignored' | 'void' | null;
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
  complete: boolean;
}

export interface UpsertResult {
  sample: StagedSample;
  /** Codes that are new or whose value changed — what this message added. */
  changed: string[];
  /** Codes already held with the same value — a re-transmit. */
  unchanged: string[];
}

function isWaiting(v: StagedValue): boolean {
  return v.filedAt === null && v.dropped === null;
}

export function summarize(s: StagedSample): StagedSummary {
  const values = Object.values(s.values);
  const waiting = values.filter(isWaiting);
  const filed = values.filter((v) => v.filedAt !== null).length;
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
  };
}

export class ResultStore {
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
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

    const changed: string[] = [];
    const unchanged: string[] = [];
    for (const r of upload.results) {
      const have = sample.values[r.testCode];
      const unit = r.unit ?? null;
      if (have && have.value === r.value && have.unit === unit) {
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
        identifier: null,
        labResultId: null,
        dropped: null,
      };
      changed.push(r.testCode);
    }

    if (changed.length || !existing) {
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
    return this.list().map(summarize);
  }

  /** Samples with something left to file, oldest first — the filing order. */
  waiting(): StagedSample[] {
    return this.list()
      .filter((s) => Object.values(s.values).some(isWaiting))
      .sort((a, b) => (a.firstReceivedAt < b.firstReceivedAt ? -1 : a.firstReceivedAt > b.firstReceivedAt ? 1 : 0));
  }

  counts(): StagedCounts {
    let waiting = 0;
    let complete = 0;
    for (const s of this.list()) {
      if (Object.values(s.values).some(isWaiting)) waiting++;
      else complete++;
    }
    return { waiting, complete };
  }

  /** The values still to be filed, in the shape the join wants. */
  pendingUpload(sample: StagedSample, messageId: string): HmisResultUpload {
    const results = Object.values(sample.values)
      .filter(isWaiting)
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
    filed: Array<{ testCode: string; identifier: string; labResultId: number | null }>,
    at = new Date().toISOString(),
  ): void {
    const s = this.get(barcode);
    if (!s) return;
    for (const f of filed) {
      const v = s.values[f.testCode];
      if (!v) continue;
      v.filedAt = at;
      v.identifier = f.identifier;
      v.labResultId = f.labResultId;
      v.dropped = null;
    }
    s.lastError = null;
    s.updatedAt = at;
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
  rekey(from: string, to: string, at = new Date().toISOString()): StagedSample | null {
    const src = this.get(from);
    const target = normalizeBarcode(to);
    if (!src || !target) return null;
    if (src.barcode === target) return src;
    const dst: StagedSample = this.get(target) ?? {
      ...src,
      barcode: target,
      values: {},
      firstReceivedAt: src.firstReceivedAt,
    };
    for (const v of Object.values(src.values)) {
      dst.values[v.testCode] = { ...v, filedAt: null, identifier: null, labResultId: null, dropped: null };
    }
    dst.rekeyedFrom = src.barcode;
    dst.isQc = false; // an operator says this is a patient sample
    dst.lastError = null;
    dst.lastCheckedAt = null; // ask HMIS afresh under the new barcode
    dst.updatedAt = at;
    dst.raw = src.raw ?? dst.raw;
    this.write(dst);
    this.remove(src.barcode);
    this.log.warn({ from: src.barcode, to: target, values: Object.keys(src.values).length }, 'staged sample re-keyed by an operator');
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
      const sum = summarize(s);
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
      return readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  private read(path: string): StagedSample | null {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8')) as StagedSample;
      if (!s || typeof s.barcode !== 'string' || typeof s.values !== 'object') return null;
      return s;
    } catch {
      return null;
    }
  }

  private write(s: StagedSample): void {
    const path = this.pathOf(s.barcode);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), 'utf8');
    renameSync(tmp, path);
  }
}
