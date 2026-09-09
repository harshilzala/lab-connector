import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { MirthAcknowledgeItem, PatientDemographics, PendingOrders } from '../types.js';
import { safeSpoolId } from '../queue/spool.js';

// =============================================================================
// OrderStore — the connector's durable memory of every HMIS order row it has
// seen for one analyzer, keyed by barcode.
//
// Why this exists. The HMIS results endpoint files a value against a
// labResultId, and the ONLY place that id is ever offered is the pending row.
// The pending endpoint, in turn, only returns rows nobody has acknowledged yet.
// So the moment a row is acknowledged — by this connector after filing, or by
// anything else that has ever polled the gateway — the id is gone, and a result
// that arrives afterwards (a rerun, a correction, a result that reached us
// after a restart, an order the previous middleware acknowledged) has nothing
// to be filed against.
//
// The retired middleware solved this with a MySQL table that cached every row
// it pulled. This is the same idea with no database: one JSON file per barcode
// under spool/<analyzer>/orders/, written before anything is sent to the
// analyzer, read back at result time. It also remembers which assay codes have
// already been downloaded to the instrument, so the order poller can hand over
// only what is new instead of re-programming a sample on every tick.
//
// A cache, not the source of truth: HMIS is still consulted live whenever the
// store cannot answer, and entries age out after ORDER_RETENTION_DAYS.
// =============================================================================

/** How the rows for a barcode reached the store. Informational. */
export type OrderSource = 'poll' | 'query' | 'result' | 'import';

export interface StoredOrder {
  /** Canonical (trimmed, upper-cased) barcode — the file is named after it. */
  barcode: string;
  /** Barcode exactly as HMIS spells it, which is what the analyzer is sent. */
  sampleId: string;
  /** One row per ordered test, ready for the acknowledge body. */
  rows: MirthAcknowledgeItem[];
  testCodes: string[];
  patient: PatientDemographics | null;
  specimenType: string | null;
  priority: 'S' | 'R';
  /** Assay identifiers already handed to the analyzer. */
  downloaded: string[];
  firstSeenAt: string;
  updatedAt: string;
  source: OrderSource;
}

export interface UpsertResult {
  order: StoredOrder;
  /** Test codes present in `order` that the analyzer has not been given yet. */
  newCodes: string[];
}

/** Entries untouched for this long are dropped — an order this old will never
 *  be resulted, and the row it holds is already history in HMIS too. */
export const ORDER_RETENTION_DAYS = 30;

export function canonicalBarcode(barcode: string): string {
  return (barcode ?? '').trim().toUpperCase();
}

const codeKey = (identifier: string): string => (identifier ?? '').trim().toUpperCase();

export class OrderStore {
  /** Lazily filled by count(); null means "re-read the directory". */
  private cachedCount: number | null = null;

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  get(barcode: string): StoredOrder | null {
    const key = canonicalBarcode(barcode);
    if (!key) return null;
    return this.read(key);
  }

  /**
   * Merge freshly fetched pending rows into the stored order for a barcode.
   *
   * Rows are matched on their assay identifier. A row whose identifier is new
   * is added. A row whose identifier is already stored but whose labResultId
   * differs is a RE-ORDER (the old row was resulted or cancelled and the test
   * raised again) — it replaces the stale row and is offered for download
   * again. A row identical to what is stored changes nothing.
   *
   * Returns the codes the analyzer has not been given yet, in the order HMIS
   * listed them.
   */
  upsert(barcode: string, pending: PendingOrders, source: OrderSource): UpsertResult {
    const key = canonicalBarcode(barcode);
    const now = new Date().toISOString();
    const existing = this.read(key);

    const order: StoredOrder = existing ?? {
      barcode: key,
      sampleId: pending.sampleId || barcode,
      rows: [],
      testCodes: [],
      patient: null,
      specimenType: null,
      priority: 'R',
      downloaded: [],
      firstSeenAt: now,
      updatedAt: now,
      source,
    };

    const byCode = new Map<string, MirthAcknowledgeItem>();
    for (const row of order.rows) byCode.set(codeKey(row.identifier), row);
    const downloaded = new Set(order.downloaded.map(codeKey));

    let changed = existing === null;
    for (const row of pending.ackItems) {
      const k = codeKey(row.identifier);
      if (!k) continue;
      const have = byCode.get(k);
      if (have && sameRow(have, row)) continue;
      if (have && have.labResultId !== row.labResultId) {
        // Re-ordered: the instrument must run it again.
        downloaded.delete(k);
      }
      byCode.set(k, row);
      changed = true;
    }

    // Sample-level attributes: keep what we have, fill in what was missing.
    if (!order.patient && pending.patient) {
      order.patient = pending.patient;
      changed = true;
    }
    if (order.specimenType === null && pending.specimenType !== null) {
      order.specimenType = pending.specimenType;
      changed = true;
    }
    if (order.priority === 'R' && pending.priority === 'S') {
      order.priority = 'S';
      changed = true;
    }

    order.rows = [...byCode.values()];
    order.testCodes = order.rows.map((r) => r.identifier);
    order.downloaded = order.downloaded.filter((c) => downloaded.has(codeKey(c)));
    const newCodes = order.testCodes.filter((c) => !downloaded.has(codeKey(c)));

    if (changed) {
      order.updatedAt = now;
      order.source = source;
      this.write(order);
      // A brand-new barcode is the only thing here that moves the count;
      // re-writing an existing one does not.
      if (existing === null && this.cachedCount !== null) this.cachedCount += 1;
    }
    return { order, newCodes };
  }

