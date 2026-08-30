import type { Logger } from '../logger.js';
import type { MirthAcknowledgeItem, LisInboundResultRow, HmisResultUploadResponse } from '../types.js';

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
    const res = await this.request('GET', path);
    return this.readJson(res, path);
  }

  /**
   * Acknowledge the rows just downloaded so they are not offered again.
   * Call this ONLY after the download to the analyzer succeeded — a failed
   * download must leave the rows pending.
   */
  async acknowledge(items: MirthAcknowledgeItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.request('POST', this.opts.acknowledgePath, JSON.stringify(items));
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

    const res = await this.request('POST', this.opts.resultsPath, JSON.stringify(rows));
    const parsed = (await this.readJson(res, this.opts.resultsPath)) as Partial<HmisResultUploadResponse> | null;

    const status = String(parsed?.status ?? '').toLowerCase();
    const message = String(parsed?.message ?? '');
    const successData = Array.isArray(parsed?.successData) ? parsed.successData : [];

    if (status !== 'success') {
      throw new Error(`HMIS ${this.opts.resultsPath} rejected the upload: ${message || 'status=' + status}`);
    }
    if (successData.length === 0) {
      throw new Error(
        `HMIS ${this.opts.resultsPath} accepted 0 of ${rows.length} row(s) — the server matched nothing. ${message}`,
      );
    }

    return { status: 'success', message, successData, filed: successData.length };
  }

  // ---------------------------------------------------------------------------
  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<Response> {
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
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HMIS ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`HMIS ${method} ${path} → timed out after ${this.opts.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tolerates an empty or non-JSON body rather than throwing on it. */
  private async readJson(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.opts.logger.warn({ path, body: text.slice(0, 200) }, 'HMIS returned a non-JSON body');
      return null;
    }
  }
}
