import type {
  MirthAcknowledgeItem,
  MirthPendingRow,
  PatientDemographics,
  PendingOrders,
} from '../types.js';

// =============================================================================
// Normalizer for GET {pendingPath}.
//
// The endpoint returns ONE ROW PER PENDING TEST — several rows share a sampleID
// — so building a work order means collapsing the rows for one barcode into a
// single list of assay codes, and keeping each row so it can be acknowledged
// afterwards.
//
// Field naming is only pinned down for the columns the /mirth/acknowledge body
// echoes (sampleID, equipmentId, identifier, ipAddress, isTransmitted,
// labResultId, labServiceId, portNo, parameterId). Patient and specimen columns
// vary per deployment, so every lookup goes through `pick()` with a list of
// aliases and anything unmatched is simply left null — never guessed.
// =============================================================================

const SAMPLE_KEYS = ['sampleID', 'sampleId', 'sampleid', 'sample_id', 'barcode', 'accessionNo', 'accessionNumber'];
const TEST_KEYS = ['identifier', 'testCode', 'test_code', 'code', 'parameterCode', 'instrumentCode', 'shortName'];
const EQ_CODE_KEYS = ['eqCode', 'equipmentCode', 'equipment_code', 'machineCode', 'equipmentName'];
const SPECIMEN_KEYS = ['specimenType', 'sampleType', 'specimen', 'specimenName', 'sampleTypeName', 'containerType'];
const PRIORITY_KEYS = ['priority', 'isStat', 'stat', 'urgent', 'isUrgent', 'isEmergency'];

const PATIENT_ID_KEYS = ['uhid', 'UHID', 'patientId', 'patientID', 'patientCode', 'mrn', 'mrNo'];
const FIRST_NAME_KEYS = ['firstName', 'patientFirstName', 'fname'];
const LAST_NAME_KEYS = ['lastName', 'patientLastName', 'lname', 'surname'];
const MIDDLE_NAME_KEYS = ['middleName', 'patientMiddleName', 'mname'];
const FULL_NAME_KEYS = ['patientName', 'name', 'fullName'];
const SEX_KEYS = ['sex', 'gender', 'patientGender', 'patientSex'];
const DOB_KEYS = ['dob', 'DOB', 'birthDate', 'dateOfBirth', 'patientDob'];

/** Envelope keys to look inside when the body is an object rather than an array. */
const ENVELOPE_KEYS = ['data', 'result', 'results', 'orders', 'content', 'payload', 'items', 'list', 'rows'];

export interface NormalizeOptions {
  /** Barcode the analyzer asked about — rows for other samples are dropped. */
  sampleId: string;
  /** This analyzer's eqCode — rows that name a different machine are dropped. */
  eqCode?: string;
  /** Fallbacks for acknowledge fields the pending row does not carry. */
  equipmentId?: string | number | null;
  ipAddress?: string;
  portNo?: string;
}

/** Pull the row array out of whatever envelope the server wrapped it in. */
export function unwrapRows(body: unknown): MirthPendingRow[] {
  if (Array.isArray(body)) return body as MirthPendingRow[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ENVELOPE_KEYS) {
      if (Array.isArray(obj[key])) return obj[key] as MirthPendingRow[];
    }
    // A single row returned bare (not wrapped in an array).
    if (pick(obj, SAMPLE_KEYS) !== null) return [obj as MirthPendingRow];
  }
  return [];
}

