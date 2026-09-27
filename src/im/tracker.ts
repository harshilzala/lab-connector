import { join, resolve } from 'node:path';
import type { Logger } from '../logger.js';
import type { HmisResultUpload, LisInboundResultRow, MirthAcknowledgeItem, PatientDemographics } from '../types.js';
import type { StoredOrder } from '../orders/store.js';
import { gateJoined, type GateConfig, type GatedValue } from './gate.js';
import { ReviewStore, summarize as summarizeReview, type ReviewItem, type ReviewSample, type ReviewSummary } from './review.js';
import { ImTransactionLog, type ImTransaction } from './transactions.js';

// =============================================================================
// ImTracker — IM for ONE analyzer: the gate, the review list, and the
// per-order transaction log, behind the handful of calls the orchestrator
// makes at each step of an order's life:
//
//   Mirth offers rows      → orderSeen()        "order received"
//   analyzer asks/receives → querySeen() / orderSent() / orderSendFailed()
//   values arrive          → resultsReceived()
//   filing pass            → gate()             certify now / hold for review
//   Mirth answers          → filed() / fileFailed()
//   a person decides       → verify() / reject() (orchestrator files verified)
//
// It never talks to Mirth itself; the orchestrator does, so the queue and
// staged paths keep one place each where a result leaves the building.
// =============================================================================

export interface MirthCertifyFields {
  certified: string | null;
  autoCertified: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  abnormal: string | null;
  referenceRange: string | null;
  remarks: string | null;
}

export type ImOrderStatus =
  | 'ordered'
  | 'sent-to-analyzer'
  | 'send-failed'
  | 'resulted'
  | 'action-required'
  | 'mirth-error'
  | 'completed'
  | 'rejected';

export interface ImOrderSummary {
  analyzer: string;
  barcode: string;
  status: ImOrderStatus;
  firstAt: string;
  lastAt: string;
  /** Test codes Mirth ordered, as far as the log knows. */
  ordered: string[];
  /** Values certified by the gate / verified by a person / held / rejected. */
  autoCertified: number;
  verified: number;
  held: number;
  rejected: number;
  lastSummary: string;
}

export interface ImAnalyzerCounts {
  ordersToday: number;
  sentToday: number;
  resultsToday: number;
  autoCertifiedToday: number;
  verifiedToday: number;
  filedToday: number;
  errorsToday: number;
  actionRequired: { samples: number; values: number };
}

export class ImTracker {
  readonly transactions: ImTransactionLog;
  readonly review: ReviewStore;
  /** barcode → identifier#labResultId already logged as received. Seeded from
   *  the replayed transaction history so a restart does not re-announce every
   *  pending order on the first poll. */
  private readonly seenRows = new Map<string, Set<string>>();

  constructor(
    readonly analyzerId: string,
    readonly gateConfig: GateConfig,
    private readonly fields: MirthCertifyFields,
    private readonly autoCertifiedBy: string,
    spoolRoot: string,
    logDir: string,
    private readonly log: Logger,
  ) {
    this.transactions = new ImTransactionLog(resolve(logDir, `im-${analyzerId}.log`), analyzerId, log);
    this.review = new ReviewStore(join(spoolRoot, analyzerId, 'im-review'), analyzerId, log);
  }

  get enabled(): boolean {
    return this.gateConfig.enabled;
  }

  // ---- order life -----------------------------------------------------------

  /** Mirth offered rows for this barcode. Logs only rows not seen before. */
  orderSeen(order: StoredOrder, how: 'poll' | 'query' | 'resend' | 'result'): void {
    const seen = this.seenFor(order.barcode);
    const fresh = order.rows.filter((r) => !seen.has(rowKey(r)));
    if (fresh.length === 0) return;
    for (const r of fresh) seen.add(rowKey(r));
    const first = this.transactions.forBarcode(order.barcode).length === 0;
    this.transactions.record({
      barcode: order.barcode,
      kind: 'order-received',
      summary: `${first ? 'Order received from Mirth' : 'Order updated by Mirth'} (${how}): ${fresh.map((r) => r.identifier).join(', ')}`,
      codes: fresh.map((r) => r.identifier),
      detail: {
        via: how,
        priority: order.priority,
        specimenType: order.specimenType,
        patient: patientLabel(order.patient),
        rows: fresh.map((r) => ({
          identifier: r.identifier,
          labResultId: r.labResultId,
          parameterId: r.parameterId,
          range: rangeLabel(r),
        })),
      },
    });
  }

  /** The analyzer read a tube and asked for its worklist. */
  querySeen(barcode: string, found: boolean, codes: string[]): void {
    this.transactions.record({
      barcode,
      kind: 'query',
      summary: found
        ? `Analyzer read the barcode and asked for its tests — ${codes.length} found`
        : 'Analyzer read the barcode and asked for its tests — no order in Mirth, answered empty',
      codes,
    });
  }

