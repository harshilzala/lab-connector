import type { Logger } from '../logger.js';
import type { MirthAcknowledgeItem, LisInboundResultRow, HmisResultUploadResponse } from '../types.js';
import type { HmisAudit, HmisAuditKind, HmisAuditOutcome } from './audit.js';
import { unwrapRows } from './pending.js';

// =============================================================================
// HMIS REST client — the three `/mirth/*` endpoints.
//
// These are UNAUTHENTICATED: no equipment id header, no shared secret, no HMAC
// signature. The analyzer identifies itself with the `eqCode` query parameter
// (its configured `equipmentCode`). Keep the connector bound to the lab VLAN
// and the HMIS gateway reachable only from it — the transport is the only thing
// guarding these calls.
//
//   GET  {pendingPath}      load orders   → one row per pending test
//   POST {acknowledgePath}  the rows just handed to the analyzer
//   POST {resultsPath}      analyzer results, idempotent on messageId
// =============================================================================

export interface HmisClientOptions {
  baseUrl: string;
  pendingPath: string;
  acknowledgePath: string;
  resultsPath: string;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  logger: Logger;
  /** Records every call to the gateway — request, response and verdict. */
  audit?: HmisAudit;
}

/** Query parameters for GET {pendingPath}. The server treats every one as
 *  optional, so only what the analyzer config supplies is sent. */
export interface PendingQuery {
  /** Uppercased tube barcode. */
  sampleId: string;
  /** The analyzer's `equipmentCode`. */
  eqCode: string;
  siteId?: string;
  showCulture?: string | boolean;
  /** dd-MM-yyyy, only when the analyzer sets `sendDate`. */
  date?: string;
}

export class HmisClient {
  constructor(private readonly opts: HmisClientOptions) {
    if (!opts.tlsRejectUnauthorized) {
      // Blunt but effective for a self-signed cert on a hospital LAN. Scope it
      // narrowly in production (pin the CA instead) — this disables TLS
      // verification process-wide.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      opts.logger.warn('TLS certificate verification is DISABLED (tlsRejectUnauthorized=false)');
    }
  }

