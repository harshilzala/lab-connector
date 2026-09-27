import { readFileSync } from 'node:fs';
import type { Logger } from '../logger.js';
import { DailyLogFile, localDayKey } from '../maintenance/daily-log.js';

// =============================================================================
// IM transaction log — one line per thing that happened to an order.
//
// The IM dashboard's "expand an order and see everything that happened to it"
// view: when Mirth offered the order, when it went to the analyzer, when the
// result came back, what the gate decided for each value, who verified what,
// and when Mirth took it. The application log has the same facts spread over
// several modules; this is the per-barcode narrative, in order, on disk.
//
// Storage is a DailyLogFile under the log directory (logs\im-<analyzer>-
// YYYY-MM-DD.log), so the retention sweeper ages it out with the other
// evidence files. An in-memory index by barcode serves the console; it is
// rebuilt on start from the last REPLAY_DAYS of files so a restart does not
// blank the screen.
// =============================================================================

export type ImTransactionKind =
  | 'order-received' // Mirth offered rows for this barcode (poll or query)
  | 'order-sent' // the order was programmed on the analyzer
  | 'order-send-failed'
  | 'query' // the analyzer asked for this barcode
  | 'result-received' // values arrived from the analyzer
  | 'certified' // the gate passed these values for filing
  | 'held' // the gate held these values for a person
  | 'verified' // a person released held values
  | 'rejected' // a person refused held values — never filed
  | 'filed' // Mirth accepted the rows
  | 'file-failed'
  | 'acknowledged' // pending rows retired in Mirth
  | 'ack-failed'
  | 'note'; // anything else worth keeping against the barcode

export interface ImTransaction {
  ts: string;
  analyzer: string;
  barcode: string;
  kind: ImTransactionKind;
  /** One line for the screen. */
  summary: string;
  /** Test codes the entry concerns, when it concerns specific ones. */
  codes?: string[];
  /** Who did it, for the verified / rejected entries. */
  user?: string;
  /** Anything structured the screen may show on expand. Kept small. */
  detail?: unknown;
}

/** Days of history replayed into memory on start. */
const REPLAY_DAYS = 3;
/** Cap on the in-memory index so a busy month cannot grow it unbounded. */
const MAX_INDEXED = 20_000;

export class ImTransactionLog {
  private readonly file: DailyLogFile;
  private readonly all: ImTransaction[] = [];
  private readonly byBarcode = new Map<string, ImTransaction[]>();

  constructor(
    private readonly base: string,
    private readonly analyzer: string,
    private readonly log: Logger,
  ) {
    this.file = new DailyLogFile(base, log);
    this.replay();
  }

  record(t: Omit<ImTransaction, 'ts' | 'analyzer'> & { ts?: string }): ImTransaction {
    const entry: ImTransaction = { ts: t.ts ?? new Date().toISOString(), analyzer: this.analyzer, ...t };
    this.file.append(JSON.stringify(entry));
    this.index(entry);
    return entry;
  }

  /** Every entry for one barcode, oldest first. */
  forBarcode(barcode: string): ImTransaction[] {
    return this.byBarcode.get(key(barcode)) ?? [];
  }

  /** The latest entries across every barcode, newest first. */
  recent(limit = 200): ImTransaction[] {
    return this.all.slice(-limit).reverse();
  }

  /** Barcodes with at least one entry, most recently touched first. */
  barcodes(): string[] {
    const last = new Map<string, string>();
    for (const t of this.all) last.set(key(t.barcode), t.ts);
    return [...last.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([b]) => b);
  }

  /** Counts for the tiles: today's entries by kind. */
  today(): Record<string, number> {
    const day = localDayKey(new Date());
    const out: Record<string, number> = {};
    for (const t of this.all) {
      if (localDayKey(new Date(t.ts)) !== day) continue;
      out[t.kind] = (out[t.kind] ?? 0) + 1;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  private index(t: ImTransaction): void {
    this.all.push(t);
    const k = key(t.barcode);
    const list = this.byBarcode.get(k) ?? [];
    list.push(t);
    this.byBarcode.set(k, list);
    if (this.all.length > MAX_INDEXED) {
      const dropped = this.all.splice(0, this.all.length - MAX_INDEXED);
      for (const d of dropped) {
        const l = this.byBarcode.get(key(d.barcode));
        if (!l) continue;
        const i = l.indexOf(d);
        if (i >= 0) l.splice(i, 1);
        if (l.length === 0) this.byBarcode.delete(key(d.barcode));
      }
    }
  }

  private replay(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - REPLAY_DAYS);
    const oldest = localDayKey(cutoff);
    let lines = 0;
    for (const path of DailyLogFile.files(this.base)) {
      const m = /-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.[^.]+$/.exec(path);
      if (m && m[1]! < oldest) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line) as ImTransaction;
          if (t && t.barcode && t.kind) {
            this.index(t);
            lines++;
          }
        } catch {
          /* a torn last line from a crash — skip it */
        }
      }
    }
    if (lines) this.log.info({ replayed: lines, barcodes: this.byBarcode.size, days: REPLAY_DAYS }, 'IM transaction history loaded');
  }
}

function key(barcode: string): string {
  return (barcode ?? '').trim().toUpperCase();
}
