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

/**
 * Fold an id into something the filesystem will actually accept.
 *
 * The spool id doubles as the filename stem — `listIds` reads it back out of
 * readdir — so this must be applied at enqueue, not at write time, or the
 * write and the subsequent read/remove would disagree on the path.
 *
 * Result ids are `<barcode>-<hash>`, and the barcode comes straight off the
 * analyzer, so it is fully untrusted text: a Maglumi QC record arrived as
 * `KN TG 2 <0.02` and Windows rejects `<` with ENOENT, which killed the write
 * and dropped the result. Windows also bans > : " / \ | ? * and control
 * characters, silently strips trailing dots and spaces, and reserves the old
 * DOS device names.
 *
 * The 24-hex-char hash that makes a result id unique sits at the END, so an
 * over-long id is trimmed from the front — trimming the tail would collide
 * every message for one sample onto a single file.
 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeSpoolId(id: string): string {
  let s = id.replace(/[<>:"\/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(-120);
  if (!s || RESERVED_DEVICE_NAME.test(s)) s = `id_${s}`;
  return s;
}

export class SpoolQueue<T> {
  private readonly pendingDir: string;
  private readonly failedDir: string;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  /** Ids discarded mid-delivery; drain must not write them back out. */
  private readonly discarded = new Set<string>();
  private handler: Handler<T> | null = null;

  constructor(private readonly baseDir: string, private readonly logger: Logger) {
    this.pendingDir = join(baseDir, 'pending');
    this.failedDir = join(baseDir, 'failed');
    mkdirSync(this.pendingDir, { recursive: true });
    mkdirSync(this.failedDir, { recursive: true });
  }

  /** Persist a payload durably. Returns the assigned id. */
  enqueue(payload: T, id = `${Date.now()}-${randomUUID()}`): string {
    const safeId = safeSpoolId(id);
    if (safeId !== id) {
      // Keeps the mapping visible when hunting for an item by barcode.
      this.logger.warn({ id, safeId }, 'spool id contained characters the filesystem rejects — stored under a folded name');
    }
    const env: SpoolEnvelope<T> = { id: safeId, createdAt: new Date().toISOString(), attempts: 0, payload };
    this.writeAtomic(this.pendingDir, safeId, env);
    // Kick the worker so delivery is near-immediate when online.
    queueMicrotask(() => this.drain());
    return safeId;
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

  /** Drop an item from the queue entirely (admin "remove" action).
   *
   *  Deleting the file is not enough on its own: the drain worker may already
   *  be awaiting delivery of this very item, and a failure there would write
   *  the envelope back out and resurrect what the operator just discarded.
   *  Record the id so drain knows to let it go. */
  discard(id: string): boolean {
    const existed = this.remove(this.pendingDir, id) || this.remove(this.failedDir, id);
    if (existed && this.draining) this.discarded.add(id);
    return existed;
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
          this.discarded.delete(id);
          this.remove(this.pendingDir, id);
        } catch (err) {
          // Discarded by the operator while this attempt was in flight — let it go.
          if (this.discarded.delete(id)) {
            this.remove(this.pendingDir, id);
            continue;
          }
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

  /** Deletes the file; returns whether it was there to delete. */
  private remove(dir: string, id: string): boolean {
    try {
      unlinkSync(join(dir, `${id}.json`));
      return true;
    } catch {
      return false; /* already gone */
    }
  }
}
