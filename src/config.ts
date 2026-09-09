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
  /** WHICH inbound record carries the barcode HMIS keys on.
   *
   *  "order" (default, the ASTM norm): the O record's specimen id, falling back
   *  to the P record when the O record named no specimen. Correct for Atellica
   *  and the VITROS family.
   *
   *  "patient": the P record's laboratory-assigned patient id first. The
   *  Radiometer ABL9 fills the two fields the other way round — the ZC tube
   *  barcode goes on the P record and the patient's 14-digit MRN goes in the O
   *  record's specimen id. Across a month of captured ABL9 traffic 130 of 414
   *  messages carried BOTH, so reading the O one would file against an MRN that
   *  HMIS never matches. The legacy integration filed the P value for exactly
   *  those samples. Set it only on an analyzer proven to behave this way — on a
   *  normal instrument it would prefer the patient id over the tube barcode. */
  sampleIdFrom: z.enum(['order', 'patient']).default('order'),
});

/** Radiometer ABL9 SOH…EOT record stream — see src/codec/abl9/link.ts. The
 *  ABL9 sends ASTM E1394 records with NO E1381 framing, so it reads
 *  sampleIdFrom and dialect from the `astm` block and only needs these two. */
const Abl9Options = z.object({
  /** Answer each completed envelope with one ACK byte, as the legacy .NET
   *  middleware did — 414 ACKs for 414 messages in Cancer_ABL9.txt. */
  ack: z.boolean().default(true),
  /** Abandon a partial envelope that grows past this without an EOT. The
   *  largest real envelope measured is 2.3 KB. */
  maxBufferBytes: z.number().int().positive().default(262144),
});