  /** Record that these assay codes are now programmed on the analyzer. */
  markDownloaded(barcode: string, codes: string[]): void {
    const order = this.get(barcode);
    if (!order) return;
    const have = new Set(order.downloaded.map(codeKey));
    let changed = false;
    for (const c of codes) {
      const k = codeKey(c);
      if (!k || have.has(k)) continue;
      have.add(k);
      order.downloaded.push(c);
      changed = true;
    }
    if (changed) {
      order.updatedAt = new Date().toISOString();
      this.write(order);
    }
  }

  /**
   * How many barcodes the store holds.
   *
   * Cached, because this is read by the admin status endpoint, which the
   * dashboard polls every 5 seconds for every analyzer. Counting by listing the
   * directory meant a synchronous readdir over hundreds of files ~50,000 times
   * a day, on the same event loop that runs the ASTM and Kermit ACK timers —
   * blocking it there risks a link timing out, not just a slow page.
   *
   * The count only moves when a barcode is added (upsert) or swept, and both
   * update it, so the directory is read once per process rather than per poll.
   */
  count(): number {
    if (this.cachedCount === null) this.cachedCount = this.listFiles().length;
    return this.cachedCount;
  }

  /** Drop entries not touched within the retention window. Returns how many. */
  sweep(days = ORDER_RETENTION_DAYS, now = Date.now()): number {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const file of this.listFiles()) {
      const path = join(this.dir, file);
      try {
        const st = statSync(path);
        let stamp = st.mtimeMs;
        try {
          const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredOrder>;
          const t = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
          if (Number.isFinite(t)) stamp = t;
        } catch {
          /* unreadable — fall back to mtime */
        }
        if (stamp >= cutoff) continue;
        rmSync(path);
        removed++;
      } catch (err) {
        this.logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'could not sweep an order entry');
      }
    }
    if (removed) {
      this.cachedCount = null; // recount lazily on the next status read
      this.logger.info({ removed, days }, 'expired order entries removed');
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  private fileFor(key: string): string {
    return join(this.dir, `${safeSpoolId(key)}.json`);
  }

  private read(key: string): StoredOrder | null {
    try {
      const raw = readFileSync(this.fileFor(key), 'utf8');
      const o = JSON.parse(raw) as StoredOrder;
      if (!o || !Array.isArray(o.rows)) return null;
      // The file name is a LOSSY fold of the barcode: safeSpoolId rewrites the
      // characters Windows rejects, so "AB/CD" and "AB_CD" — or a QC id like
      // "KN TG 2 <0.02" and "KN TG 2 _0.02" — land on the same file. Returning
      // a neighbour's entry would hand this sample another sample's
      // labResultIds and file its results against the wrong lab order, so the
      // stored barcode has to agree with the one asked for.
      if (o.barcode !== key) {
        // upsert will now treat this barcode as new and overwrite the file, so
        // the cached total no longer reflects what is on disk.
        this.cachedCount = null;
        this.logger.warn(
          { asked: key, found: o.barcode, file: this.fileFor(key) },
          'order-store file name collision — ignoring the stored entry and falling back to a live HMIS lookup',
        );
        return null;
      }
      return o;
    } catch {
      return null;
    }
  }

  private write(order: StoredOrder): void {
    const path = this.fileFor(order.barcode);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(order, null, 2));
    renameSync(tmp, path); // atomic on the same volume
  }

  private listFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }
}

function sameRow(a: MirthAcknowledgeItem, b: MirthAcknowledgeItem): boolean {
  return (
    a.labResultId === b.labResultId &&
    a.labServiceId === b.labServiceId &&
    a.parameterId === b.parameterId &&
    String(a.equipmentId ?? '') === String(b.equipmentId ?? '')
  );
}
