import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';
import type { HmisResultUploadResponse, LisInboundResultRow, MirthAcknowledgeItem, MirthPendingRow } from '../types.js';
import type { HmisAudit, HmisAuditKind, HmisAuditOutcome } from './audit.js';
import { HmisUnavailableError, type HmisGateway, type PendingQuery } from './client.js';

// =============================================================================
// GenX LIMS "Lab Equipment External API" client — the alternative to the
// /mirth/* gateway, selected with `hmis.api: "genx"` in config.json.
//
// Source: GenX-Lab-Equipment-Interface.postman_collection.json (2026-09-27).
//
//   POST {tokenPath}          OAuth2 client_credentials → Bearer token (3600 s)
//   GET  {worklistPath}       ?barcode=… (host query) | ?from&to&page&size (batch)
//   POST {acknowledgePath}    {acknowledgements:[{accessionNumber, equipmentCode, …}]}
//   POST {resultsPath}        {accessionNumber, equipmentCode, results:[{machineTestCode, value}]}
//
// It is an ADAPTER. The rest of the connector — the order store, the staged
// filer, the join, every analyzer — speaks the mirth shape: one pending row
// per analyte, carrying the analyzer's own assay code as `identifier`. So:
//
//   • the worklist is translated INTO mirth-shaped rows. GenX lists tests at
//     service level ("CBC"); `serviceTests` expands each service into the
//     machine codes the analyzer reports under it, one row per code, so the
//     join still has a row to match every value against. A service with no
//     entry becomes a single row named after the serviceCode.
//   • results are translated OUT of the joined rows: one POST per tube, keyed
//     by accessionNumber, each value sent as `machineTestCode` — GenX maps the
//     code to its own parameter server-side (it answers `unmatched` for any it
//     cannot place).
//
// The tube barcode the analyzer reads is GenX's `sampleNumber` by default
// (`barcodeField`). Results and acknowledgements are keyed by accessionNumber
// instead, so every worklist answer records barcode → accession, persisted to
// `accessionCacheFile`; a miss (e.g. after the file is cleared) is resolved by
// a fresh host query before the upload.
//
// The gateway wraps every answer twice — { success, data: { success, message,
// data: <payload> } } — and both `success` flags are checked.
// =============================================================================

export interface GenxClientOptions {
  baseUrl: string;
  tokenPath: string;
  revokePath?: string;
  worklistPath: string;
  acknowledgePath: string;
  resultsPath: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated OAuth scopes; empty = every scope granted to the client. */
  scope: string;
  /** "basic" = client id/secret in an Authorization: Basic header (GenX's
   *  preferred form); "body" = sent as form fields. */
  clientAuth: 'basic' | 'body';
  /** PROD only. Sent on every API call under `apiKeyHeader`. */
  apiKey?: string;
  apiKeyHeader: string;
  /** Which worklist field is the barcode printed on the tube. */
  barcodeField: 'sampleNumber' | 'accessionNumber';
  /** GenX serviceCode → the analyzer assay codes reported under it. */
  serviceTests: Record<string, string[]>;
  /** equipmentCode → the serviceCodes that machine runs. An equipmentCode not
   *  listed takes every service on the tube. */
  equipmentServices: Record<string, string[]>;
  /** Test-line statuses still waiting for a result; anything else is treated
   *  as already transmitted and is not downloaded again. */
  pendingLineStatuses: string[];
  /** Bulk poll window (no barcode): today minus this many days … today. */
  batchDays: number;
  batchPageSize: number;
  accessionCacheFile?: string;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  logger: Logger;
  audit?: HmisAudit;
}

interface GenxTest {
  sampleLineId?: string | number;
  serviceId?: string | number;
  serviceCode?: string;
  serviceName?: string;
  lineStatus?: string;
}

interface GenxTube {
  accessionNumber?: string;
  sampleNumber?: string;
  sampleId?: string | number;
  status?: string;
  priority?: string;
  specimenName?: string;
  patient?: {
    uhid?: string;
    name?: string;
    genderCode?: string;
    dateOfBirth?: string;
  };
  tests?: GenxTest[];
}

