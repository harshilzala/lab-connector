import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { HmisResultUploadResponse, LisInboundResultRow, MirthAcknowledgeItem, MirthPendingRow } from '../types.js';
import type { HmisAudit, HmisAuditKind, HmisAuditOutcome } from './audit.js';
import { HmisRefusedError, HmisUnavailableError, type HmisGateway, type PendingQuery } from './client.js';
import { httpSend } from './http.js';

// =============================================================================
// GenX LIMS — lims-node "Lab Connector" routes (hmis.genx.profile "lims-node").
//
// Source: Lab-API.postman_collection.json, "GenX Lab (lims-node) API",
// generated from the lims-node route table (2026-11-17):
//
//   POST {authBaseUrl}/api/auth/login      { userName, password, … } → { token }
//        (auth "login"; auth "oauth" = client_credentials on tokenPath)
//   every call: Authorization: Bearer <token>, module-code: DS
//   envelope:   { success, message, data, timestamp }   (ONE level)
//
//   GET  {apiPrefix}/connector/orders?equipmentCode=&barcode=&date=
//   POST {apiPrefix}/connector/acknowledge  { equipmentCode, barcodes: [..] }
//   POST {apiPrefix}/connector/results      { barcode, equipmentCode, messageId,
//                                             reliabilityPct?, values: [{ parameterId |
//                                             parameterCode, value, unit, rawValue,
//                                             machineUnit, remarks }] }
//   POST {apiPrefix}/lines/auto-certify     { sampleLineIds: [..] }
//
// THE ORDERS RESPONSE SHAPE IS NOT IN THE COLLECTION (no example responses).
// toRows() therefore reads it tolerantly: the tube list may be the payload
// itself or under content / orders / items / tubes / samples / rows; a tube's
// lines under tests / lines / orderLines / services; a line's analytes under
// parameters / analytes / results / values. A line WITH analytes gives one
// row per analyte (identifier = machineTestCode, else parameterCode, and its
// parameterId kept so the result names it exactly); a line without them is
// expanded through hmis.genx.serviceTests, as on the old GenX contract.
// Check one real answer (audit log) before go-live and narrow this if needed.
//
// Like GenxHmisClient this is an ADAPTER: rows come out mirth-shaped, so the
// order store, the staged filer and every analyzer are unchanged.
// =============================================================================

export interface GenxLimsOptions {
  baseUrl: string;
  /** Host of auth-node for auth "login"/"oauth"; empty = baseUrl. */
  authBaseUrl: string;
  auth: 'login' | 'oauth';
  loginPath: string;
  username: string;
  password: string;
  /** OAuth client_credentials (auth "oauth"). */
  tokenPath: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  clientAuth: 'basic' | 'body';
  apiKey?: string;
  apiKeyHeader: string;
  /** Sent as `module-code` on every call (lims-node expects "DS"). */
  moduleCode: string;
  ordersPath: string;
  acknowledgePath: string;
  resultsPath: string;
  autoCertifyPath: string;
  /** The tube field that is the barcode the analyzer reads. */
  barcodeField: 'barcode' | 'sampleNumber' | 'accessionNumber';
  serviceTests: Record<string, string[]>;
  /** Line statuses still waiting for a result. EMPTY = every line listed is
   *  pending (lims-node's connector/orders lists open work only). */
  pendingLineStatuses: string[];
  /** Bulk poll: today and this many days back, one call per day. */
  batchDays: number;
  /** Sent as reliabilityPct when set. */
  reliabilityPct: number | null;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  logger: Logger;
  audit?: HmisAudit;
}

type Obj = Record<string, unknown>;

