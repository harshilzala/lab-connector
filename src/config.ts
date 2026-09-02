import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_DIALECT, ASTM_DIALECT_NAMES, type AstmDialect } from './codec/astm/records.js';

// Minimal .env loader (no dependency). Reads KEY=VALUE lines and populates
// process.env without overwriting variables already set in the real environment.
// Runs before config is read so HMAC_SECRET__* / HMIS_* overrides take effect.
function loadEnvFile(path = process.env.LAB_CONNECTOR_ENV || './.env'): void {
  const abs = resolve(path);
  if (!existsSync(abs)) return;
  for (const line of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// =============================================================================
// Config schema + loader.
//
// Precedence: environment overrides > config.json. Secrets (HMIS URL, per
// analyzer HMAC secret) are best supplied via env so they stay out of the
// committed config file.
// =============================================================================

const TcpTransport = z.object({
  type: z.literal('tcp'),
  /** server = we listen and the analyzer connects to us; client = we dial the analyzer. */
  mode: z.enum(['server', 'client']).default('server'),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive(),
});

const SerialTransport = z.object({
  type: z.literal('serial'),
  path: z.string(), // COM3 on Windows, /dev/ttyS0 on Linux
  baudRate: z.number().int().positive().default(9600),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'),
  // Assert the DTR/RTS modem-control lines on open. Many analyzers (e.g. Siemens
  // ADVIA 2120i / CLINITEK Advantus) hold their transmission until the host
  // raises these "ready" lines — the legacy caretech middleware set both true.
  // Default true; set false only for a device that misbehaves with them high.
  dtr: z.boolean().default(true),
  rts: z.boolean().default(true),
});

const TransportSchema = z.discriminatedUnion('type', [TcpTransport, SerialTransport]);

// Derived from the dialect library so adding a machine there is the only edit
// needed — see src/codec/astm/dialects.ts.
const ASTM_DIALECTS: [AstmDialect, ...AstmDialect[]] = ASTM_DIALECT_NAMES;

const AstmOptions = z.object({
  ackTimeoutMs: z.number().int().positive().default(15000),
  frameMaxData: z.number().int().positive().default(240),
  senderId: z.string().default('HMIS-LIS'),
  receiverId: z.string().default('ANALYZER'),
  /** Order-download shape. Inbound parsing is vendor-neutral; the download is
   *  not — an analyzer silently ignores an order it cannot parse. */
  dialect: z.enum(ASTM_DIALECTS).default(DEFAULT_DIALECT),
});

/** Kermit link tuning for the VITROS 250/350 — see src/codec/kermit/. */
const KermitOptions = z.object({
  /** Wait for a Y acknowledgement before retransmitting a packet. */
  ackTimeoutMs: z.number().int().positive().default(10000),
  maxRetries: z.number().int().positive().default(5),
});

/** HL7 v2 over MLLP — see src/codec/hl7/. Defaults reproduce the Erba H360
 *  exchange the legacy middleware ran in production. */
const Hl7Options = z.object({
  /** MSH-3 on the ACK we send back. */
  sendingApp: z.string().default('LIS'),
  /** MSH-4 on the ACK. Blank in the reference implementation. */
  sendingFacility: z.string().default(''),
  /** MSH-18 on the ACK; the H360 declares UNICODE. */
  charset: z.string().default('UNICODE'),
  /** Send an application ACK (MSA|AA) for every inbound message. */
  ack: z.boolean().default(true),
  /** OBX-2 value types that become filable results. ['NM'] keeps the numeric
   *  analytes and drops the IS-typed run modes, remarks and alarm flags — the
   *  exact set the legacy middleware filed. [] accepts every type. */
  valueTypes: z.array(z.string()).default(['NM']),
  encoding: z.enum(['utf8', 'latin1', 'ascii']).default('utf8'),
  /** Safety net for a peer that omits the MLLP end block: parse whatever has
   *  buffered after this idle gap. 0 disables (strict MLLP only). */
  idleFlushMs: z.number().int().nonnegative().default(0),
});

const AnalyzerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'analyzer id must be kebab-case'),
  /** Sent as the `eqCode` query parameter — this is what identifies the machine
   *  now that there is no id/secret pair. */
  equipmentCode: z.string(),
  /** Numeric HMIS equipment id. Optional: used as a fallback in the acknowledge
   *  body and the results upload when a pending row does not carry one. */
  equipmentId: z.union([z.string(), z.number()]).optional(),
  // Legacy caretech middleware machine number (App.config MachineId, e.g. 901 =
  // ADVIA 2120i, 902 = CLINITEK Advantus). Optional metadata carried for
  // traceability against the old system; not required by the HMIS interface.
  machineId: z.number().int().positive().optional(),
  /** Optional pass-through query parameters for the pending call. */
  siteId: z.string().optional(),
  showCulture: z.union([z.string(), z.boolean()]).optional(),
  /** Send today's date (dd-MM-yyyy) as the `date` parameter. Off by default —
   *  an order raised yesterday for a tube run today would otherwise be missed. */
  sendDate: z.boolean().default(false),
  /** Reported in the acknowledge body; derived from a TCP transport when unset. */
  ipAddress: z.string().optional(),
  portNo: z.string().optional(),
  protocol: z.enum(['astm', 'hl7', 'kermit', 'advia2120i', 'clinitek-advantus']).default('astm'),
  transport: TransportSchema,
  sendDemographics: z.boolean().default(false),
  hostQuery: z.boolean().default(true),
  qc: z
    .object({
      sampleIdPrefixes: z.array(z.string()).default([]),
      sampleIdRegex: z.string().nullable().default(null),
    })
    .default({ sampleIdPrefixes: [], sampleIdRegex: null }),
  /** Analyzer assay code → HMIS `eqIdntifier`, for analytes the two systems
   *  NAME differently (H360 "HGB" vs ZHFC03 "HAEMOGLOBIN"). Only consulted when
   *  the analyzer's own code matches no pending row, so it can never shadow a
   *  code that already works. Prefer correcting the Identifier column in HMIS —
   *  this is the escape hatch when the parameter is named after the report
   *  line rather than the instrument. */
  testCodeAliases: z.record(z.string()).default({}),
  astm: AstmOptions.default({}),
  kermit: KermitOptions.default({}),
  hl7: Hl7Options.default({}),
});

const ConfigSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  spoolDir: z.string().default('./spool'),
  hmis: z.object({
    baseUrl: z.string().url(),
    /** GET — load orders. Query: sampleId, eqCode, siteId, showCulture, date. */
    pendingPath: z.string().default('/mirth/pending'),
    /** POST — acknowledge the rows handed to the analyzer. */
    acknowledgePath: z.string().default('/mirth/acknowledge'),
    /** POST — results upload. */
    resultsPath: z.string().default('/mirth/results'),
    timeoutMs: z.number().int().positive().default(15000),
    tlsRejectUnauthorized: z.boolean().default(true),
  }),
  admin: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(7070),
      /** Where the dashboard credential + recovery key hash live. Seeded on
       *  first start; see src/admin/auth.ts. Keep it out of version control. */
      authFile: z.string().default('./admin-auth.json'),
    })
    .default({ host: '127.0.0.1', port: 7070, authFile: './admin-auth.json' }),
  analyzers: z.array(AnalyzerSchema).min(1),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type AnalyzerConfig = z.infer<typeof AnalyzerSchema>;
export type TransportConfig = z.infer<typeof TransportSchema>;

// -----------------------------------------------------------------------------
// config.json is read as JSONC — JSON plus `//` and `/* */` comments and
// trailing commas.
//
// This exists so the file can carry a COMMENTED-OUT ALTERNATIVE next to the live
// one: every analyzer here can be reached either over its COM port or through a
// Moxa serial-device server on TCP, and which one is in use changes with the
// cabling. Keeping the other form parked in a comment beside it is how an
// engineer at the bench sees the known-good settings instead of reconstructing
// baud rate and parity from memory.
//
// Both scanners are string-aware: `"https://host/path"` must not lose its tail,
// and a `//` or a comma inside a quoted value is data, not syntax. Newlines
// inside comments are preserved so a JSON syntax error still reports the line
// number the editor shows.
// -----------------------------------------------------------------------------
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n' || c === '\r') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (c === '\n' || c === '\r') {
        out += c; // keep line numbers honest
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next; // an escaped char can never close the string
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Drop a comma that only has whitespace before its closing `}` / `]` — what
 *  commenting out the LAST entry of an object or array leaves behind. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\' && text[i + 1] !== undefined) {
        out += text[i + 1];
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop it
    }
    out += c;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function applyEnvOverrides(raw: any): any {
  const cfg = structuredClone(raw);
  if (process.env.LOG_LEVEL) cfg.logLevel = process.env.LOG_LEVEL;
  if (process.env.HMIS_BASE_URL) cfg.hmis = { ...cfg.hmis, baseUrl: process.env.HMIS_BASE_URL };
  if (process.env.ADMIN_AUTH_FILE) cfg.admin = { ...cfg.admin, authFile: process.env.ADMIN_AUTH_FILE };
  return cfg;
}

export function loadConfig(path = process.env.LAB_CONNECTOR_CONFIG || './config.json'): AppConfig {
  loadEnvFile(); // populate process.env from .env before applying overrides
  const abs = resolve(path);
  let raw: unknown;
  try {
    // JSONC: comments and trailing commas are allowed, so a parked
    // serial/TCP alternative can live beside the active transport.
    raw = parseJsonc(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read config at ${abs}: ${(err as Error).message}`);
  }
  const withEnv = applyEnvOverrides(raw);
  const parsed = ConfigSchema.safeParse(withEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  // Two analyzers sharing an equipmentCode would acknowledge each other's rows.
  const seen = new Set<string>();
  for (const a of parsed.data.analyzers) {
    const code = a.equipmentCode.trim().toUpperCase();
    if (seen.has(code)) {
      throw new Error(`Two analyzers share equipmentCode "${a.equipmentCode}" — eqCode must identify exactly one machine.`);
    }
    seen.add(code);
  }
  return parsed.data;
}