  orderSent(barcode: string, codes: string[], how: 'poll' | 'query' | 'resend'): void {
    this.transactions.record({
      barcode,
      kind: 'order-sent',
      summary: `Order line sent to the analyzer (${how}): ${codes.join(', ')}`,
      codes,
    });
  }

  orderSendFailed(barcode: string, codes: string[], error: string): void {
    this.transactions.record({
      barcode,
      kind: 'order-send-failed',
      summary: `Analyzer did not take the order: ${error}`,
      codes,
      detail: { error },
    });
  }

  resultsReceived(upload: HmisResultUpload): void {
    this.transactions.record({
      barcode: upload.barcode,
      kind: 'result-received',
      summary: `${upload.results.length} result value${upload.results.length === 1 ? '' : 's'} received from the analyzer`,
      codes: upload.results.map((r) => r.testCode),
      detail: {
        values: upload.results.map((r) => ({
          code: r.testCode,
          value: r.value,
          unit: r.unit ?? null,
          flag: r.abnormalFlag ?? null,
          range: r.referenceRange ?? null,
        })),
      },
    });
  }

  // ---- the gate -------------------------------------------------------------

  /**
   * Split a joined upload into what files now (certified, decorated with the
   * Mirth certification columns) and what is held. Held values are written to
   * the review list here, before anything is posted, so a crash between the
   * two cannot lose them.
   */
  gate(
    upload: HmisResultUpload,
    joined: {
      rows: LisInboundResultRow[];
      matched: MirthAcknowledgeItem[];
      filedCodes: Array<{ testCode: string; identifier: string; labResultId: number | null }>;
    },
    orderRows: MirthAcknowledgeItem[],
    patient: PatientDemographics | null,
  ): {
    rows: LisInboundResultRow[];
    matched: MirthAcknowledgeItem[];
    filedCodes: Array<{ testCode: string; identifier: string; labResultId: number | null }>;
    held: string[];
  } {
    const g = gateJoined(this.gateConfig, upload, joined, orderRows);
    const at = new Date().toISOString();

    if (g.hold.length) {
      const ackBy = new Map(joined.matched.map((m) => [key(m.identifier), m] as const));
      const rowBy = new Map(joined.rows.map((r, i) => [joined.filedCodes[i]!.testCode, r] as const));
      const changed = this.review.hold(
        upload.barcode,
        reviewPatient(patient),
        g.hold.map((h) => ({
          testCode: h.testCode,
          identifier: h.identifier,
          value: h.value,
          unit: h.unit,
          verdict: h.verdict,
          row: rowBy.get(h.testCode)!,
          ack: ackBy.get(key(h.identifier)) ?? null,
        })),
        at,
      );
      if (changed.length) {
        const heldNow = g.hold.filter((h) => changed.includes(h.testCode));
        this.transactions.record({
          barcode: upload.barcode,
          kind: 'held',
          summary: `Action required — ${heldNow.length} value${heldNow.length === 1 ? '' : 's'} held for verification: ${heldNow.map(describeHold).join('; ')}`,
          codes: heldNow.map((h) => h.testCode),
          detail: { values: heldNow.map(verdictDetail) },
        });
        this.log.warn(
          { barcode: upload.barcode, held: heldNow.map((h) => h.testCode) },
          'IM: values held for verification — not filed until a person releases them',
        );
      }
    }

    const certified = g.verdicts.filter((v) => v.verdict.decision === 'certify');
    // A rerun that came back in range replaces an older held value for the
    // same test: the held one is no longer what the analyzer says, so it
    // must not sit on the action list for someone to file by mistake.
    if (certified.length) {
      const stale = this.review.decide(
        upload.barcode,
        certified.map((c) => c.testCode),
        'rejected',
        'IM',
        'superseded by a rerun value that was auto-certified',
        at,
      );
      if (stale.length) {
        this.transactions.record({
          barcode: upload.barcode,
          kind: 'note',
          summary: `Held value${stale.length === 1 ? '' : 's'} superseded by an in-range rerun: ${stale.map((i) => `${i.testCode} ${i.value}`).join(', ')}`,
          codes: stale.map((i) => i.testCode),
        });
      }
    }
    const rows = g.certify.rows.map((r, i) => this.certifyRow(r, { auto: true, by: this.autoCertifiedBy, at, verdict: certified[i] }));
    if (certified.length) {
      this.transactions.record({
        barcode: upload.barcode,
        kind: 'certified',
        summary: `Auto-certified ${certified.length} value${certified.length === 1 ? '' : 's'} within reference range`,
        codes: certified.map((c) => c.testCode),
        detail: { values: certified.map(verdictDetail) },
      });
    }
    return { rows, matched: g.certify.matched, filedCodes: g.certify.filedCodes, held: g.hold.map((h) => h.testCode) };
  }