export class GenxLimsClient implements HmisGateway {
  readonly siteId: string | null = null;
  readonly defaultSiteIds: (string | undefined)[] = [undefined];
  /** One call per equipment code per tick (the server filters by it). */
  readonly ignoresPollFilters = true;
  readonly rowStyle = 'genx' as const;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly serviceTests = new Map<string, string[]>();
  private readonly pendingStatuses: Set<string>;
  /** barcode|identifier → how to name it in the results call. */
  private readonly params = new Map<string, { parameterId?: number; parameterCode?: string }>();
  private readonly unmappedWarned = new Set<string>();

  constructor(private readonly opts: GenxLimsOptions) {
    if (!opts.tlsRejectUnauthorized) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      opts.logger.warn('TLS certificate verification is DISABLED (tlsRejectUnauthorized=false)');
    }
    for (const [svc, codes] of Object.entries(opts.serviceTests)) this.serviceTests.set(key(svc), codes);
    this.pendingStatuses = new Set(opts.pendingLineStatuses.map(key).filter(Boolean));
    opts.logger.info({ baseUrl: opts.baseUrl, auth: opts.auth, barcodeField: opts.barcodeField }, 'HMIS api = genx (GenX lims-node connector routes)');
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------
  async getPending(q: PendingQuery): Promise<unknown> {
    const barcode = (q.sampleId ?? '').trim().toUpperCase();
    const eqCode = (q.eqCode ?? '').trim();
    const startedAt = Date.now();
    const auditPath = `${this.opts.ordersPath}?equipmentCode=${eqCode}${barcode ? `&barcode=${barcode}` : '&date=… (batch)'}`;
    try {
      const tubes = barcode ? await this.fetch({ equipmentCode: eqCode, barcode }) : await this.fetchBatch(eqCode);
      const rows = this.toRows(barcode ? tubes.filter((t) => this.barcodeOf(t) === barcode || !this.barcodeOf(t)) : tubes, barcode);
      this.record({
        kind: 'query', sampleId: barcode || null, eqCode, method: 'GET', path: auditPath, startedAt, httpStatus: 200,
        response: barcode ? tubes : { digest: true, tubes: tubes.length, rows: rows.length },
        outcome: rows.length ? 'orders-found' : 'no-orders', rows: rows.length,
      });
      return rows;
    } catch (err) {
      this.record({ kind: 'query', sampleId: barcode || null, eqCode, method: 'GET', path: auditPath, startedAt, httpStatus: null, outcome: 'error', error: errText(err) });
      throw err;
    }
  }