  /**
   * Load pending orders for one barcode. Returns the RAW body — column naming
   * varies per deployment, so normalising is `src/hmis/pending.ts`'s job and
   * the caller passes the body straight to `normalizePending`.
   */
  async getPending(q: PendingQuery): Promise<unknown> {
    const params = new URLSearchParams();
    if (q.sampleId) params.set('sampleId', q.sampleId);
    if (q.eqCode) params.set('eqCode', q.eqCode);
    if (q.siteId) params.set('siteId', q.siteId);
    if (q.showCulture !== undefined) params.set('showCulture', String(q.showCulture));
    if (q.date) params.set('date', q.date);

    const path = `${this.opts.pendingPath}?${params.toString()}`;
    const startedAt = Date.now();
    try {
      const { status, text } = await this.send('GET', path);
      const body = this.parse(text, path);
      // The question this log exists to answer: did the sample get work back?
      const rows = unwrapRows(body).length;
      this.record({
        kind: 'query',
        sampleId: q.sampleId ?? null,
        eqCode: q.eqCode ?? null,
        method: 'GET',
        path,
        startedAt,
        httpStatus: status,
        response: body,
        outcome: rows > 0 ? 'orders-found' : 'no-orders',
        rows,
      });
      return body;
    } catch (err) {
      this.record({
        kind: 'query',
        sampleId: q.sampleId ?? null,
        eqCode: q.eqCode ?? null,
        method: 'GET',
        path,
        startedAt,
        httpStatus: null,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Acknowledge the rows just downloaded so they are not offered again.
   * Call this ONLY after the download to the analyzer succeeded — a failed
   * download must leave the rows pending.
   *
   * Validated like `postResults`, and for the same reason: HTTP 200 from this
   * gateway means "request received", never "rows retired". An acknowledge
   * that quietly matched nothing leaves the order in the pending queue, and
   * without this check the connector would log a clean success for it.
   *
   * The checks are deliberately conditional on what the gateway actually
   * sent. Not every deployment answers this endpoint with a document, so an
   * empty or shapeless body is still accepted — only a status it declares, or
   * a successData it returns, is judged.
   */
  async acknowledge(items: MirthAcknowledgeItem[]): Promise<void> {
    if (items.length === 0) return;
    const path = this.opts.acknowledgePath;
    const startedAt = Date.now();
    const sampleId = [...new Set(items.map((i) => i.sampleID))];
    let httpStatus: number | null = null;
    let response: unknown = null;
    try {
      const sent = await this.send('POST', path, JSON.stringify(items));
      httpStatus = sent.status;
      const parsed = this.parse(sent.text, path) as Partial<HmisResultUploadResponse> | null;
      response = parsed ?? sent.text;

      const status = parsed?.status === undefined ? null : String(parsed.status).toLowerCase();
      const message = String(parsed?.message ?? '');
      const retired = Array.isArray(parsed?.successData) ? parsed.successData : null;

      if (status !== null && status !== 'success') {
        throw new Error(`HMIS ${path} rejected the acknowledge: ${message || 'status=' + status}`);
      }
      if (retired !== null && retired.length === 0) {
        throw new Error(
          `HMIS ${path} retired 0 of ${items.length} row(s) — the orders stay pending and will be offered again. ${message}`,
        );
      }

      this.record({
        kind: 'acknowledge',
        sampleId,
        method: 'POST',
        path,
        startedAt,
        request: items,
        httpStatus,
        response,
        outcome: 'sent',
        rows: retired?.length ?? items.length,
      });
    } catch (err) {
      this.record({
        kind: 'acknowledge',
        sampleId,
        method: 'POST',
        path,
        startedAt,
        request: items,
        httpStatus,
        response,
        outcome: httpStatus === 200 ? 'none-matched' : 'error',
        rows: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Upload analyzer results as the BARE ARRAY the gateway expects.
   *
   * The gateway answers HTTP 200 for everything — a Gson bind failure, an
   * unmatched row and a real save all come back 200 — so the HTTP status alone
   * says nothing. Throw unless `status` is "success", and treat an empty
   * `successData` for a non-empty request as a failure too: that is what a
   * silently-ignored (mis-keyed or unmatched) row looks like, and swallowing it
   * would drop a patient result on the floor while reporting it as filed.
   */
  async postResults(rows: LisInboundResultRow[]): Promise<HmisResultUploadResponse> {
    if (rows.length === 0) return { status: 'success', message: 'nothing to send', successData: [], filed: 0 };

    const path = this.opts.resultsPath;
    const startedAt = Date.now();
    const sampleId = [...new Set(rows.map((r) => r.sampleId))];
    let httpStatus: number | null = null;
    let response: unknown = null;
    try {
      const sent = await this.send('POST', path, JSON.stringify(rows));
      httpStatus = sent.status;
      const parsed = this.parse(sent.text, path) as Partial<HmisResultUploadResponse> | null;
      response = parsed ?? sent.text;

      const status = String(parsed?.status ?? '').toLowerCase();
      const message = String(parsed?.message ?? '');
      const successData = Array.isArray(parsed?.successData) ? parsed.successData : [];

      if (status !== 'success') {
        throw new Error(`HMIS ${path} rejected the upload: ${message || 'status=' + status}`);
      }
      if (successData.length === 0) {
        throw new Error(
          `HMIS ${path} accepted 0 of ${rows.length} row(s) — the server matched nothing. ${message}`,
        );
      }

      this.record({
        kind: 'result',
        sampleId,
        method: 'POST',
        path,
        startedAt,
        request: rows,
        httpStatus,
        response,
        outcome: 'filed',
        rows: successData.length,
      });
      return { status: 'success', message, successData, filed: successData.length };
    } catch (err) {
      // The zero-match upload lands here too. It is a 200 the gateway called a
      // success, so `none-matched` is the honest verdict rather than `error` —
      // and it is the case worth grepping this file for.
      const message = err instanceof Error ? err.message : String(err);
      this.record({
        kind: 'result',
        sampleId,
        method: 'POST',
        path,
        startedAt,
        request: rows,
        httpStatus,
        response,
        outcome: httpStatus === 200 ? 'none-matched' : 'error',
        rows: 0,
        error: message,
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  /** One line in the HMIS transaction log; a no-op when auditing is off. */
  private record(e: {
    kind: HmisAuditKind;
    sampleId: string | string[] | null;
    eqCode?: string | null;
    method: 'GET' | 'POST';
    path: string;
    startedAt: number;
    request?: unknown;
    httpStatus: number | null;
    response?: unknown;
    outcome: HmisAuditOutcome;
    rows?: number;
    error?: string;
  }): void {
    this.opts.audit?.record({
      ts: new Date().toISOString(),
      kind: e.kind,
      sampleId: e.sampleId,
      eqCode: e.eqCode,
      method: e.method,
      url: this.opts.baseUrl.replace(/\/$/, '') + e.path,
      request: e.request,
      httpStatus: e.httpStatus,
      response: e.response,
      durationMs: Date.now() - e.startedAt,
      outcome: e.outcome,
      rows: e.rows,
      error: e.error,
    });
  }

  /** Performs the call and reads the body. Throws on timeout or a non-2xx. */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller.signal,
      });
      // Read the body BEFORE the status check: the error text is the only clue
      // a gateway gives on a 4xx/5xx, and it belongs in the audit entry too.
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HMIS ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return { status: res.status, text };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`HMIS ${method} ${path} -> timed out after ${this.opts.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tolerates an empty or non-JSON body rather than throwing on it. */
  private parse(text: string, path: string): unknown {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.opts.logger.warn({ path, body: text.slice(0, 200) }, 'HMIS returned a non-JSON body');
      return null;
    }
  }
}
