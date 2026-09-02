import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

// =============================================================================
// HMIS transaction log — one JSON line per call to the gateway.
//
// The main application log says what the connector DECIDED ("order download
// sent", "results filed"). This file says what actually crossed the wire: the
// URL, the request body, the HTTP status and the gateway's own response, for
// every query, acknowledge and result upload.
//
// It exists because this gateway answers HTTP 200 with status:"success" even
// when it matched nothing at all — so "did HMIS take it?" cannot be answered
// from a status code, and a plain success log line is not evidence. Each entry
// therefore carries an `outcome` verdict derived from the response body, not
// from the transport.
//
// Format is line-delimited JSON so a single barcode's whole history is one
// grep:  findstr LB2609020570 logs\hmis.log
// =============================================================================

/** Which of the three endpoints the entry describes. */
export type HmisAuditKind = 'query' | 'acknowledge' | 'result';

/**
 * The verdict, judged on the response BODY:
 *   orders-found  the query returned at least one pending row
 *   no-orders     the query succeeded but the sample has no work
 *   filed         the gateway accepted at least one result row
 *   none-matched  HTTP 200 + status success, but zero rows accepted — the
 *                 silent-drop case this log exists to make visible
 *   error         transport failure, timeout, or a non-2xx status
 */
export type HmisAuditOutcome = 'orders-found' | 'no-orders' | 'filed' | 'none-matched' | 'sent' | 'error';

export interface HmisAuditEntry {
  ts: string;
  kind: HmisAuditKind;
  /** Barcode(s) the call concerns — the grep key. */
  sampleId: string | string[] | null;
  eqCode?: string | null;
  method: 'GET' | 'POST';
  url: string;
  /** Request body, parsed. Absent on GET. */
  request?: unknown;
  httpStatus: number | null;
  /** The gateway's response, parsed when it was JSON, else the raw text. */
  response?: unknown;
  durationMs: number;
  outcome: HmisAuditOutcome;
  /** Rows returned (query) or rows accepted (result). */
  rows?: number;
  error?: string;
}

/** Bodies are normally tiny, but a stack trace or an HTML error page is not —
 *  cap what one entry can add so a failing gateway cannot fill the disk. */
const MAX_FIELD_CHARS = 8000;

export class HmisAudit {
  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  record(entry: HmisAuditEntry): void {
    // Never let an audit-write problem break a call that otherwise succeeded:
    // the result upload matters more than its own log line.
    try {
      this.rotateIfLarge();
      appendFileSync(this.file, JSON.stringify(entry, truncate) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn(
        { file: this.file, err: err instanceof Error ? err.message : String(err) },
        'could not write the HMIS transaction log',
      );
    }
  }

  /** Single-generation rotation: hmis.log → hmis.log.1, oldest is dropped. */
  private rotateIfLarge(): void {
    try {
      if (statSync(this.file).size < this.maxBytes) return;
      renameSync(this.file, `${this.file}.1`);
    } catch {
      /* no file yet, or another process holds it — either way just append */
    }
  }
}

/** JSON.stringify replacer: clip any oversized string to keep entries bounded. */
function truncate(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}…[${value.length - MAX_FIELD_CHARS} more chars]`;
  }
  return value;
}
