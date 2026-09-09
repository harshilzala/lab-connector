import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Logger } from '../logger.js';

// =============================================================================
// Daily log file — append-only, one file per calendar day, nothing discarded.
//
// The HMIS transaction log and the per-analyzer wire logs are evidence: when a
// lab asks "the machine sent that sample a fortnight ago, what happened to
// it?", the answer has to be on disk. The earlier single-generation rotation
// (hmis.log -> hmis.log.1, oldest dropped) could not promise that: at the
// Cancer site's volume hmis.log filled 10 MB in well under two days, so the
// window was about three days, not the 30 the lab requires.
//
// So a log is now a family of files that share a base name:
//
//   logs\hmis.log                configured base name (never written to)
//   logs\hmis-2026-09-07.log     today's file — the only one being appended
//   logs\hmis-2026-09-06.log     yesterday's, closed at midnight
//   logs\hmis-2026-09-06.1.log   an overflow part: the day grew past maxBytes,
//                                so the full file was set aside under the next
//                                free number and the day continued in a fresh
//                                file. Nothing is deleted here — only renamed.
//
// The date is the LOCAL calendar day, because that is how an operator will
// look for it ("yesterday's ABL9 log"). The file switches on the first write
// after midnight.
//
// Deletion is someone else's job: the retention sweeper removes any file in
// the log directory whose mtime is older than `retention.logDays`. A day file
// stops changing once the day ends, so it expires exactly logDays later.
// =============================================================================

export class DailyLogFile {
  private readonly dir: string;
  private readonly stem: string;
  private readonly ext: string;
  /** Date key of the file currently being appended, e.g. "2026-09-07". */
  private dayKey = '';
  private active = '';

  /**
   * @param base     the configured file name, e.g. ./logs/hmis.log. Only its
   *                 directory, stem and extension are used.
   * @param maxBytes overflow threshold for one day's file. Past it the file is
   *                 set aside as <stem>-<date>.<n><ext> and a fresh one starts.
   */
  constructor(
    base: string,
    private readonly logger: Logger,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {
    this.dir = dirname(base);
    this.ext = extname(base) || '.log';
    this.stem = basename(base, this.ext);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Path of the file the next write goes to. */
  currentPath(): string {
    this.switchDayIfNeeded();
    return this.active;
  }

  /** Append one line. Never throws — a logging fault must not break the caller. */
  append(line: string): void {
    try {
      this.switchDayIfNeeded();
      this.overflowIfLarge();
      appendFileSync(this.active, line.endsWith('\n') ? line : line + '\n', 'utf8');
    } catch (err) {
      this.logger.warn(
        { file: this.active, err: err instanceof Error ? err.message : String(err) },
        'could not write a log line',
      );
    }
  }

  /**
   * Every file of this log family, oldest first, for readers that need the
   * whole history (a barcode search, a replay). Includes the pre-daily
   * generations (<stem><ext>, <stem><ext>.1) so history written before the
   * switch is still found while it lasts.
   */
  static files(base: string): string[] {
    const dir = dirname(base);
    const ext = extname(base) || '.log';
    const stem = basename(base, ext);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const legacy = new RegExp(`^${escape(stem)}${escape(ext)}(\\.\\d+)?$`);
    const daily = new RegExp(`^${escape(stem)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?${escape(ext)}$`);
    const keyed = names
      .map((n) => {
        const m = daily.exec(n);
        if (m) return { n, key: `1|${m[1]}|${String(m[2] ?? '999999').padStart(6, '0')}` };
        // A legacy overflow (.1) is OLDER than the legacy live file.
        const l = legacy.exec(n);
        if (l) return { n, key: `0|${l[1] ? '0' : '1'}` };
        return null;
      })
      .filter((x): x is { n: string; key: string } => x !== null)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // Within a day the overflow parts (.1, .2 …) came BEFORE the unnumbered
    // live file, which is why the live file sorts with key 999999 above.
    return keyed.map((x) => join(dir, x.n));
  }

  // ---------------------------------------------------------------------------
  private switchDayIfNeeded(): void {
    const key = localDayKey(new Date());
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.active = join(this.dir, `${this.stem}-${key}${this.ext}`);
  }

  /** Set a full day file aside under the next free part number; keep going. */
  private overflowIfLarge(): void {
    let size: number;
    try {
      size = statSync(this.active).size;
    } catch {
      return; // no file yet
    }
    if (size < this.maxBytes) return;
    for (let n = 1; n < 100000; n++) {
      const part = join(this.dir, `${this.stem}-${this.dayKey}.${n}${this.ext}`);
      if (existsSync(part)) continue;
      try {
        renameSync(this.active, part);
      } catch {
        /* another process holds it — keep appending to the same file */
      }
      return;
    }
  }
}

/** "YYYY-MM-DD" in the machine's local time zone. */
export function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
