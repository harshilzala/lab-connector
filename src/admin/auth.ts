import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// =============================================================================
// Admin authentication for the local dashboard.
//
// The connector is a single-operator appliance on a lab PC, so there is no user
// database: one credential lives in a JSON file next to config.json, with the
// password kept as a salted scrypt hash. The file is seeded on first start with
// the commissioning credential below and a random recovery key, which is
// printed to the log exactly once so it can be filed with the lab's runbook.
//
// Password reset works two ways, both offline (there is no mail server here):
//   • signed in  → current password → new password
//   • locked out → recovery key     → new password
// Losing both means deleting the auth file: the next start re-seeds defaults.
// =============================================================================

export const DEFAULT_USERNAME = 'Adminx';
export const DEFAULT_PASSWORD = 'Admin@380054';

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one operator shift
export const SESSION_COOKIE = 'lc_session';

/** Failed sign-ins tolerated from one address before it is parked briefly. */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

interface AuthFileV1 {
  version: 1;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  recoverySalt: string;
  recoveryHash: string;
  updatedAt: string;
}

function hash(secret: string, salt: string): string {
  return scryptSync(secret.normalize('NFKC'), salt, SCRYPT_KEYLEN).toString('hex');
}

/** Constant-time compare that tolerates a length mismatch without throwing. */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Grouped in fives so it can be read aloud over the phone during a callout. */
function newRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export interface PasswordRule {
  ok: boolean;
  reason?: string;
}

/** Deliberately modest: an operator typing on a lab PC, not an internet login. */
export function checkPasswordStrength(pw: string): PasswordRule {
  if (pw.length < 10) return { ok: false, reason: 'Password must be at least 10 characters.' };
  if (pw.length > 200) return { ok: false, reason: 'Password must be under 200 characters.' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) {
    return { ok: false, reason: 'Use at least three of: lowercase, uppercase, digits, symbols.' };
  }
  return { ok: true };
}

export class AuthStore {
  private data: AuthFileV1;

  /** Set only when this start seeded the file — the caller logs it once. */
  readonly seededRecoveryKey: string | null = null;

  constructor(private readonly file: string) {
    const abs = resolve(file);
    if (existsSync(abs)) {
      this.data = JSON.parse(readFileSync(abs, 'utf8')) as AuthFileV1;
      if (this.data.version !== 1) throw new Error(`Unsupported auth file version in ${abs}`);
      return;
    }
    const recoveryKey = newRecoveryKey();
    this.data = {
      version: 1,
      username: process.env.ADMIN_USERNAME || DEFAULT_USERNAME,
      passwordSalt: '',
      passwordHash: '',
      recoverySalt: randomBytes(16).toString('hex'),
      recoveryHash: '',
      updatedAt: new Date().toISOString(),
    };
    this.data.recoveryHash = hash(recoveryKey, this.data.recoverySalt);
    this.writePassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD);
    this.seededRecoveryKey = recoveryKey;
  }

  get username(): string {
    return this.data.username;
  }

  /** True while the credential is still the one printed in the commissioning docs. */
  get usingDefaultPassword(): boolean {
    return safeEqualHex(this.data.passwordHash, hash(DEFAULT_PASSWORD, this.data.passwordSalt));
  }

  verifyPassword(username: string, password: string): boolean {
    if (username.trim().toLowerCase() !== this.data.username.toLowerCase()) return false;
    return safeEqualHex(this.data.passwordHash, hash(password, this.data.passwordSalt));
  }

  verifyRecoveryKey(username: string, key: string): boolean {
    if (username.trim().toLowerCase() !== this.data.username.toLowerCase()) return false;
    const normalized = key.trim().toUpperCase().replace(/\s+/g, '');
    return safeEqualHex(this.data.recoveryHash, hash(normalized, this.data.recoverySalt));
  }

  setPassword(password: string): void {
    this.writePassword(password);
  }

  private writePassword(password: string): void {
    this.data.passwordSalt = randomBytes(16).toString('hex');
    this.data.passwordHash = hash(password, this.data.passwordSalt);
    this.data.updatedAt = new Date().toISOString();
    this.persist();
  }

  private persist(): void {
    const abs = resolve(this.file);
    mkdirSync(dirname(abs), { recursive: true });
    // 0600 is a no-op against Windows ACLs but correct where it is honoured.
    writeFileSync(abs, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
  }
}

interface Session {
  username: string;
  expiresAt: number;
}

/** In-memory sessions: a restart signs the operator out, which is what we want. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(username: string): string {
    const id = randomUUID();
    this.sessions.set(id, { username, expiresAt: Date.now() + SESSION_TTL_MS });
    return id;
  }

  get(id: string | null): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  destroy(id: string | null): void {
    if (id) this.sessions.delete(id);
  }

  /** Called after a password change so other browsers cannot keep the old one. */
  destroyAll(): void {
    this.sessions.clear();
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
  }
}

/** Per-address back-off. Keyed by remote address; localhost-only, so it is thin. */
export class LoginThrottle {
  private readonly hits = new Map<string, { fails: number; until: number }>();

  /** Milliseconds left in the lockout, or 0 when the caller may try again. */
  retryAfterMs(key: string): number {
    const h = this.hits.get(key);
    if (!h || h.until <= Date.now()) return 0;
    return h.until - Date.now();
  }

  fail(key: string): void {
    const h = this.hits.get(key) ?? { fails: 0, until: 0 };
    h.fails += 1;
    if (h.fails >= MAX_ATTEMPTS) {
      h.until = Date.now() + LOCKOUT_MS;
      h.fails = 0;
    }
    this.hits.set(key, h);
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}

/** Reads one cookie out of a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