  private async fetch(params: Record<string, string>): Promise<Obj[]> {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ''));
    const payload = await this.call('GET', `${this.opts.ordersPath}?${qs}`, undefined);
    return tubesOf(payload);
  }

  private async fetchBatch(eqCode: string): Promise<Obj[]> {
    const out: Obj[] = [];
    const now = Date.now();
    for (let d = 0; d <= this.opts.batchDays; d++) {
      out.push(...(await this.fetch({ equipmentCode: eqCode, date: localDate(new Date(now - d * 86_400_000)) })));
    }
    return out;
  }

  /** One mirth-shaped row per (tube, analyte). */
  toRows(tubes: Obj[], barcode: string): MirthPendingRow[] {
    const rows: MirthPendingRow[] = [];
    for (const tube of tubes) {
      const sample = barcode || this.barcodeOf(tube);
      if (!sample) continue;
      const patient = (isObj(tube.patient) ? tube.patient : tube) as Obj;
      const common = {
        sampleID: sample,
        priority: str(tube.priority),
        specimenName: str(tube.specimenName ?? tube.specimen),
        uhid: str(patient.uhid ?? patient.patientUhid),
        patientName: str(patient.name ?? patient.patientName),
        gender: str(patient.genderCode ?? patient.gender ?? patient.patientGenderCode),
        dateOfBirth: str(patient.dateOfBirth ?? patient.dob ?? patient.patientDob),
      };
      const seen = new Set<string>();
      const lines = arr(tube.tests ?? tube.lines ?? tube.orderLines ?? tube.services);
      // A tube that lists its analytes directly is one line.
      const effective = lines.length ? lines : arr(tube.parameters ?? tube.analytes).length ? [tube] : [];
      for (const line of effective) {
        const status = key(line.lineStatus ?? line.status);
        const transmitted = this.pendingStatuses.size > 0 && status !== '' && !this.pendingStatuses.has(status);
        const lineId = num(line.sampleLineId ?? line.labOrderLineId ?? line.lineId ?? line.id);
        const serviceId = num(line.serviceId);
        const analytes = arr(line.parameters ?? line.analytes ?? line.results ?? line.values);
        const entries: Array<{ code: string; parameterId?: number; parameterCode?: string }> = [];
        if (analytes.length) {
          for (const a of analytes) {
            const parameterCode = str(a.parameterCode ?? a.code);
            const code = str(a.machineTestCode ?? a.machineCode ?? a.instrumentCode) || parameterCode;
            if (!code) continue;
            entries.push({ code, parameterId: num(a.parameterId) ?? undefined, parameterCode: parameterCode || undefined });
          }
        } else {
          const svc = key(line.serviceCode);
          if (!svc) continue;
          let codes = this.serviceTests.get(svc);
          if (!codes) {
            if (!this.unmappedWarned.has(svc)) {
              this.unmappedWarned.add(svc);
              this.opts.logger.warn({ serviceCode: line.serviceCode }, 'GenX line has no analytes and no hmis.genx.serviceTests entry — offered under its serviceCode alone');
            }
            codes = [String(line.serviceCode)];
          }
          for (const c of codes) entries.push({ code: String(c) });
        }
        const lineCodes = entries.map((e) => e.code);
        for (const e of entries) {
          const k = key(e.code);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          this.params.set(`${sample}|${k}`, { parameterId: e.parameterId, parameterCode: e.parameterCode });
          rows.push({
            ...common,
            identifier: e.code,
            labResultId: lineId ?? undefined,
            labServiceId: serviceId ?? undefined,
            parameterId: e.parameterId,
            serviceCode: str(line.serviceCode) || undefined,
            lineCodes,
            isTransmitted: transmitted,
          });
        }
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Acknowledge
  // ---------------------------------------------------------------------------
  async acknowledge(items: MirthAcknowledgeItem[], eqCode?: string): Promise<void> {
    if (!items.length) return;
    const path = this.opts.acknowledgePath;
    const barcodes = [...new Set(items.map((i) => String(i.sampleID).trim().toUpperCase()))];
    const request = { equipmentCode: eqCode ?? '', barcodes };
    const startedAt = Date.now();
    let response: unknown = null;
    try {
      response = await this.call('POST', path, request);
      const refused = verdicts(response).filter((v) => v.acknowledged === false || /fail|reject|refus|error/i.test(String(v.status ?? v.verdict ?? '')));
      if (refused.length) this.opts.logger.warn({ refused }, 'GenX did not acknowledge every tube');
      this.record({ kind: 'acknowledge', sampleId: barcodes, eqCode, method: 'POST', path, startedAt, request, httpStatus: 200, response, outcome: 'sent', rows: barcodes.length - refused.length });
    } catch (err) {
      this.record({ kind: 'acknowledge', sampleId: barcodes, eqCode, method: 'POST', path, startedAt, request, httpStatus: null, response, outcome: 'error', rows: 0, error: errText(err) });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Results — one POST per tube
  // ---------------------------------------------------------------------------
  async postResults(rows: LisInboundResultRow[], eqCode?: string): Promise<HmisResultUploadResponse> {
    if (!rows.length) return { status: 'success', message: 'nothing to send', successData: [], filed: 0 };
    const byTube = new Map<string, LisInboundResultRow[]>();
    for (const r of rows) {
      const b = r.sampleId.trim().toUpperCase();
      (byTube.get(b) ?? byTube.set(b, []).get(b)!).push(r);
    }
    const successData: HmisResultUploadResponse['successData'] = [];
    const unplaced = new Set<string>();
    const messages: string[] = [];
    for (const [barcode, tubeRows] of byTube) {
      const path = this.opts.resultsPath;
      const startedAt = Date.now();
      const filedLines = tubeRows.map((r) => `${barcode} ${r.identifier} = ${r.resultValue}`);
      // How each value is named, and back again for the answer.
      const back = new Map<string, string>();
      const values = tubeRows.map((r) => {
        const known = this.params.get(`${barcode}|${key(r.identifier)}`);
        const parameterId = r.parameterId ?? known?.parameterId;
        const name = parameterId != null ? { parameterId } : { parameterCode: known?.parameterCode ?? r.identifier };
        back.set(key(parameterId != null ? parameterId : (name as { parameterCode: string }).parameterCode), key(r.identifier));
        back.set(key(r.identifier), key(r.identifier));
        return {
          ...name,
          value: r.resultValue,
          ...(r.unit ? { unit: r.unit, machineUnit: r.unit } : {}),
          rawValue: r.resultValue,
          remarks: null,
        };
      });
      const digest = createHash('sha256').update(JSON.stringify([eqCode ?? '', barcode, values])).digest('hex');
      const request = {
        barcode,
        equipmentCode: eqCode ?? '',
        messageId: `${eqCode ?? 'LC'}-${digest.slice(0, 16)}`,
        ...(this.opts.reliabilityPct != null ? { reliabilityPct: this.opts.reliabilityPct } : {}),
        values,
      };
      let response: unknown = null;
      try {
        response = await this.call('POST', path, request, uuidFrom(digest));
        const p = (isObj(response) ? response : {}) as Obj;
        const allCodes = tubeRows.map((r) => key(r.identifier));
        if (/fail/i.test(String(p.status ?? ''))) throw new NoneMatched(`GenX ${path} answered status ${String(p.status)} for ${barcode}: ${String(p.message ?? '')}`, allCodes);
        const unmatched = new Set<string>();
        for (const c of [...arr(p.unmatched), ...arr(p.rejected), ...arr(p.failed), ...rawList(p.unmatched), ...rawList(p.rejected)]) {
          const code = key(codeOfEntry(c));
          if (code) unmatched.add(back.get(code) ?? code);
        }
        for (const v of arr(p.values ?? p.results)) {
          const st = String(v.status ?? v.outcome ?? '');
          if (st && !/^(success|filed|saved|ok|accepted|updated)$/i.test(st)) {
            const code = key(codeOfEntry(v));
            if (code) unmatched.add(back.get(code) ?? code);
          }
        }
        const filedRaw = p.filed ?? p.saved ?? p.accepted;
        const filed = Number.isFinite(Number(filedRaw)) && filedRaw !== null && filedRaw !== undefined ? Number(filedRaw) : values.length - unmatched.size;
        if (!(filed > 0)) {
          throw new NoneMatched(
            `GenX ${path} filed 0 of ${values.length} value(s) for ${barcode}${unmatched.size ? ` — unmatched: ${[...unmatched].join(', ')}` : ''}`,
            unmatched.size ? [...unmatched] : allCodes,
          );
        }
        for (const c of unmatched) unplaced.add(c);
        if (unmatched.size) this.opts.logger.warn({ barcode, unmatched: [...unmatched] }, 'GenX did not place these values — check the parameter mapping for this equipmentCode');
        for (const r of tubeRows) {
          if (unmatched.has(key(r.identifier))) continue;
          successData.push({ sampleId: r.sampleId, labServiceId: r.labServiceId ?? undefined, labResultId: r.labResultId ?? undefined });
        }
        messages.push(`${barcode}: filed ${filed}`);
        this.record({ kind: 'result', sampleId: barcode, eqCode, method: 'POST', path, startedAt, request, httpStatus: 200, response, outcome: 'filed', rows: filed, filed: filedLines });
      } catch (err) {
        this.record({
          kind: 'result', sampleId: barcode, eqCode, method: 'POST', path, startedAt, request, httpStatus: err instanceof NoneMatched ? 200 : null,
          response, outcome: err instanceof NoneMatched ? 'none-matched' : 'error', rows: 0, error: errText(err), filed: filedLines,
        });
        throw err;
      }
    }
    return { status: 'success', message: messages.join('; '), successData, filed: successData.length, unmatched: [...unplaced] };
  }

  // ---------------------------------------------------------------------------
  // Auto-certify — one result line
  // ---------------------------------------------------------------------------
  async autoCertify(lineId: number, eqCode?: string, barcode?: string): Promise<void> {
    const path = this.opts.autoCertifyPath;
    const request = { sampleLineIds: [lineId] };
    const startedAt = Date.now();
    let response: unknown = null;
    try {
      response = await this.call('POST', path, request);
      const refused = verdicts(response).filter((v) => v.certified === false || v.signed === false || !!v.reason || !!v.refusalReason);
      if (refused.length) throw new Error(`GenX auto-certify refused line ${lineId}: ${JSON.stringify(refused[0]).slice(0, 200)}`);
      this.record({ kind: 'certify', sampleId: barcode ?? null, eqCode, method: 'POST', path, startedAt, request, httpStatus: 200, response, outcome: 'sent', rows: 1, filed: [`labResultId ${lineId} certified`] });
    } catch (err) {
      this.record({ kind: 'certify', sampleId: barcode ?? null, eqCode, method: 'POST', path, startedAt, request, httpStatus: null, response, outcome: 'error', rows: 0, error: errText(err) });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------
  private barcodeOf(t: Obj): string {
    const f = this.opts.barcodeField;
    return key(f === 'barcode' ? (t.barcode ?? t.sampleNumber) : t[f]);
  }

  /** Authenticated call; returns `data` of the { success, message, data } envelope. */
  private async call(method: 'GET' | 'POST', path: string, body: unknown, idempotencyKey?: string, retried = false): Promise<unknown> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'module-code': this.opts.moduleCode,
      'x-correlation-id': `lc-${Date.now()}`,
    };
    if (this.opts.apiKey) headers[this.opts.apiKeyHeader] = this.opts.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const { status, text } = await this.send(this.opts.baseUrl, method, path, headers, body === undefined ? undefined : JSON.stringify(body));
    if (status === 401 && !retried) {
      this.token = null;
      return this.call(method, path, body, idempotencyKey, true);
    }
    if (status === 401 || status === 403) throw new HmisUnavailableError(`GenX ${method} ${path} -> HTTP ${status}: ${text.slice(0, 300)}`);
    if (status < 200 || status >= 300) {
      const message = `GenX ${method} ${path} -> HTTP ${status}: ${text.slice(0, 300)}`;
      throw status >= 500 || status === 429 ? new HmisUnavailableError(message) : new Error(message);
    }
    const parsed = parseJson(text);
    if (isObj(parsed) && 'success' in parsed) {
      if (parsed.success === false) throw new Error(`GenX ${method} ${path} refused: ${String(parsed.message ?? 'success=false')}`);
      return parsed.data ?? null;
    }
    return parsed;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenInFlight ??= (this.opts.auth === 'oauth' ? this.oauthToken() : this.loginToken()).finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private get authBase(): string {
    return this.opts.authBaseUrl || this.opts.baseUrl;
  }

  private async loginToken(): Promise<string> {
    if (!this.opts.username || !this.opts.password) {
      throw new HmisUnavailableError('GenX login needs hmis.genx.lims.username / password (env GENX_USERNAME / GENX_PASSWORD)');
    }
    const body = JSON.stringify({
      userName: this.opts.username,
      password: this.opts.password,
      userLoginHistoryInput: { usingDetailsHistory: [{}] },
    });
    const { status, text } = await this.send(this.authBase, 'POST', this.opts.loginPath, { 'content-type': 'application/json', accept: 'application/json' }, body);
    const p = parseJson(text) as Obj | null;
    const d = (isObj(p?.data) ? p!.data : {}) as Obj;
    const token = str(p?.token ?? d.token ?? d.accessToken ?? p?.accessToken);
    if (status < 200 || status >= 300 || !token) {
      throw new HmisUnavailableError(`GenX login -> HTTP ${status}: ${redact(text).slice(0, 200)}`);
    }
    this.token = { value: token, expiresAt: jwtExpiry(token) ?? Date.now() + 50 * 60_000 };
    this.opts.logger.info('GenX login token obtained');
    return token;
  }

  private async oauthToken(): Promise<string> {
    if (!this.opts.clientId || !this.opts.clientSecret) throw new HmisUnavailableError('GenX clientId / clientSecret are not configured (hmis.genx)');
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.opts.scope) form.set('scope', this.opts.scope);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.opts.clientAuth === 'basic') headers.authorization = 'Basic ' + Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    else {
      form.set('client_id', this.opts.clientId);
      form.set('client_secret', this.opts.clientSecret);
    }
    const { status, text } = await this.send(this.authBase, 'POST', this.opts.tokenPath, headers, form.toString());
    const b = parseJson(text) as { access_token?: string; expires_in?: number } | null;
    if (status < 200 || status >= 300 || !b?.access_token) throw new HmisUnavailableError(`GenX token request -> HTTP ${status}: ${text.slice(0, 300)}`);
    const ttl = Math.max(30, Number(b.expires_in ?? 3600) - 60);
    this.token = { value: b.access_token, expiresAt: Date.now() + ttl * 1000 };
    return b.access_token;
  }

  private async send(base: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    const url = base.replace(/\/$/, '') + path;
    try {
      return await httpSend(url, { method, headers, body, timeoutMs: this.opts.timeoutMs, tls: null });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new HmisUnavailableError(`GenX ${method} ${path} -> timed out after ${this.opts.timeoutMs}ms`);
      if (err instanceof TypeError) throw new HmisUnavailableError(`GenX ${method} ${path} -> ${(err.cause as Error | undefined)?.message ?? err.message}`);
      throw err;
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

/** Filed nothing: a verdict on the values sent, not an outage. */
class NoneMatched extends HmisRefusedError {}

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v.filter(isObj) as Obj[]) : [];
}
function rawList(v: unknown): unknown[] {
  return Array.isArray(v) ? v.filter((x) => !isObj(x)) : [];
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}
function key(v: unknown): string {
  return str(v).toUpperCase();
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The tube list, wherever the answer keeps it. */
export function tubesOf(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return arr(payload);
  if (!isObj(payload)) return [];
  for (const k of ['content', 'orders', 'items', 'tubes', 'samples', 'rows', 'data']) {
    if (Array.isArray(payload[k])) return arr(payload[k]);
  }
  if (payload.barcode || payload.sampleNumber || payload.accessionNumber) return [payload];
  return [];
}

/** Per-item verdicts in an acknowledge / certify answer. */
function verdicts(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return arr(payload);
  if (!isObj(payload)) return [];
  for (const k of ['results', 'verdicts', 'barcodes', 'items', 'lines', 'refused']) {
    if (Array.isArray(payload[k])) return arr(payload[k]);
  }
  return [];
}

function codeOfEntry(c: unknown): string {
  if (isObj(c)) return str(c.parameterId ?? c.parameterCode ?? c.machineTestCode ?? c.code ?? c.identifier);
  return str(c);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** YYYY-MM-DD in the server's local time (IST here), not UTC. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function jwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: number };
    return claims.exp ? claims.exp * 1000 - 60_000 : null;
  } catch {
    return null;
  }
}

function redact(text: string): string {
  return text.replace(/"(password|token|accessToken)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}

function uuidFrom(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
