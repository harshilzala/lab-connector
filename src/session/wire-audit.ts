import type { Logger } from '../logger.js';
import { DailyLogFile } from '../maintenance/daily-log.js';
import type { WireLogEntry } from './orchestrator.js';

// =============================================================================
// Analyzer wire log — one JSON line per frame that crossed the serial/TCP link.
//
// The dashboard's wire panel is a 200-frame ring buffer held in memory, which
// makes it useless as evidence: it is wiped by every restart and, on a busy
// analyzer, overwrites itself within minutes. When a lab asks "the machine says
// it sent that sample, where did it go?", the answer has to come from something
// durable — otherwise the only honest reply is that we no longer know.
//
// So every frame is also appended here, per analyzer, next to the HMIS
// transaction log. Between the two, a sample can be traced the whole way:
//   logs\wire-cancer-bc6000-2026-09-07.log   what the instrument said that day
//   logs\hmis-2026-09-07.log                 what we then did with it
//
// Line-delimited JSON, one file per analyzer PER DAY (see DailyLogFile), kept
// for `retention.logDays` and then removed by the retention sweeper. Nothing
// is dropped before that: a day that outgrows maxBytes continues in a new
// part, it is not overwritten.
// =============================================================================

export class WireAudit {
  private readonly file: DailyLogFile;

  constructor(base: string, logger: Logger, maxBytes = 10 * 1024 * 1024) {
    this.file = new DailyLogFile(base, logger, maxBytes);
  }

  /** The file the next frame lands in — e.g. logs\wire-cancer-abl9-2026-09-07.log */
  currentPath(): string {
    return this.file.currentPath();
  }

  record(entry: WireLogEntry): void {
    // A logging fault must never break the link it is observing; DailyLogFile
    // swallows write errors and reports them on the application log.
    this.file.append(JSON.stringify(entry, truncate));
  }
}

/** A single frame is bounded; a runaway one must not make the line unreadable. */
const MAX_FIELD_CHARS = 8000;

function truncate(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}…[${value.length - MAX_FIELD_CHARS} more chars]`;
  }
  return value;
}
