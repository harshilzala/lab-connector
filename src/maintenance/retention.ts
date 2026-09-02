import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

// =============================================================================
// Retention sweeper — deletes logs and spool items past their keep-window.
//
// Two directories are swept, and they are NOT equivalent:
//
//   logs/          diagnostic text. Deleting an old one costs nothing.
//
//   spool/<id>/    patient results. An item is removed from the spool the
//                  moment it is filed successfully, so ANYTHING still sitting
//                  in pending/ or failed/ is a result that never reached HMIS.
//                  Deleting it discards that result permanently — there is no
//                  copy anywhere else in this process.
//
// So every spool deletion is logged at warn with its barcode BEFORE the file
// goes, leaving a trace in the application log even after the payload is gone,
// and `includeSpoolPending` can hold pending/ back while still clearing failed/.
//
// Age is taken from the envelope's own `createdAt` where it can be read, not
// from mtime: a retry rewrites the file (attempts/lastError are updated), which
// pushes mtime forward and would make a stale item look perpetually fresh.
// =============================================================================

export interface RetentionOptions {
  /** Keep-window in days. Anything older is removed. */
  days: number;
  /** Directory holding the application + HMIS logs. */
  logDir: string;
  /** Spool root; each analyzer owns a <root>/<analyzerId> subtree. */
  spoolRoot: string;
  /** How often to sweep. The first sweep runs at startup. */
  intervalMs: number;
  /** Sweep pending/ too. False keeps undelivered results indefinitely. */
  includeSpoolPending: boolean;
  logger: Logger;
}

export interface SweepReport {
  logFilesDeleted: number;
  spoolItemsDeleted: number;
  bytesFreed: number;
  errors: number;
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RetentionOptions) {}

  /** Sweep now, then on the configured interval. */
  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.opts.intervalMs);
    // Do not hold the event loop open just to run a cleanup.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Never throws — a cleanup failure must not stop the connector. */
  sweep(): SweepReport {
    const cutoff = Date.now() - this.opts.days * 24 * 60 * 60 * 1000;
    const report: SweepReport = { logFilesDeleted: 0, spoolItemsDeleted: 0, bytesFreed: 0, errors: 0 };

    this.sweepLogs(cutoff, report);
    this.sweepSpool(cutoff, report);

    if (report.logFilesDeleted || report.spoolItemsDeleted || report.errors) {
      this.opts.logger.info(
        {
          days: this.opts.days,
          logFiles: report.logFilesDeleted,
          spoolItems: report.spoolItemsDeleted,
          freedKb: Math.round(report.bytesFreed / 1024),
          errors: report.errors,
        },
        'retention sweep complete',
      );
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  private sweepLogs(cutoff: number, report: SweepReport): void {
    for (const entry of this.entries(this.opts.logDir)) {
      const path = join(this.opts.logDir, entry);
      let size = 0;
      try {
        const st = statSync(path);
        if (!st.isFile() || st.mtimeMs >= cutoff) continue;
        size = st.size;
        rmSync(path);
      } catch (err) {
        // On Windows the file a process still holds open cannot be unlinked.
        // That is the normal fate of an idle-but-active log; not worth an error.
        this.opts.logger.debug(
          { path, err: err instanceof Error ? err.message : String(err) },
          'could not delete an expired log file',
        );
        report.errors++;
        continue;
      }
      report.logFilesDeleted++;
      report.bytesFreed += size;
      this.opts.logger.info({ path, days: this.opts.days }, 'expired log file deleted');
    }
  }

  private sweepSpool(cutoff: number, report: SweepReport): void {
    const buckets = this.opts.includeSpoolPending ? ['pending', 'failed'] : ['failed'];

    for (const analyzerId of this.entries(this.opts.spoolRoot)) {
      for (const bucket of buckets) {
        const dir = join(this.opts.spoolRoot, analyzerId, bucket);
        for (const file of this.entries(dir)) {
          if (!file.endsWith('.json')) continue; // ignore stray .tmp
          const path = join(dir, file);
          try {
            const st = statSync(path);
            if (!st.isFile()) continue;
            if (this.ageOf(path, st.mtimeMs) >= cutoff) continue;

            // Say what is being destroyed while the file is still readable —
            // this line is all that survives the deletion.
            this.opts.logger.warn(
              { analyzer: analyzerId, bucket, id: file.slice(0, -5), ...this.describe(path), days: this.opts.days },
              'discarding an unfiled result past the retention window',
            );
            rmSync(path);
            report.spoolItemsDeleted++;
            report.bytesFreed += st.size;
          } catch (err) {
            this.opts.logger.warn(
              { path, err: err instanceof Error ? err.message : String(err) },
              'could not delete an expired spool item',
            );
            report.errors++;
          }
        }
      }
    }
  }

  /** Envelope `createdAt` when readable, else mtime — see the header note. */
  private ageOf(path: string, mtimeMs: number): number {
    try {
      const env = JSON.parse(readFileSync(path, 'utf8')) as { createdAt?: string };
      const created = env.createdAt ? Date.parse(env.createdAt) : NaN;
      return Number.isFinite(created) ? created : mtimeMs;
    } catch {
      return mtimeMs;
    }
  }

  /** Barcode and result count for the deletion record; best-effort. */
  private describe(path: string): { barcode?: string; results?: number; attempts?: number } {
    try {
      const env = JSON.parse(readFileSync(path, 'utf8')) as {
        attempts?: number;
        payload?: { barcode?: string; results?: unknown[] };
      };
      return {
        barcode: env.payload?.barcode,
        results: Array.isArray(env.payload?.results) ? env.payload.results.length : undefined,
        attempts: env.attempts,
      };
    } catch {
      return {};
    }
  }

  /** readdir that treats a missing directory as empty rather than throwing. */
  private entries(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }
}
