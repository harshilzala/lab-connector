import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';
import { safeSpoolId } from '../queue/spool.js';
import type { GateVerdict } from './gate.js';

// =============================================================================
// ReviewStore — the "action required" list: values the IM gate held back for
// a person to verify before they reach Mirth.
//
// Each held value is stored with the EXACT row it will be filed as (the joined
// LisInboundResultRow) and the pending row it retires (the acknowledge item).
// Verification therefore files what the gate saw, not whatever a fresh lookup
// happens to return later — the person signs off on a specific number against
// a specific labResultId, and that is what goes.
//
// One JSON file per barcode under spool/<analyzer>/im-review/, like the order
// and result stores: no database, atomic rename on write, swept by age.
// =============================================================================

export type ReviewState = 'pending' | 'verified' | 'rejected';

export interface ReviewItem {
  /** The analyzer's own test code — the key within the sample. */
  testCode: string;
  identifier: string;
  value: string;
  unit: string | null;
  verdict: GateVerdict;
  /** Filed as-is on verification. */
  row: LisInboundResultRow;
  /** Acknowledged after the row files, when present. */
  ack: MirthAcknowledgeItem | null;
  state: ReviewState;
  heldAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string | null;
  /** Set when verification reached Mirth; null while pending or rejected. */
  filedAt: string | null;
  /** Last failure to file after verification — the item stays verifiable. */
  lastError: string | null;
}

export interface ReviewSample {
  barcode: string;
  analyzer: string;
  patient: { id: string | null; name: string | null; sex: string | null; birthDate: string | null } | null;
  firstHeldAt: string;
  updatedAt: string;
  items: Record<string, ReviewItem>;
}

export interface ReviewSummary {
  barcode: string;
  analyzer: string;
  patient: ReviewSample['patient'];
  firstHeldAt: string;
  updatedAt: string;
  pending: number;
  verified: number;
  rejected: number;
  /** Most severe reason among the pending items — the list sorts by it. */
  worst: string | null;
  items: ReviewItem[];
}

/** Severity order for the list: criticals first. */
const SEVERITY: Record<string, number> = {
  critical: 0,
  'out-of-range': 1,
  'analyzer-flag': 2,
  'not-numeric': 3,
  'not-final': 4,
  'no-range': 5,
  'always-review': 6,
};

