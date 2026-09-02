// =============================================================================
// Shared domain types for the lab-connector.
//
// These are transport/protocol-agnostic: the ASTM (or future HL7) codec parses
// wire bytes into these shapes, the orchestrator reasons over them, and the
// HMIS client serialises them to the REST API. Keeping one neutral vocabulary
// is what makes the codec pluggable.
// =============================================================================

export type Direction = 'IN' | 'OUT';
export type ProtocolName = 'astm' | 'hl7' | 'kermit' | 'advia2120i' | 'clinitek-advantus';

// ---- Analyzer → connector: a request for what to run on a sample -----------
// (ASTM "Q" query record, or an order-less result upload that implies query.)
export interface HostQuery {
  /** Sample / accession barcode the analyzer read off the tube. */
  sampleId: string;
  /** Optional specific test codes the analyzer is asking about ("ALL" if empty). */
  testCodes?: string[];
}

// ---- Connector → analyzer: the work order to download ----------------------
export interface OrderDownload {
  sampleId: string;
  /** Instrument assay codes to run for this sample (already mapped). */
  testCodes: string[];
  priority?: 'S' | 'R'; // STAT | Routine
  /** Optional demographics — only populated when sendDemographics is enabled. */
  patient?: PatientDemographics | null;
  /** Specimen/collection metadata if the analyzer wants it. */
  collectedAt?: string | null;
  /** Specimen descriptor (ASTM O-record field 16), e.g. "Serum". The Atellica
   *  rejects an order with an empty specimen type. */
  specimenType?: string | null;
}

export interface PatientDemographics {
  patientId?: string | null; // UHID
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  sex?: 'M' | 'F' | 'O' | null;
  birthDate?: string | null; // YYYYMMDD
}

// ---- Analyzer → connector: one measured result -----------------------------
export interface InstrumentResult {
  sampleId: string;
  /** The analyzer's own assay/analyte code, e.g. "GLU", "ALT", "TSH". */
  testCode: string;
  value: string;
  unit?: string | null;
  referenceRange?: string | null;
  /** Analyzer's own abnormal flag, e.g. "H", "L", "HH", "LL", "N", ">", "<". */
  abnormalFlag?: string | null;
  /** Result status: F=final, P=preliminary, C=correction, X=cancelled. */
  status?: string | null;
  completedAt?: string | null; // ISO or YYYYMMDDHHMMSS as received
  operator?: string | null;
  instrument?: string | null;
}

// ---- A fully parsed inbound message (one ASTM session / HL7 message) --------
export interface ParsedMessage {
  protocol: ProtocolName;
  /** ASTM header sender id / HL7 sending app, informational. */
  sender?: string | null;
  patient?: PatientDemographics | null;
  /** Query records — present in host-query requests. */
  queries: HostQuery[];
  /** Result records — present in result uploads. */
  results: InstrumentResult[];
  /** The raw wire text, retained for the audit log. */
  raw: string;
}

// ---- HMIS REST contract ----------------------------------------------------
// The three endpoints are UNAUTHENTICATED — no equipment id, no shared secret,
// no HMAC signature. The analyzer is identified by the `eqCode` query
// parameter, which carries the config's `equipmentCode`.
//
// GET {pendingPath} → rows, POST {acknowledgePath} → the rows we handed over.
//
// The pending endpoint returns ONE ROW PER PENDING TEST, so several rows share
// a sampleID. Only the columns the acknowledge body echoes are pinned down —
// patient, specimen and priority column naming varies per deployment, so
// src/hmis/pending.ts resolves those through the *_KEYS alias arrays and leaves
// anything it cannot match null rather than guessing.
export interface MirthPendingRow {
  sampleID?: string | number;
  equipmentId?: string | number;
  /** The instrument assay code for this row. */
  identifier?: string;
  ipAddress?: string;
  /** Already downloaded to an analyzer — such rows are not offered again. */
  isTransmitted?: boolean;
  labResultId?: string | number;
  labServiceId?: string | number;
  portNo?: string | number;
  parameterId?: string | number;
  /** Deployment-specific columns, read through the alias lists in pending.ts. */
  [column: string]: unknown;
}

/** One element of the POST {acknowledgePath} body. */
export interface MirthAcknowledgeItem {
  sampleID: string;
  equipmentId: string | number | null;
  identifier: string;
  ipAddress: string;
  /** Always true: the connector only acknowledges rows it has actually
   *  downloaded and filed. It is an assertion to the gateway, not an echo. */
  isTransmitted: boolean;
  labResultId: number | null;
  labServiceId: number | null;
  portNo: string;
  parameterId: number | null;
}

/** Pending rows for one barcode, collapsed into a single downloadable order. */
export interface PendingOrders {
  found: boolean;
  sampleId: string;
  testCodes: string[];
  patient: PatientDemographics | null;
  priority: 'S' | 'R';
  specimenType: string | null;
  /** The rows behind this order, ready to POST once the download succeeds. */
  ackItems: MirthAcknowledgeItem[];
}

// POST {resultsPath}
export interface HmisResultUpload {
  /** Numeric HMIS equipment id when the config supplies one — optional now
   *  that `eqCode` identifies the machine. */
  equipmentId: string | number | null;
  /** VERIFY-SPEC: the analyzer's `equipmentCode`, sent because the pending and
   *  acknowledge calls both key off eqCode and equipmentId may be absent. Drop
   *  this field if the results endpoint rejects unknown properties. */
  eqCode: string;
  barcode: string;
  /** Set when the sample is a QC/control material rather than a patient sample. */
  isQc?: boolean;
  results: Array<{
    testCode: string;
    value: string;
    unit?: string | null;
    abnormalFlag?: string | null;
    status?: string | null; // F | P | C | X
    completedAt?: string | null;
  }>;
  /** Raw wire text for the server-side interface message log. */
  raw?: string;
  /** Idempotency key so re-sends from the spool don't double-file. */
  messageId: string;
}

/**
 * One element of the POST {resultsPath} body — the wire shape the HMIS gateway
 * deserializes into `java.util.List<com.his.lab.domain.LisInboundResults>`.
 *
 * The endpoint takes a BARE ARRAY of these; there is no wrapper object. Every
 * identifier except `resultValue` comes from the pending row the order was
 * downloaded from, NOT from the analyzer — `labResultId` is what the server
 * files against, so a result with no matching pending row cannot be uploaded.
 */
export interface LisInboundResultRow {
  sampleId: string;
  labServiceId: number | null;
  labResultId: number | null;
  equipmentId: string | number | null;
  ipAddress: string;
  portNo: string;
  /** The analyzer's own assay code, from the pending row's `eqIdntifier`. */
  identifier: string;
  /** The measured value, as text, exactly as the analyzer reported it. */
  resultValue: string;
  isLoaded: boolean;
  uniqueIdentifier: string;
  parameterId: number | null;
}

/** The gateway's envelope. NOTE: it answers HTTP 200 even on failure — the
 *  `status` field is the only reliable indicator, so callers must check it. */
export interface HmisResultUploadResponse {
  status: string; // "success" | "failure"
  message: string;
  /** The rows the server accepted; empty when nothing matched. */
  successData: Array<{
    sampleId?: string;
    labServiceId?: number;
    labResultId?: number;
    equipmentId?: number;
  }>;
  /** Convenience: `successData.length`. */
  filed: number;
}