export class GenxHmisClient implements HmisGateway {
  /** GenX takes the branch from the token — there is no site filter. */
  readonly siteId: string | null = null;
  readonly defaultSiteIds: (string | undefined)[] = [undefined];

  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly accessions = new Map<string, string>();
  private readonly serviceTests = new Map<string, string[]>();
  private readonly equipmentServices = new Map<string, Set<string>>();
  private readonly pendingStatuses: Set<string>;
  private readonly unmappedWarned = new Set<string>();

  constructor(private readonly opts: GenxClientOptions) {
    if (!opts.tlsRejectUnauthorized) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      opts.logger.warn('TLS certificate verification is DISABLED (tlsRejectUnauthorized=false)');
    }
    for (const [svc, codes] of Object.entries(opts.serviceTests)) this.serviceTests.set(key(svc), codes);
    for (const [eq, svcs] of Object.entries(opts.equipmentServices)) {
      this.equipmentServices.set(key(eq), new Set(svcs.map(key)));
    }
    this.pendingStatuses = new Set(opts.pendingLineStatuses.map(key));
    this.loadAccessions();
    opts.logger.info(
      { baseUrl: opts.baseUrl, barcodeField: opts.barcodeField, services: this.serviceTests.size },
      'HMIS api = genx (GenX LIMS Lab Equipment API)',
    );
  }

  // ---------------------------------------------------------------------------
  // Worklist → mirth-shaped pending rows
  // ---------------------------------------------------------------------------
  async getPending(q: PendingQuery): Promise<unknown> {
    const barcode = (q.sampleId ?? '').trim().toUpperCase();
    const startedAt = Date.now();
    const pathForAudit = barcode
      ? `${this.opts.worklistPath}?barcode=${encodeURIComponent(barcode)}`
      : `${this.opts.worklistPath}?from&to (batch)`;
    try {
      const tubes = barcode ? await this.fetchByBarcode(barcode) : await this.fetchBatch();
      const rows = this.toRows(tubes, barcode, q.eqCode);
      this.record({
        kind: 'query',
        sampleId: barcode || null,
        eqCode: q.eqCode ?? null,
        method: 'GET',
        path: pathForAudit,
        startedAt,
        httpStatus: 200,
        response: barcode ? tubes : { digest: true, tubes: tubes.length, rows: rows.length },
        outcome: rows.length > 0 ? 'orders-found' : 'no-orders',
        rows: rows.length,
      });
      return rows;
    } catch (err) {
      this.record({
        kind: 'query',
        sampleId: barcode || null,
        eqCode: q.eqCode ?? null,
        method: 'GET',
        path: pathForAudit,
        startedAt,
        httpStatus: null,
        outcome: 'error',
        error: errText(err),
      });
      throw err;
    }
  }

  private async fetchByBarcode(barcode: string): Promise<GenxTube[]> {
    const path = `${this.opts.worklistPath}?barcode=${encodeURIComponent(barcode)}`;
    const payload = await this.call('GET', path, undefined, `q-${Date.now()}`);
    const tubes = contentOf(payload);
    // Defensive, like the mirth normaliser: keep only the tube asked about.
    return tubes.filter((t) => this.barcodeOf(t) === barcode || key(t.accessionNumber) === barcode);
  }

  private async fetchBatch(): Promise<GenxTube[]> {
    const to = new Date();
    const from = new Date(to.getTime() - this.opts.batchDays * 86_400_000);
    const out: GenxTube[] = [];
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({
        from: isoDate(from),
        to: isoDate(to),
        page: String(page),
        size: String(this.opts.batchPageSize),
      });
      const payload = await this.call('GET', `${this.opts.worklistPath}?${params}`, undefined, `wl-${Date.now()}`);
      const tubes = contentOf(payload);
      out.push(...tubes);
      const total = Number((payload as { totalElements?: unknown })?.totalElements ?? NaN);
      if (tubes.length < this.opts.batchPageSize || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }

  /** One mirth-shaped row per (tube, analyzer assay code). */
  private toRows(tubes: GenxTube[], barcode: string, eqCode: string): MirthPendingRow[] {
    const allowed = this.equipmentServices.get(key(eqCode)) ?? null;
    const rows: MirthPendingRow[] = [];
    let learned = false;
    for (const tube of tubes) {
      const sample = barcode || this.barcodeOf(tube);
      if (!sample) continue;
      if (tube.accessionNumber && this.accessions.get(sample) !== tube.accessionNumber) {
        this.accessions.set(sample, tube.accessionNumber);
        learned = true;
      }
      const seen = new Set<string>();
      for (const test of tube.tests ?? []) {
        const svc = key(test.serviceCode);
        if (!svc) continue;
        if (allowed && !allowed.has(svc)) continue;
        let codes = this.serviceTests.get(svc);
        if (!codes) {
          if (!this.unmappedWarned.has(svc)) {
            this.unmappedWarned.add(svc);
            this.opts.logger.warn(
              { serviceCode: test.serviceCode, serviceName: test.serviceName },
              'GenX service has no hmis.genx.serviceTests entry — offered to the analyzer under its serviceCode alone',
            );
          }
          codes = [String(test.serviceCode)];
        }
        const transmitted = !this.pendingStatuses.has(key(test.lineStatus));
        for (const code of codes) {
          const k = key(code);
          if (!k || seen.has(k)) continue; // two services sharing an analyte: one row
          seen.add(k);
          rows.push({
            sampleID: sample,
            accessionNumber: tube.accessionNumber,
            identifier: code,
            serviceCode: test.serviceCode,
            labResultId: toNum(test.sampleLineId) ?? undefined,
            labServiceId: toNum(test.serviceId) ?? undefined,
            isTransmitted: transmitted,
            priority: tube.priority,
            specimenName: tube.specimenName,
            uhid: tube.patient?.uhid,
            patientName: tube.patient?.name,
            gender: tube.patient?.genderCode,
            dateOfBirth: tube.patient?.dateOfBirth,
          });
        }
      }
    }
    if (learned) this.saveAccessions();
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Acknowledge — one entry per tube
  // ---------------------------------------------------------------------------
  async acknowledge(items: MirthAcknowledgeItem[], eqCode?: string): Promise<void> {
    if (items.length === 0) return;
    const path = this.opts.acknowledgePath;
    const startedAt = Date.now();
    const barcodes = [...new Set(items.map((i) => i.sampleID.trim().toUpperCase()))];
    let request: unknown = null;
    let response: unknown = null;
    try {
      const readAt = new Date().toISOString();
      const acknowledgements = [];
      for (const b of barcodes) {
        acknowledgements.push({
          accessionNumber: await this.accessionFor(b),
          equipmentCode: eqCode ?? '',
          messageControlId: `${eqCode ?? 'LC'}-ack-${Date.now()}-${b}`,
          readAt,
        });
      }
      request = { acknowledgements };
      response = await this.call('POST', path, request, `ack-${Date.now()}`, randomUUID());
      const answered = Array.isArray((response as { acknowledgements?: unknown })?.acknowledgements)
        ? ((response as { acknowledgements: Array<Record<string, unknown>> }).acknowledgements)
        : [];
      // `acknowledged:false` is a verdict on one tube (already resulted,
      // cancelled, not in this lab). Results are filed by then, so it is
      // logged, not thrown — a throw would only re-queue the upload.
      const refused = answered.filter((a) => a.acknowledged === false);
      if (refused.length) {
        this.opts.logger.warn({ refused }, 'GenX did not acknowledge every tube');
      }
      this.record({
        kind: 'acknowledge', sampleId: barcodes, eqCode, method: 'POST', path, startedAt,
        request, httpStatus: 200, response, outcome: 'sent', rows: answered.length - refused.length,
      });
    } catch (err) {
      this.record({
        kind: 'acknowledge', sampleId: barcodes, eqCode, method: 'POST', path, startedAt,
        request, httpStatus: null, response, outcome: 'error', rows: 0, error: errText(err),
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Results — one POST per tube
  // ---------------------------------------------------------------------------
  async postResults(rows: LisInboundResultRow[], eqCode?: string): Promise<HmisResultUploadResponse> {
    if (rows.length === 0) return { status: 'success', message: 'nothing to send', successData: [], filed: 0 };
    const byTube = new Map<string, LisInboundResultRow[]>();
    for (const r of rows) {
      const b = r.sampleId.trim().toUpperCase();
      (byTube.get(b) ?? byTube.set(b, []).get(b)!).push(r);
    }

    const successData: HmisResultUploadResponse['successData'] = [];
    const messages: string[] = [];
    for (const [barcode, tubeRows] of byTube) {
      const path = this.opts.resultsPath;
      const startedAt = Date.now();
      const filedLines = tubeRows.map((r) => `${barcode} ${r.identifier} = ${r.resultValue}`);
      let request: unknown = null;
      let response: unknown = null;
      try {
        const accessionNumber = await this.accessionFor(barcode);
        const results = tubeRows.map((r) => ({ machineTestCode: r.identifier, value: r.resultValue }));
        // Same content → same key, so a spool retry after a timeout is
        // replayed by GenX rather than filed twice. A corrected value is new
        // content and therefore a new key.
        const digest = createHash('sha256')
          .update(JSON.stringify([eqCode ?? '', accessionNumber, results]))
          .digest('hex');
        request = {
          accessionNumber,
          equipmentCode: eqCode ?? '',
          messageControlId: `${eqCode ?? 'LC'}-${digest.slice(0, 16)}`,
          results,
        };
        response = await this.call('POST', path, request, `res-${Date.now()}`, uuidFrom(digest));
        const p = (response ?? {}) as { filed?: unknown; unmatched?: unknown; panics?: unknown; outOfRange?: unknown };
        const filed = Number(p.filed ?? 0);
        const unmatched = new Set((Array.isArray(p.unmatched) ? p.unmatched : []).map((c) => key(String(c))));
        if (!(filed > 0)) {
          throw new NoneMatched(
            `GenX ${path} filed 0 of ${results.length} value(s) for ${barcode}` +
              (unmatched.size ? ` — unmatched: ${[...unmatched].join(', ')}` : ''),
          );
        }
        if (unmatched.size) {
          this.opts.logger.warn(
            { barcode, accessionNumber, unmatched: [...unmatched] },
            'GenX could not place these machine codes — set up the machineTestCode mapping in GenX for this equipmentCode',
          );
        }
        if (Array.isArray(p.panics) && p.panics.length) this.opts.logger.warn({ barcode, panics: p.panics }, 'GenX flagged panic values');
        for (const r of tubeRows) {
          if (unmatched.has(key(r.identifier))) continue;
          successData.push({
            sampleId: r.sampleId,
            labServiceId: r.labServiceId ?? undefined,
            labResultId: r.labResultId ?? undefined,
          });
        }
        messages.push(`${barcode}: filed ${filed}`);
        this.record({
          kind: 'result', sampleId: barcode, eqCode, method: 'POST', path, startedAt,
          request, httpStatus: 200, response, outcome: 'filed', rows: filed, filed: filedLines,
        });
      } catch (err) {
        this.record({
          kind: 'result', sampleId: barcode, eqCode, method: 'POST', path, startedAt,
          request, httpStatus: err instanceof NoneMatched ? 200 : null, response,
          outcome: err instanceof NoneMatched ? 'none-matched' : 'error', rows: 0, error: errText(err), filed: filedLines,
        });
        throw err;
      }
    }
    return { status: 'success', message: messages.join('; '), successData, filed: successData.length };
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------
  private barcodeOf(t: GenxTube): string {
    return key(this.opts.barcodeField === 'accessionNumber' ? t.accessionNumber : t.sampleNumber);
  }

  private async accessionFor(barcode: string): Promise<string> {
    const known = this.accessions.get(barcode);
    if (known) return known;
    if (this.opts.barcodeField === 'accessionNumber') return barcode;
    await this.fetchByBarcode(barcode).then((tubes) => this.toRows(tubes, barcode, ''));
    const found = this.accessions.get(barcode);
    if (!found) throw new Error(`GenX has no accessionNumber for tube ${barcode} — the worklist does not know it`);
    return found;
  }

  /** Authenticated call; returns the unwrapped payload (`data.data`). */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    correlation: string,
    idempotencyKey?: string,
    retried = false,
  ): Promise<unknown> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-correlation-id': `lc-${correlation}`,
      'x-request-timestamp': new Date().toISOString(),
    };
    if (this.opts.apiKey) headers[this.opts.apiKeyHeader] = this.opts.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const { status, text } = await this.send(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
    if (status === 401 && !retried) {
      this.token = null; // expired or revoked early — fetch a new one once
      return this.call(method, path, body, correlation, idempotencyKey, true);
    }
    if (status === 401 || status === 403) {
      throw new HmisUnavailableError(`GenX ${method} ${path} -> HTTP ${status}: ${text.slice(0, 300)}`);
    }
    if (status < 200 || status >= 300) {
      const message = `GenX ${method} ${path} -> HTTP ${status}: ${text.slice(0, 300)}`;
      throw status >= 500 || status === 429 ? new HmisUnavailableError(message) : new Error(message);
    }
    const parsed = parseJson(text);
    const outer = (parsed ?? {}) as { success?: unknown; data?: unknown; message?: unknown };
    const inner = (outer.data ?? {}) as { success?: unknown; data?: unknown; message?: unknown };
    if (outer.success === false || inner.success === false) {
      throw new Error(`GenX ${method} ${path} refused: ${String(inner.message ?? outer.message ?? 'success=false')}`);
    }
    return inner.data ?? null;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    if (!this.opts.clientId || !this.opts.clientSecret) {
      throw new HmisUnavailableError('GenX clientId / clientSecret are not configured (hmis.genx)');
    }
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.opts.scope) form.set('scope', this.opts.scope);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (this.opts.clientAuth === 'basic') {
      headers.authorization = 'Basic ' + Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    } else {
      form.set('client_id', this.opts.clientId);
      form.set('client_secret', this.opts.clientSecret);
    }
    const { status, text } = await this.send('POST', this.opts.tokenPath, headers, form.toString());
    const body = parseJson(text) as { access_token?: string; expires_in?: number } | null;
    if (status < 200 || status >= 300 || !body?.access_token) {
      // Not a verdict on any one result — every call would fail the same way.
      throw new HmisUnavailableError(`GenX token request -> HTTP ${status}: ${text.slice(0, 300)}`);
    }
    const ttl = Math.max(30, Number(body.expires_in ?? 3600) - 60);
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl * 1000 };
    this.opts.logger.info({ expiresInS: ttl }, 'GenX access token obtained');
    return body.access_token;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HmisUnavailableError(`GenX ${method} ${path} -> timed out after ${this.opts.timeoutMs}ms`);
      }
      if (err instanceof TypeError) {
        throw new HmisUnavailableError(`GenX ${method} ${path} -> ${(err.cause as Error | undefined)?.message ?? err.message}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private loadAccessions(): void {
    const file = this.opts.accessionCacheFile;
    if (!file || !existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      for (const [b, a] of Object.entries(saved)) this.accessions.set(b, a);
    } catch (err) {
      this.opts.logger.warn({ file, err: errText(err) }, 'GenX accession cache unreadable — starting empty');
    }
  }

  private saveAccessions(): void {
    const file = this.opts.accessionCacheFile;
    if (!file) return;
    // Bounded: the newest 20 000 tubes are far more than the retention window.
    const entries = [...this.accessions.entries()].slice(-20_000);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
    } catch (err) {
      this.opts.logger.warn({ file, err: errText(err) }, 'GenX accession cache could not be written');
    }
  }

  private record(e: {
    kind: HmisAuditKind;
    sampleId: string | string[] | null;
    eqCode?: string | null;
    filed?: string[];
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
      filed: e.filed,
    });
  }
}

class NoneMatched extends Error {}

function key(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim().toUpperCase();
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function contentOf(payload: unknown): GenxTube[] {
  if (Array.isArray(payload)) return payload as GenxTube[];
  const c = (payload as { content?: unknown } | null)?.content;
  return Array.isArray(c) ? (c as GenxTube[]) : [];
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A stable UUID-shaped Idempotency-Key from a content digest. */
function uuidFrom(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