export class ReviewStore {
  constructor(
    private readonly dir: string,
    private readonly analyzer: string,
    private readonly log: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Record held values. A value already held with the same number is left as
   * it is (a re-transmit, or the next filing pass seeing it again). A held
   * value whose number changed — a rerun — replaces the old one and goes back
   * to pending, even if the old one had been decided. Returns the codes that
   * are new or changed, so the caller logs only real events.
   */
  hold(
    barcode: string,
    patient: ReviewSample['patient'],
    items: Array<Omit<ReviewItem, 'state' | 'heldAt' | 'decidedAt' | 'decidedBy' | 'comment' | 'filedAt' | 'lastError'>>,
    at = new Date().toISOString(),
  ): string[] {
    const s = this.get(barcode) ?? {
      barcode,
      analyzer: this.analyzer,
      patient,
      firstHeldAt: at,
      updatedAt: at,
      items: {},
    };
    if (!s.patient && patient) s.patient = patient;
    const changed: string[] = [];
    for (const it of items) {
      const have = s.items[it.testCode];
      if (have && have.value === it.value && have.row.labResultId === it.row.labResultId) {
        // Same value: keep the decision, refresh only the verdict text.
        have.verdict = it.verdict;
        continue;
      }
      s.items[it.testCode] = {
        ...it,
        state: 'pending',
        heldAt: at,
        decidedAt: null,
        decidedBy: null,
        comment: null,
        filedAt: null,
        lastError: null,
      };
      changed.push(it.testCode);
    }
    if (changed.length || !this.get(barcode)) {
      s.updatedAt = at;
      this.write(s);
    }
    return changed;
  }

  get(barcode: string): ReviewSample | null {
    try {
      const s = JSON.parse(readFileSync(this.fileFor(barcode), 'utf8')) as ReviewSample;
      // Same lossy-file-name guard as the order store: never hand one sample
      // another's held rows.
      if (!s || s.barcode !== key(barcode)) return null;
      return s;
    } catch {
      return null;
    }
  }

  /** Every sample with something held, pending first, then most recent. */
  list(): ReviewSummary[] {
    const out: ReviewSummary[] = [];
    for (const f of this.files()) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ReviewSample;
        if (s && s.items) out.push(summarize(s));
      } catch {
        /* unreadable — skip */
      }
    }
    return out.sort((a, b) => {
      if ((a.pending > 0) !== (b.pending > 0)) return a.pending > 0 ? -1 : 1;
      const sa = a.worst ? SEVERITY[a.worst] ?? 9 : 9;
      const sb = b.worst ? SEVERITY[b.worst] ?? 9 : 9;
      if (sa !== sb) return sa - sb;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  }

  /** How many held values are waiting for a person, across all samples. */
  pendingCount(): { samples: number; values: number } {
    let samples = 0;
    let values = 0;
    for (const s of this.list()) {
      if (s.pending > 0) {
        samples++;
        values += s.pending;
      }
    }
    return { samples, values };
  }

  /**
   * Record a person's decision. Only PENDING items move (a verified value is
   * not re-verified, a rejected one not quietly verified). Returns the items
   * that changed, for the caller to file or log.
   */
  decide(
    barcode: string,
    codes: string[],
    decision: 'verified' | 'rejected',
    user: string,
    comment: string | null,
    at = new Date().toISOString(),
  ): ReviewItem[] {
    const s = this.get(barcode);
    if (!s) return [];
    // Only the codes named. An empty list decides NOTHING — never "all": a
    // person signs off on specific values, and a missing selection must not
    // turn into certifying every held result on the sample.
    const want = new Set(codes.map((c) => c.trim().toUpperCase()));
    const moved: ReviewItem[] = [];
    for (const it of Object.values(s.items)) {
      if (it.state !== 'pending') continue;
      if (!want.has(it.testCode.trim().toUpperCase())) continue;
      it.state = decision;
      it.decidedAt = at;
      it.decidedBy = user;
      it.comment = comment;
      moved.push(it);
    }
    if (moved.length) {
      s.updatedAt = at;
      this.write(s);
    }
    return moved;
  }

  /** After a verified item reached Mirth (or failed to). */
  markFiled(barcode: string, codes: string[], outcome: { error: string | null }, at = new Date().toISOString()): void {
    const s = this.get(barcode);
    if (!s) return;
    for (const c of codes) {
      const it = s.items[c];
      if (!it) continue;
      if (outcome.error) {
        it.lastError = outcome.error;
      } else {
        it.filedAt = at;
        it.lastError = null;
      }
    }
    s.updatedAt = at;
    this.write(s);
  }

  /** Verified values that have not reached Mirth yet — retried on demand. */
  unfiledVerified(barcode: string): ReviewItem[] {
    const s = this.get(barcode);
    if (!s) return [];
    return Object.values(s.items).filter((i) => i.state === 'verified' && i.filedAt === null);
  }

  /** Drop fully-decided samples not touched for `days`. Pending ones stay. */
  sweep(days: number, now = Date.now()): number {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of this.files()) {
      const path = join(this.dir, f);
      try {
        const s = JSON.parse(readFileSync(path, 'utf8')) as ReviewSample;
        const open = Object.values(s.items ?? {}).some((i) => i.state === 'pending' || (i.state === 'verified' && !i.filedAt));
        const stamp = Date.parse(s.updatedAt) || statSync(path).mtimeMs;
        if (open || stamp >= cutoff) continue;
        rmSync(path);
        removed++;
      } catch {
        /* leave anything unreadable for a person to look at */
      }
    }
    if (removed) this.log.info({ removed, days }, 'decided IM review samples swept');
    return removed;
  }

  // ---------------------------------------------------------------------------
  private fileFor(barcode: string): string {
    return join(this.dir, `${safeSpoolId(key(barcode))}.json`);
  }

  private write(s: ReviewSample): void {
    s.barcode = key(s.barcode);
    const path = this.fileFor(s.barcode);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, path);
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }
}

export function summarize(s: ReviewSample): ReviewSummary {
  const items = Object.values(s.items);
  const pending = items.filter((i) => i.state === 'pending');
  let worst: string | null = null;
  for (const i of pending) {
    const r = i.verdict.decision === 'hold' ? i.verdict.reason : null;
    if (r && (worst === null || (SEVERITY[r] ?? 9) < (SEVERITY[worst] ?? 9))) worst = r;
  }
  return {
    barcode: s.barcode,
    analyzer: s.analyzer,
    patient: s.patient,
    firstHeldAt: s.firstHeldAt,
    updatedAt: s.updatedAt,
    pending: pending.length,
    verified: items.filter((i) => i.state === 'verified').length,
    rejected: items.filter((i) => i.state === 'rejected').length,
    worst,
    items,
  };
}

function key(barcode: string): string {
  return (barcode ?? '').trim().toUpperCase();
}