/** Collapse the pending rows for one barcode into a single downloadable order. */
export function normalizePending(body: unknown, opts: NormalizeOptions): PendingOrders {
  const wanted = (opts.sampleId || '').trim().toUpperCase();
  const eqCode = (opts.eqCode || '').trim().toUpperCase();

  const rows = unwrapRows(body).filter((row) => {
    // Already downloaded to an analyzer — do not send it twice.
    if (row.isTransmitted === true) return false;
    // The server treats every query param as optional, so it may ignore
    // sampleId/eqCode and return more than we asked for. Filter defensively,
    // but only on rows that actually carry the column.
    const rowSample = pick(row, SAMPLE_KEYS);
    if (wanted && rowSample !== null && String(rowSample).trim().toUpperCase() !== wanted) return false;
    const rowEq = pick(row, EQ_CODE_KEYS);
    if (eqCode && rowEq !== null && String(rowEq).trim().toUpperCase() !== eqCode) return false;
    return true;
  });

  const testCodes: string[] = [];
  const ackItems: MirthAcknowledgeItem[] = [];
  let patient: PatientDemographics | null = null;
  let specimenType: string | null = null;
  let priority: 'S' | 'R' = 'R';

  for (const row of rows) {
    const code = pick(row, TEST_KEYS);
    if (code === null || String(code).trim() === '') continue; // nothing to run
    const testCode = String(code).trim();
    if (!testCodes.includes(testCode)) testCodes.push(testCode);

    ackItems.push({
      sampleID: String(pick(row, SAMPLE_KEYS) ?? opts.sampleId),
      equipmentId: (row.equipmentId as number | string | undefined) ?? opts.equipmentId ?? null,
      identifier: testCode,
      ipAddress: String(row.ipAddress ?? opts.ipAddress ?? ''),
      // Echo the row's own flag (false on a fresh pending row) — the server is
      // what flips it, we only report which rows we handed to the analyzer.
      isTransmitted: row.isTransmitted === true,
      labResultId: toNumber(row.labResultId),
      labServiceId: toNumber(row.labServiceId),
      portNo: String(row.portNo ?? opts.portNo ?? ''),
      parameterId: toNumber(row.parameterId),
    });

    // Sample-level attributes repeat on every row; take the first non-empty.
    if (!patient) patient = extractPatient(row);
    if (specimenType === null) {
      const spec = pick(row, SPECIMEN_KEYS);
      if (spec !== null && String(spec).trim() !== '') specimenType = String(spec).trim();
    }
    if (priority === 'R' && isStat(pick(row, PRIORITY_KEYS))) priority = 'S';
  }

  return {
    found: testCodes.length > 0,
    sampleId: opts.sampleId,
    testCodes,
    patient,
    priority,
    specimenType,
    ackItems,
  };
}

// ---- helpers ---------------------------------------------------------------

/** First key present with a non-null, non-empty value. */
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isStat(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toUpperCase();
  return s === 'S' || s === 'STAT' || s === 'TRUE' || s === '1' || s === 'URGENT' || s === 'EMERGENCY';
}

function extractPatient(row: Record<string, unknown>): PatientDemographics | null {
  const patientId = pick(row, PATIENT_ID_KEYS);
  let first = pick(row, FIRST_NAME_KEYS);
  let last = pick(row, LAST_NAME_KEYS);
  const middle = pick(row, MIDDLE_NAME_KEYS);

  if (!first && !last) {
    // Only a single name column — split "Last, First" or "First Last".
    const full = pick(row, FULL_NAME_KEYS);
    if (full !== null) {
      const s = String(full).trim();
      if (s.includes(',')) {
        const [l, f] = s.split(',', 2);
        last = (l ?? '').trim();
        first = (f ?? '').trim();
      } else {
        const parts = s.split(/\s+/);
        first = parts.shift() ?? '';
        last = parts.join(' ');
      }
    }
  }

  const sexRaw = pick(row, SEX_KEYS);
  const sexChar = sexRaw === null ? null : String(sexRaw).trim().charAt(0).toUpperCase();
  const sex = sexChar === 'M' || sexChar === 'F' ? (sexChar as 'M' | 'F') : sexChar ? 'O' : null;

  const birthDate = toAstmDate(pick(row, DOB_KEYS));

  if (!patientId && !first && !last && !sex && !birthDate) return null;
  return {
    patientId: patientId === null ? null : String(patientId),
    firstName: first ? String(first) : null,
    lastName: last ? String(last) : null,
    middleName: middle === null ? null : String(middle),
    sex,
    birthDate,
  };
}

/** dd-MM-yyyy (the API's own date format), dd/MM/yyyy or ISO → ASTM YYYYMMDD. */
function toAstmDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;

  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}${dmy[2]}${dmy[1]}`;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;

  if (/^\d{8}$/.test(s)) return s; // already YYYYMMDD
  return null;
}

/** Today (or a given date) in the dd-MM-yyyy format the endpoint documents. */
export function formatApiDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
