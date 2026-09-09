import type { Logger } from '../logger.js';
import { DailyLogFile } from '../maintenance/daily-log.js';

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
// Format is line-delimited JSON, one file per calendar day —
// logs\hmis-2026-09-07.log, see DailyLogFile — kept for retention.logDays
// (30 at the Cancer site). A single barcode's whole history is therefore one
// grep across the family:
//   findstr LB2609020570 logs\hmis-*.log
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
  /**
   * Result uploads only: one flat line per value —
   *   "SF2609050017 1.000000+032+1 = 395 -> labResultId 92768304"
   * The same facts are inside `request`, but only as nested JSON. This is the
   * readable index into it, so a transfer can be traced by grepping whichever
   * handle the operator has: barcode, assay identifier, value, or labResultId.
   */
  filed?: string[];
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
  private readonly file: DailyLogFile;

  /**
   * @param base     configured file name, e.g. ./logs/hmis.log. Entries go to
   *                 <stem>-YYYY-MM-DD.log beside it; the base itself is unused.
   * @param maxBytes a day that grows past this continues in a numbered part —
   *                 nothing is dropped, that is the retention sweeper's job.
   */
  constructor(base: string, logger: Logger, maxBytes = 10 * 1024 * 1024) {
    this.file = new DailyLogFile(base, logger, maxBytes);
  }

  /** The file the next entry lands in — e.g. logs\hmis-2026-09-07.log */
  currentPath(): string {
    return this.file.currentPath();
  }

  record(entry: HmisAuditEntry): void {
    // Never let an audit-write problem break a call that otherwise succeeded:
    // the result upload matters more than its own log line. DailyLogFile
    // swallows the write error and reports it on the application log.
    this.file.append(JSON.stringify(entry, truncate));
  }
}

/** JSON.stringify replacer: clip any oversized string to keep entries bounded. */
function truncate(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}…[${value.length - MAX_FIELD_CHARS} more chars]`;
  }
  return value;
}
