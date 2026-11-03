import type { Logger } from '../logger.js';
import type { HmisResultUploadResponse, LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';
import type { HmisAudit, HmisAuditOutcome } from './audit.js';
import { HmisUnavailableError } from './client.js';
import { httpSend, type ClientTls } from './http.js';
import type { ResultSink } from './tatva.js';

// =============================================================================
// Tatva v1, `auth: "equipment"` — the Mirth-compatibility dialect of the new
// system (Postman folder "3. Mirth Compatibility").
//
//   POST {baseUrl}{resultsPath}      [{ sampleId, identifier, resultValue, unit,
//                                       abnormalFlag, uniqueIdentifier, isLoaded }]
//   POST {baseUrl}{acknowledgePath}  [{ sampleID, eqCode, identifier,
//                                       isTransmitted, ipAddress, portNo }]
//   headers on every call: X-Equipment-ID + X-Equipment-Secret
//
// The credential is per MACHINE (Analyser Interface → rotate key), so one
// client is built per analyzer from its `tatva` block.
//
// `sampleId` takes the tube barcode as it is (accession OR sample number), so
// no worklist lookup is needed.
//
// The answer is { status, message, filed }. Per the contract `status:
// "success"` does NOT prove a value was saved, so:
//   • `filed` is compared with the number of values sent;
//   • an identifier the message names next to "unmapped" / "Outside the
//     reportable range" is reported as unmatched (stays pending, retried);
//   • filed 0 is a failure.
// The endpoint has NO duplicate guard on uniqueIdentifier. It is derived from
// the content, so a resend carries the same id and a double file is traceable.
// =============================================================================

export interface TatvaEquipmentOptions {
  baseUrl: string;
  resultsPath: string;
  acknowledgePath: string;
  equipmentId: string;
  equipmentSecret: string;
  /** Extra headers on every call (X-Facility-ID …). */
  extraHeaders?: Record<string, string>;
  /** Client certificate for mTLS; null/absent = none. */
  tls?: ClientTls | null;
  timeoutMs: number;
  logger: Logger;
  audit?: HmisAudit;
}

export class TatvaEquipmentClient implements ResultSink {
  constructor(private readonly opts: TatvaEquipmentOptions) {
    if (!opts.equipmentId || !opts.equipmentSecret) {
      throw new Error('Tatva v1 equipment auth needs tatva.equipmentId and tatva.equipmentSecret on the analyzer');
    }
  }

  async postResults(rows: LisInboundResultRow[], eqCode?: string): Promise<HmisResultUploadResponse> {
    if (rows.length === 0) return { status: 'success', message: 'nothing to send', successData: [], filed: 0 };

    const path = this.opts.resultsPath;
    const request = rows.map((r) => ({
      sampleId: r.sampleId,
      identifier: r.identifier,
      resultValue: r.resultValue,
      unit: r.unit ?? '',
      abnormalFlag: r.abnormalFlag ?? '',
      uniqueIdentifier: `LC-${this.opts.equipmentId}-${r.sampleId}-${r.identifier}-${shortHash(r.resultValue)}`,
      isLoaded: false,
    }));
    const filedLines = rows.map((r) => `${r.sampleId} ${r.identifier} = ${r.resultValue}`);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let response: unknown = null;

    try {
      const answer = await this.post(path, request);
      httpStatus = answer.status;
      response = answer.json ?? answer.text;

      const body = (answer.json ?? {}) as { status?: unknown; message?: unknown; filed?: unknown };
      const status = String(body.status ?? '').toLowerCase();
      const message = String(body.message ?? '');
      if (status !== 'success') {
        throw new NothingFiled(`Tatva v1 ${path} rejected the upload: ${message || 'status=' + status}`);
      }

      const unmatched = refusedCodes(message, rows);
      const filed = Number.isFinite(Number(body.filed)) ? Number(body.filed) : rows.length - unmatched.length;
      if (!(filed > 0)) {
        throw new NothingFiled(`Tatva v1 ${path} filed 0 of ${rows.length} value(s): ${message}`);
      }
      if (rows.length - filed > unmatched.length) {
        this.opts.logger.warn(
          { sent: rows.length, filed, named: unmatched, message },
          'Tatva v1 filed fewer values than sent and the message does not say which — check logs/hmis-tatva',
        );
      }

      const refused = new Set(unmatched);
      const successData = rows
        .filter((r) => !refused.has(codeKey(r.identifier)))
        .map((r) => ({ sampleId: r.sampleId, labServiceId: r.labServiceId ?? undefined, labResultId: r.labResultId ?? undefined }));

      this.audit({ kind: 'result', path, rows, startedAt, request, httpStatus, response, outcome: 'filed', count: filed, eqCode, filed: filedLines });
      return { status: 'success', message, successData, filed: successData.length, unmatched };
    } catch (err) {
      const outcome: HmisAuditOutcome = err instanceof NothingFiled ? 'none-matched' : 'error';
      this.audit({ kind: 'result', path, rows, startedAt, request, httpStatus, response, outcome, count: 0, error: errText(err), eqCode, filed: filedLines });
      throw err;
    }
  }

  async acknowledge(items: MirthAcknowledgeItem[], eqCode?: string): Promise<void> {
    if (items.length === 0) return;

    const path = this.opts.acknowledgePath;
    const request = items.map((i) => ({
      sampleID: i.sampleID,
      eqCode: eqCode ?? '',
      identifier: i.identifier,
      isTransmitted: true,
      ipAddress: i.ipAddress ?? '',
      portNo: i.portNo ?? '',
    }));
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let response: unknown = null;

    try {
      const answer = await this.post(path, request);
      httpStatus = answer.status;
      response = answer.json ?? answer.text;
      this.audit({ kind: 'acknowledge', path, rows: items, startedAt, request, httpStatus, response, outcome: 'sent', count: items.length, eqCode });
    } catch (err) {
      this.audit({ kind: 'acknowledge', path, rows: items, startedAt, request, httpStatus, response, outcome: 'error', count: 0, error: errText(err), eqCode });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<{ status: number; text: string; json: unknown }> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    try {
      const res = await httpSend(url, {
        method: 'POST',
        headers: {
          ...this.opts.extraHeaders,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-equipment-id': this.opts.equipmentId,
          'x-equipment-secret': this.opts.equipmentSecret,
          'x-correlation-id': `lc-${Date.now()}`,
          'x-request-timestamp': new Date().toISOString(),
        },
        body: JSON.stringify(body),
        timeoutMs: this.opts.timeoutMs,
        tls: this.opts.tls,
      });
      const text = res.text;
      if (res.status < 200 || res.status >= 300) {
        const message = `Tatva v1 POST ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`;
        // 401/403: the credential is wrong or was rotated — every call fails
        // the same way, so the queue is held instead of burning retries.
        const holdQueue = res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429;
        throw holdQueue ? new HmisUnavailableError(message) : new Error(message);
      }
      return { status: res.status, text, json: parseJson(text) };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HmisUnavailableError(`Tatva v1 POST ${path} -> timed out after ${this.opts.timeoutMs}ms`);
      }
      if (err instanceof TypeError) {
        throw new HmisUnavailableError(`Tatva v1 POST ${path} -> ${(err.cause as Error | undefined)?.message ?? err.message}`);
      }
      throw err;
    }
  }

  /** One line in logs/hmis-tatva. The secret is a header and is never logged. */
  private audit(e: {
    kind: 'result' | 'acknowledge';
    path: string;
    rows: Array<{ sampleId?: string; sampleID?: string }>;
    startedAt: number;
    request: unknown;
    httpStatus: number | null;
    response: unknown;
    outcome: HmisAuditOutcome;
    count: number;
    error?: string;
    eqCode?: string;
    filed?: string[];
  }): void {
    this.opts.audit?.record({
      ts: new Date().toISOString(),
      kind: e.kind,
      sampleId: [...new Set(e.rows.map((r) => String(r.sampleId ?? r.sampleID ?? '')))],
      eqCode: e.eqCode,
      method: 'POST',
      url: this.opts.baseUrl.replace(/\/$/, '') + e.path,
      request: e.request,
      httpStatus: e.httpStatus,
      response: e.response,
      durationMs: Date.now() - e.startedAt,
      outcome: e.outcome,
      rows: e.count,
      error: e.error,
      filed: e.filed,
    });
  }
}

class NothingFiled extends Error {}

function codeKey(v: string): string {
  return v.trim().toUpperCase();
}

/** Identifiers (upper-cased) the message names as not saved. */
export function refusedCodes(message: string, rows: LisInboundResultRow[]): string[] {
  if (!/unmapped|not mapped|unmatched|outside the reportable range/i.test(message)) return [];
  const text = message.toUpperCase();
  const out = new Set<string>();
  for (const r of rows) {
    const code = codeKey(r.identifier);
    if (code && containsWord(text, code)) out.add(code);
  }
  return [...out];
}

/** `word` appears in `text` not glued to other letters/digits. */
function containsWord(text: string, word: string): boolean {
  const isWordChar = (c: string | undefined) => !!c && /[A-Z0-9]/.test(c);
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + word.length])) return true;
  }
  return false;
}

function shortHash(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
