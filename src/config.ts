import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_DIALECT, ORDER_FORMATS, type AstmDialect } from './codec/astm/records.js';

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

// Derived from the codec's dialect table so adding a machine to ORDER_FORMATS
// is the only edit needed — see src/codec/astm/records.ts.
const ASTM_DIALECTS = Object.keys(ORDER_FORMATS) as [AstmDialect, ...AstmDialect[]];

const AstmOptions = z.object({
  ackTimeoutMs: z.number().int().positive().default(15000),
  frameMaxData: z.number().int().positive().default(240),
  senderId: z.string().default('HMIS-LIS'),
  receiverId: z.string().default('ANALYZER'),
  /** Order-download shape. Inbound parsing is vendor-neutral; the download is
   *  not — an analyzer silently ignores an order it cannot parse. */
  dialect: z.enum(ASTM_DIALECTS).default(DEFAULT_DIALECT),
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
  protocol: z.enum(['astm', 'hl7', 'advia2120i', 'clinitek-advantus']).default('astm'),
  transport: TransportSchema,
  sendDemographics: z.boolean().default(false),
  hostQuery: z.boolean().default(true),
  qc: z
    .object({
      sampleIdPrefixes: z.array(z.string()).default([]),
      sampleIdRegex: z.string().nullable().default(null),
    })
    .default({ sampleIdPrefixes: [], sampleIdRegex: null }),
  astm: AstmOptions.default({}),
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
    raw = JSON.parse(readFileSync(abs, 'utf8'));
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