  /** Add the Mirth certification columns to one row (config im.mirth.fields). */
  certifyRow(
    row: LisInboundResultRow,
    m: { auto: boolean; by: string; at: string; verdict?: GatedValue; remarks?: string | null },
  ): LisInboundResultRow {
    const out: LisInboundResultRow & Record<string, unknown> = { ...row };
    const f = this.fields;
    const v = m.verdict?.verdict;
    if (f.certified) out[f.certified] = true;
    if (f.autoCertified) out[f.autoCertified] = m.auto;
    if (f.certifiedBy) out[f.certifiedBy] = m.by;
    if (f.certifiedAt) out[f.certifiedAt] = m.at;
    if (f.abnormal) out[f.abnormal] = v ? v.decision === 'hold' && v.reason !== 'no-range' && v.reason !== 'always-review' && v.reason !== 'not-final' : false;
    if (f.referenceRange && v?.range?.text) out[f.referenceRange] = v.range.text;
    if (f.remarks && m.remarks) out[f.remarks] = m.remarks;
    return out;
  }

  filed(barcode: string, rows: LisInboundResultRow[], accepted: number, how: 'auto' | 'verified' | 'uncertified'): void {
    this.transactions.record({
      barcode,
      kind: 'filed',
      summary: `Sent to Mirth — ${accepted} of ${rows.length} row${rows.length === 1 ? '' : 's'} accepted (${how === 'auto' ? 'auto-certified' : how === 'verified' ? 'verified by a person' : 'IM off'})`,
      codes: rows.map((r) => r.identifier),
      detail: { rows: rows.map((r) => `${r.identifier} = ${r.resultValue} -> labResultId ${r.labResultId}`) },
    });
  }

  fileFailed(barcode: string, rows: LisInboundResultRow[], error: string): void {
    this.transactions.record({
      barcode,
      kind: 'file-failed',
      summary: `Mirth did not take the results: ${error}`,
      codes: rows.map((r) => r.identifier),
      detail: { error },
    });
  }

  acknowledged(barcode: string, rows: MirthAcknowledgeItem[], error: string | null): void {
    if (rows.length === 0) return;
    this.transactions.record({
      barcode,
      kind: error ? 'ack-failed' : 'acknowledged',
      summary: error
        ? `Acknowledge failed — the order rows stay pending in Mirth: ${error}`
        : `Order rows marked transmitted in Mirth (${rows.length})`,
      codes: rows.map((r) => r.identifier),
      detail: error ? { error } : undefined,
    });
  }

  // ---- decisions ------------------------------------------------------------

  /** Mark held values verified; returns the items to file. */
  verify(barcode: string, codes: string[], user: string, comment: string | null): ReviewItem[] {
    const moved = this.review.decide(barcode, codes, 'verified', user, comment);
    if (moved.length) {
      this.transactions.record({
        barcode,
        kind: 'verified',
        summary: `Verified by ${user}: ${moved.map((i) => `${i.testCode} ${i.value}`).join(', ')}${comment ? ` — "${comment}"` : ''}`,
        codes: moved.map((i) => i.testCode),
        user,
      });
    }
    return moved;
  }

  reject(barcode: string, codes: string[], user: string, comment: string | null): ReviewItem[] {
    const moved = this.review.decide(barcode, codes, 'rejected', user, comment);
    if (moved.length) {
      this.transactions.record({
        barcode,
        kind: 'rejected',
        summary: `Rejected by ${user} — not sent to Mirth: ${moved.map((i) => `${i.testCode} ${i.value}`).join(', ')}${comment ? ` — "${comment}"` : ''}`,
        codes: moved.map((i) => i.testCode),
        user,
      });
    }
    return moved;
  }

  note(barcode: string, summary: string, detail?: unknown): void {
    this.transactions.record({ barcode, kind: 'note', summary, detail });
  }

  // ---- views ----------------------------------------------------------------

  reviewList(): ReviewSummary[] {
    return this.review.list();
  }

  reviewSample(barcode: string): ReviewSummary | null {
    const s: ReviewSample | null = this.review.get(barcode);
    return s ? summarizeReview(s) : null;
  }

  history(barcode: string): ImTransaction[] {
    return this.transactions.forBarcode(barcode);
  }

  /** One row per barcode the log knows, newest activity first. */
  orders(limit = 300): ImOrderSummary[] {
    const reviews = new Map(this.review.list().map((r) => [r.barcode, r] as const));
    return this.transactions
      .barcodes()
      .slice(0, limit)
      .map((b) => this.summarizeOrder(b, reviews.get(b) ?? null));
  }

