import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

// =============================================================================
// SpoolQueue — durable, file-backed store-and-forward.
//
// Every outbound result upload is written to spool/pending/<id>.json BEFORE we
// try to deliver it, so a server/network outage (or a crash) never loses a
// result. A worker drains pending in timestamp order; on repeated failure an
// item is parked in spool/failed for manual attention (surfaced in the admin
// UI). No native deps — just the filesystem.
// =============================================================================

export interface SpoolEnvelope<T> {
  id: string;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
  payload: T;
}

export type Handler<T> = (payload: T, env: SpoolEnvelope<T>) => Promise<void>;

const MAX_ATTEMPTS = 50;

export class SpoolQueue<T> {
  private readonly pendingDir: string;
  private readonly failedDir: string;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private handler: Handler<T> | null = null;

  constructor(private readonly baseDir: string, private readonly logger: Logger) {
    this.pendingDir = join(baseDir, 'pending');
    this.failedDir = join(baseDir, 'failed');
    mkdirSync(this.pendingDir, { recursive: true });
    mkdirSync(this.failedDir, { recursive: true });
  }

  /** Persist a payload durably. Returns the assigned id. */
  enqueue(payload: T, id = `${Date.now()}-${randomUUID()}`): string {
    const env: SpoolEnvelope<T> = { id, createdAt: new Date().toISOString(), attempts: 0, payload };
    this.writeAtomic(this.pendingDir, id, env);
    // Kick the worker so delivery is near-immediate when online.
    queueMicrotask(() => this.drain());
    return id;
  }

  start(handler: Handler<T>, intervalMs = 15_000): void {
    this.handler = handler;
    this.timer = setInterval(() => this.drain(), intervalMs);
    this.drain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  counts(): { pending: number; failed: number } {
    return { pending: this.listIds(this.pendingDir).length, failed: this.listIds(this.failedDir).length };
  }

  listPending(limit = 100): SpoolEnvelope<T>[] {
    return this.listIds(this.pendingDir)
      .slice(0, limit)
      .map((id) => this.read(this.pendingDir, id))
      .filter((x): x is SpoolEnvelope<T> => !!x);
  }

  listFailed(limit = 100): SpoolEnvelope<T>[] {
    return this.listIds(this.failedDir)
      .slice(0, limit)
      .map((id) => this.read(this.failedDir, id))
      .filter((x): x is SpoolEnvelope<T> => !!x);
  }

  /** Move a failed item back to pending (admin "retry" action). */
  requeueFailed(id: string): boolean {
    try {
      renameSync(join(this.failedDir, `${id}.json`), join(this.pendingDir, `${id}.json`));
      queueMicrotask(() => this.drain());
      return true;
    } catch {
      return false;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      for (const id of this.listIds(this.pendingDir)) {
        const env = this.read(this.pendingDir, id);
        if (!env) continue;
        try {
          await this.handler(env.payload, env);
          this.remove(this.pendingDir, id);
        } catch (err) {
          env.attempts += 1;
          env.lastError = err instanceof Error ? err.message : String(err);
          if (env.attempts >= MAX_ATTEMPTS) {
            this.writeAtomic(this.failedDir, id, env);
            this.remove(this.pendingDir, id);
            this.logger.error({ id, attempts: env.attempts, err: env.lastError }, 'spool item parked in failed/');
          } else {
            this.writeAtomic(this.pendingDir, id, env);
            this.logger.warn({ id, attempts: env.attempts, err: env.lastError }, 'spool delivery failed, will retry');
            // Back off the whole drain — the server/network is likely down.
            break;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private listIds(dir: string): string[] {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort(); // ids are Date.now()-prefixed → lexical sort ≈ chronological
  }

  private read(dir: string, id: string): SpoolEnvelope<T> | null {
    try {
      return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as SpoolEnvelope<T>;
    } catch {
      return null;
    }
  }

  private writeAtomic(dir: string, id: string, env: SpoolEnvelope<T>): void {
    const tmp = join(dir, `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(env), 'utf8');
    renameSync(tmp, join(dir, `${id}.json`));
  }

  private remove(dir: string, id: string): void {
    try {
      unlinkSync(join(dir, `${id}.json`));
    } catch {
      /* already gone */
    }
  }
}