/** Kermit link tuning for the VITROS 250/350 — see src/codec/kermit/. */
const KermitOptions = z.object({
  /** Wait for a Y acknowledgement before retransmitting a packet. */
  ackTimeoutMs: z.number().int().positive().default(10000),
  maxRetries: z.number().int().positive().default(5),
  /** Pause after each acknowledged packet before sending the next one.
   *  The legacy Vitros250.exe paced every packet by 1 s (VitrosDelayTime=1000)
   *  and never drew an error packet in 48 captured transfers; sending the
   *  whole file in under a second drew "0005 INVALID PACKET USAGE" from the
   *  analyzer 125 times in one day. 0 disables the pause. */
  interPacketDelayMs: z.number().int().nonnegative().default(1000),
  /** Minimum quiet time between the end of one transfer and the send-init of
   *  the next. 151 of 160 rejections measured on 2026-09-07 came within two
   *  seconds of the previous transfer finishing. 0 disables. */
  interTransferDelayMs: z.number().int().nonnegative().default(1000),
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
  /** Other eqCodes HMIS raises this SAME physical machine's orders under.
   *
   *  The gateway maps each test to an equipment code, and a machine that was
   *  re-registered keeps its old code on the tests nobody re-mapped: the Shela
   *  VITROS ECiQ receives PSA under ZYCAPIFC01 and TSH/FT3/FT4 under the
   *  retired middleware's ZHFC01. Orders and result-time lookups are made
   *  against every code listed here as well as `equipmentCode`, and the rows
   *  are merged, so one tube's tests are found whichever code they sit under.
   *  Uniqueness still holds: a code may belong to exactly one analyzer. */
  extraEquipmentCodes: z.array(z.string()).default([]),
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
  protocol: z.enum(['astm', 'abl9', 'hl7', 'kermit', 'advia2120i', 'clinitek-advantus']).default('astm'),
  transport: TransportSchema,
  sendDemographics: z.boolean().default(false),
  hostQuery: z.boolean().default(true),
  /** Proactive order download — what makes the interface real-time.
   *
   *  Without it an order only reaches the analyzer when the analyzer asks
   *  (host query), and only analyzers that ask get one. With it the connector
   *  polls the pending endpoint for this machine's codes, remembers every row
   *  in the order store, and pushes each sample's tests to the instrument as
   *  soon as they appear in HMIS — the way the retired middleware's Orders
   *  service did, minus the acknowledge-at-download that hid orders from
   *  everything else.
   *
   *  Rows are NEVER acknowledged here; that still happens after the result is
   *  filed. Re-polling therefore sees the same rows again, and the order store
   *  is what stops them being downloaded twice. */
  orderPoll: z
    .object({
      enabled: z.boolean().default(false),
      /** Poll period. The gateway is cheap to ask; 30–60s is real-time enough. */
      intervalMs: z.number().int().min(5000).default(60000),
      /** Days before today to ask about as well — an order raised late
       *  yesterday for a tube run this morning. 0 = today only. */
      lookbackDays: z.number().int().min(0).max(7).default(1),
      /** Push new tests to the analyzer. Off for a results-only link (HL7
       *  H360): the rows are still stored so results can be filed. */
      download: z.boolean().default(true),
      /** Only barcodes starting with one of these are programmed onto the
       *  analyzer. Rows for other barcodes are still cached in the order
       *  store (so a result can be joined if one ever arrives) but are never
       *  sent. Empty = download everything the gateway returns.
       *
       *  This is the order-side twin of qc.patientPrefixes: the legacy
       *  Vitros250.exe applied SamplePrefix=ZC to both directions, and the
       *  VITROS 250 has only ever returned results for ZC barcodes. */
      downloadPrefixes: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  /** Recognising a control/QC run so it is not filed as a patient result.
   *  Two independent tests, either of which marks the sample as QC:
   *    - sampleIdPrefixes / sampleIdRegex: a DENY list — the id looks like a
   *      control ("QC...", "CTRL...").
   *    - patientPrefixes: an ALLOW list — when non-empty, any id that does NOT
   *      start with one of these is treated as non-patient. This is how the
   *      legacy VITROS 250 app worked (SamplePrefix=ZC in Vitros250.exe.config;
   *      Result_Flow.log shows "Skipped result sample=89772 (prefix filter: ZC)"),
   *      and it is the only thing that catches a bare-numeric control id.
   *  Leave patientPrefixes empty on an analyzer whose patient barcodes are not
   *  reliably prefixed — an over-tight allow list silently drops real results. */
  qc: z
    .object({
      sampleIdPrefixes: z.array(z.string()).default([]),
      sampleIdRegex: z.string().nullable().default(null),
      patientPrefixes: z.array(z.string()).default([]),
      /** Send QC results to HMIS anyway. Off: a control is a lab-internal run
       *  with no order row, so filing it only produces retry churn. */
      upload: z.boolean().default(false),
    })
    .default({}),
  /** Analyzer assay code → HMIS `eqIdntifier`, for analytes the two systems
   *  NAME differently (H360 "HGB" vs ZHFC03 "HAEMOGLOBIN"). Only consulted when
   *  the analyzer's own code matches no pending row, so it can never shadow a
   *  code that already works. Prefer correcting the Identifier column in HMIS —
   *  this is the escape hatch when the parameter is named after the report
   *  line rather than the instrument. */
  testCodeAliases: z.record(z.string()).default({}),
  /** Assay codes this analyzer emits that are not reportable results and will
   *  never have a pending row — research-only channels and flag scores. They
   *  are dropped at delivery time instead of being re-queued as an unfilable
   *  remainder that burns its retry budget once per sample. An entry may lead
   *  with "*" to match by suffix ("*-IM") or trail with "*" to match by prefix
   *  ("InR*"); matching is case-insensitive. List ONLY codes that are not
   *  results — a genuine analyte still missing its HMIS row belongs in
   *  testCodeAliases or in the HMIS master, so that it keeps being retried. */
  ignoreTestCodes: z.array(z.string()).default([]),
  /** The ONLY assay codes this analyzer files — an allow-list, checked before
   *  ignoreTestCodes. Empty (the default) means "no allow-list: file whatever
   *  matches a pending row". When set, every other code the instrument emits
   *  is dropped at delivery time as `ignored`: not filed, not re-queued, not
   *  counted as unmatched. For an interface the lab has scoped to a fixed
   *  parameter set (the BC-6000 files exactly the 22 CBC analytes HMIS
   *  registers under the instrument mnemonic) this stops the connector from
   *  trying to push the analyzer's remaining channels into HMIS, and from
   *  burning a retry budget on each of them once per sample. Matching is
   *  case-insensitive and exact — no wildcards, because an allow-list is the
   *  statement of what reaches a patient record and must be read literally. */
  allowTestCodes: z.array(z.string()).default([]),
  /** Analyzer assay code → factor its value is multiplied by before the row is
   *  posted, for the analytes the instrument and HMIS report in DIFFERENT
   *  UNITS. The BC-6000 sends WBC and PLT in 10^9/L (WBC 8.89, PLT 226) where
   *  HMIS holds them per microlitre (8890, 226000), so both carry a factor of
   *  1000. Applied at delivery time, like testCodeAliases, so correcting a
   *  factor also repairs results already sitting in the spool.
   *
   *  Only strictly numeric values are scaled; anything else (a flag string, a
   *  "<0.1") is filed unchanged. Matching is case-insensitive and exact — no
   *  "*" wildcards, because a wrong factor silently files a wrong number on a
   *  patient's report, and a wildcard makes it easy to hit an analyte that was
   *  already in the right unit. */
  testCodeScale: z.record(z.number().finite().positive()).default({}),
  /** Rebuild the order rows HMIS has stopped offering, so a result can still be
   *  filed against the parameter it belongs to.
   *
   *  OFF by default: with this false the connector files only against rows HMIS
   *  is currently offering, which is the conservative behaviour and the one
   *  every analyzer had before.
   *
   *  Turn it on for an analyzer whose panel HMIS withdraws mid-sample. Measured
   *  on the Cancer BC-6000, 2026-09-08: the CBC pending list for CH2609080017
   *  held all 38 rows at 05:01:25 and only 20 of them 29 seconds later, with
   *  nothing filed in between. CH2609080028 was first seen after its own
   *  collapse, so 18 of its 22 interfaced analytes — WBC, RBC, HGB, HCT, PLT,
   *  the indices, the whole differential — never had a row to be filed against.
   *  Four values filed, HMIS flipped the sample to "result interfaced", and the
   *  report printed blank.
   *
   *  With this on, the connector remembers each service's parameterIds (they
   *  are a property of the SERVICE, identical on every sample: 164 pairs
   *  observed across 9,338 polls, zero conflicts) and rebuilds a missing row by
   *  taking the parameterId from that memory and the per-sample labResultId
   *  from a sibling row of the SAME service on the SAME sample. Restricted to
   *  PARAMETER services, where one labResultId genuinely covers the panel; a
   *  Numeric service is one row per test, so there is no sibling to borrow from
   *  and nothing is ever rebuilt. See src/orders/parameters.ts for the guards.
   *
   *  It cannot invent an analyte HMIS has never named. The BC-6000's 16 CBC
   *  parameters registered under a bare number (42, 300, 460 …) instead of the
   *  instrument mnemonic stay unfilable until that column is fixed in the HMIS
   *  equipment-parameter master — the connector must not guess which number is
   *  which analyte, because a wrong guess files a value against the wrong
   *  analyte on a patient's CBC. */
  fillMissingOrderRows: z.boolean().default(false),
  /** How this analyzer's results reach HMIS.
   *
   *  "queue"  — one spool item per message, delivered in order, retried up to
   *             50 times and then parked. The first item that cannot be filed
   *             (no order row yet) holds up every item behind it.
   *
   *  "staged" — the way the retired middleware worked, rebuilt on files: every
   *             value is written into a per-sample store the moment it arrives
   *             (spool/<id>/results/<barcode>.json, no database), and a filing
   *             pass joins each sample to whatever order rows exist NOW, files
   *             what matches, and leaves the rest waiting. Samples are
   *             independent, nothing is parked, a sample run before its order
   *             was raised simply files later, a rerun replaces the value, and
   *             a mistyped barcode can be re-keyed from the console. Waiting
   *             values expire after retention.days. */
  filing: z
    .object({
      mode: z.enum(['queue', 'staged']).default('queue'),
      /** Staged: how often the filing pass runs on its own. It also runs after
       *  every order poll and the moment a result arrives. */
      passIntervalMs: z.number().int().min(5_000).default(15_000),
      /** Staged: a sample still without order rows is asked about at HMIS
       *  directly (a per-sample pending query) no more often than this — the
       *  order poll covers the normal case, this is the safety net. */
      recheckMs: z.number().int().min(30_000).default(5 * 60_000),
      /** Staged: a fully filed sample stays visible on the console for this
       *  many days, then its file is dropped. */
      keepFiledDays: z.number().int().min(0).max(30).default(2),
    })
    .default({}),
  astm: AstmOptions.default({}),
  abl9: Abl9Options.default({}),
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
    /** Line-delimited JSON record of every gateway call: the query for a
     *  sample and whether orders came back, and each result upload with the
     *  request payload and the response it got. This is the BASE name: entries
     *  are written to one file per day beside it (logs/hmis-YYYY-MM-DD.log)
     *  and kept for retention.logDays. Set to null to switch the file off. */
    auditLog: z.string().nullable().default('./logs/hmis.log'),
    /** A day's file that grows past this continues in a numbered part
     *  (hmis-YYYY-MM-DD.1.log). Nothing is discarded by size. */
    auditMaxBytes: z.number().int().positive().default(10 * 1024 * 1024),
  }),
  /** Housekeeping: how long logs and unfiled spool items are kept on disk. */
  retention: z
    .object({
      /** Keep-window in days for unfiled spool items. 0 disables the whole
       *  sweep (logs included). */
      days: z.number().int().nonnegative().default(7),
      /** Keep-window in days for everything in logDir — the HMIS transaction
       *  log, the per-analyzer wire logs and rotated PM2 output. Files whose
       *  last write is older than this are deleted. Separate from `days` so
       *  the evidence trail can be kept far longer than undeliverable results. */
      logDays: z.number().int().nonnegative().default(30),
      /** Swept at startup and then on this interval. */
      sweepIntervalHours: z.number().positive().default(6),
      /** Directory holding the application and HMIS logs. */
      logDir: z.string().default('./logs'),
      /** Sweep spool/<id>/pending too. Both buckets hold results that never
       *  reached HMIS, so either way a deletion loses one — set false to keep
       *  undelivered work indefinitely and clear only failed/. */
      includeSpoolPending: z.boolean().default(true),
    })
    .default({ days: 7, logDays: 30, sweepIntervalHours: 6, logDir: './logs', includeSpoolPending: true }),
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
  // Extra codes count too: an extra on one analyzer that is another's primary
  // (or extra) would have both machines downloading the same order.
  const seen = new Map<string, string>();
  for (const a of parsed.data.analyzers) {
    for (const raw of [a.equipmentCode, ...a.extraEquipmentCodes]) {
      const code = raw.trim().toUpperCase();
      const owner = seen.get(code);
      if (owner && owner !== a.id) {
        throw new Error(`Analyzers "${owner}" and "${a.id}" both claim equipment code "${raw}" — a code must identify exactly one machine.`);
      }
      if (owner === a.id) {
        throw new Error(`Analyzer "${a.id}" lists equipment code "${raw}" twice.`);
      }
      seen.set(code, a.id);
    }
  }
  return parsed.data;
}