  counts(): ImAnalyzerCounts {
    const t = this.transactions.today();
    return {
      ordersToday: t['order-received'] ?? 0,
      sentToday: t['order-sent'] ?? 0,
      resultsToday: t['result-received'] ?? 0,
      autoCertifiedToday: t['certified'] ?? 0,
      verifiedToday: t['verified'] ?? 0,
      filedToday: t['filed'] ?? 0,
      errorsToday: (t['file-failed'] ?? 0) + (t['order-send-failed'] ?? 0) + (t['ack-failed'] ?? 0),
      actionRequired: this.review.pendingCount(),
    };
  }

  sweep(days: number): void {
    this.review.sweep(days);
  }

  // ---------------------------------------------------------------------------
  private summarizeOrder(barcode: string, review: ReviewSummary | null): ImOrderSummary {
    const h = this.transactions.forBarcode(barcode);
    const last = (kind: ImTransaction['kind']) => {
      for (let i = h.length - 1; i >= 0; i--) if (h[i]!.kind === kind) return h[i]!.ts;
      return null;
    };
    const has = (kind: ImTransaction['kind']) => last(kind) !== null;
    const newer = (a: string | null, b: string | null) => a !== null && (b === null || a > b);
    const ordered = new Set<string>();
    let autoCertified = 0;
    for (const t of h) {
      if (t.kind === 'order-received') for (const c of t.codes ?? []) ordered.add(c);
      if (t.kind === 'certified') autoCertified += t.codes?.length ?? 0;
    }

    let status: ImOrderStatus;
    if (review && review.pending > 0) status = 'action-required';
    else if (newer(last('file-failed'), last('filed'))) status = 'mirth-error';
    else if (has('filed')) status = 'completed';
    else if (review && review.rejected > 0) status = 'rejected';
    else if (has('result-received')) status = 'resulted';
    else if (newer(last('order-send-failed'), last('order-sent'))) status = 'send-failed';
    else if (has('order-sent')) status = 'sent-to-analyzer';
    else status = 'ordered';

    return {
      analyzer: this.analyzerId,
      barcode,
      status,
      firstAt: h[0]?.ts ?? '',
      lastAt: h[h.length - 1]?.ts ?? '',
      ordered: [...ordered],
      autoCertified,
      verified: review?.verified ?? 0,
      held: review?.pending ?? 0,
      rejected: review?.rejected ?? 0,
      lastSummary: h[h.length - 1]?.summary ?? '',
    };
  }

  private seenFor(barcode: string): Set<string> {
    const k = key(barcode);
    let s = this.seenRows.get(k);
    if (s) return s;
    s = new Set<string>();
    for (const t of this.transactions.forBarcode(k)) {
      if (t.kind !== 'order-received') continue;
      const rows = (t.detail as { rows?: Array<{ identifier: string; labResultId: number | null }> } | undefined)?.rows ?? [];
      for (const r of rows) s.add(`${key(r.identifier)}#${r.labResultId ?? ''}`);
    }
    this.seenRows.set(k, s);
    return s;
  }
}

function key(s: string): string {
  return (s ?? '').trim().toUpperCase();
}

function rowKey(r: MirthAcknowledgeItem): string {
  return `${key(r.identifier)}#${r.labResultId ?? ''}`;
}

function rangeLabel(r: MirthAcknowledgeItem): string | null {
  if (r.refText) return r.refText;
  if (r.refLow != null || r.refHigh != null) return `${r.refLow ?? ''} - ${r.refHigh ?? ''}`.trim();
  return null;
}

function patientLabel(p: PatientDemographics | null): string | null {
  if (!p) return null;
  const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
  return [p.patientId, name, p.sex].filter(Boolean).join(' · ') || null;
}

function reviewPatient(p: PatientDemographics | null): ReviewSample['patient'] {
  if (!p) return null;
  const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') || null;
  return { id: p.patientId ?? null, name, sex: p.sex ?? null, birthDate: p.birthDate ?? null };
}

function describeHold(h: GatedValue): string {
  const v = h.verdict;
  const why = v.decision === 'hold' ? v.detail : 'in range';
  return `${h.testCode} ${h.value}${h.unit ? ' ' + h.unit : ''} (${why})`;
}

function verdictDetail(h: GatedValue): Record<string, unknown> {
  const v = h.verdict;
  return {
    code: h.testCode,
    identifier: h.identifier,
    value: h.value,
    unit: h.unit,
    decision: v.decision,
    reason: v.reason,
    range: v.range?.text ?? null,
    rangeSource: v.range?.source ?? null,
    detail: v.decision === 'hold' ? v.detail : null,
  };
}
