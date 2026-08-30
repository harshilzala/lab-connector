import type {
  InstrumentResult,
  OrderDownload,
  ParsedMessage,
  PatientDemographics,
  HostQuery,
} from '../../types.js';

// =============================================================================
// ASTM E1394 (LIS2-A2) record layer — pure text ⇄ structured conversion.
//
// Records are delimited lines:  H | P | O | R | Q | C | L
// Field delimiter defaults to '|', component '^', repeat '\', escape '&'.
// The H record's second field redefines them, so we read them from there.
//
// ⚠️  FIELD POSITIONS BELOW FOLLOW THE ASTM STANDARD. The exact component that
//     carries the assay code, and any Siemens-specific fields, MUST be verified
//     against the Atellica "Host Interface / LIS Interface Specification" for
//     your unit. Search for "VERIFY-SPEC" to find every position to confirm.
// =============================================================================

export interface Delimiters {
  field: string;
  repeat: string;
  component: string;
  escape: string;
}

export const DEFAULT_DELIMS: Delimiters = { field: '|', repeat: '\\', component: '^', escape: '&' };

// Atellica result-type tokens (Universal Test ID component 8) that are NOT the
// reportable clinical value: RLU = raw light signal, COFF = assay cutoff
// coefficient. Only the DOSE (or an untyped) row carries the result to file.
const NON_REPORTABLE_RESULT_TYPES = new Set(['RLU', 'COFF']);

function detectDelims(lines: string[]): Delimiters {
  const h = lines.find((l) => l.startsWith('H'));
  if (!h || h.length < 6) return DEFAULT_DELIMS;
  // H<field><delims-field><...>  e.g.  H|\^&|...
  const field = h[1] ?? '|';
  const delimField = h.slice(2, h.indexOf(field, 2) === -1 ? undefined : h.indexOf(field, 2));
  // delimField is typically "\^&" = repeat, component, escape
  return {
    field,
    repeat: delimField[0] ?? '\\',
    component: delimField[1] ?? '^',
    escape: delimField[2] ?? '&',
  };
}

const comps = (v: string | undefined, d: Delimiters) => (v ?? '').split(d.component);
const reps = (v: string | undefined, d: Delimiters) => (v ?? '').split(d.repeat).filter((x) => x !== '');

/** Pick the assay code out of a Universal Test ID field ("^^^CODE^Name"). */
function testCodeFromUniversalId(field: string | undefined, d: Delimiters): string {
  const c = comps(field, d);
  // VERIFY-SPEC: ASTM places the code in the 4th component (index 3). Some
  // analyzers use the 1st. Fall back to the first non-empty component.
  if (c[3] && c[3].trim()) return c[3].trim();
  return c.find((x) => x.trim())?.trim() ?? '';
}

// -----------------------------------------------------------------------------
// Parse a whole inbound message (record lines, control chars already stripped).
// -----------------------------------------------------------------------------
export function parseMessage(recordLines: string[], raw: string): ParsedMessage {
  // Records may arrive one-per-frame OR packed several-per-frame separated by CR
  // (the CareTech/Atellica host puts H/Q/L in a single ETX-terminated frame).
  // Split on CR/LF so every ASTM record is parsed regardless of framing style.
  const lines = recordLines.flatMap((l) => l.split(/\r\n|\r|\n/)).filter((l) => l.length > 0);
  const d = detectDelims(lines);

  const msg: ParsedMessage = { protocol: 'astm', sender: null, patient: null, queries: [], results: [], raw };

  let currentPatient: PatientDemographics | null = null;
  let currentSampleId = '';

  for (const line of lines) {
    const type = line[0]?.toUpperCase();
    const f = line.split(d.field);

    switch (type) {
      case 'H': {
        // 5th field (index 4) = sender name/ID (informational).
        msg.sender = comps(f[4], d)[0] || null;
        break;
      }
      case 'P': {
        // 6 = name (Last^First^Middle), 8 = birthdate, 9 = sex.
        const name = comps(f[5], d);
        currentPatient = {
          patientId: (f[3] || f[2] || '').trim() || null, // VERIFY-SPEC: lab vs practice PID
          lastName: name[0]?.trim() || null,
          firstName: name[1]?.trim() || null,
          middleName: name[2]?.trim() || null,
          birthDate: (f[7] || '').trim() || null,
          sex: normaliseSex(f[8]),
        };
        msg.patient = currentPatient;
        break;
      }
      case 'O': {
        // 3 = specimen ID (the tube barcode / accession).
        currentSampleId = comps(f[2], d)[0]?.trim() || (f[2] || '').trim();
        break;
      }
      case 'Q': {
        // Host query starting-range ID, e.g. "^lab-2026-0000011^CC031887^3":
        // component 1 is the HMIS accession barcode; the later components are the
        // container id / aliquot sequence. Use the FIRST non-empty component, to
        // match the O-record specimen-id logic and the barcode HMIS registers.
        const rangeComps = comps(f[2], d);
        const sampleId = rangeComps.find((x) => x.trim())?.trim() || '';
        const query: HostQuery = { sampleId, testCodes: [] };
        currentSampleId = sampleId;
        msg.queries.push(query);
        break;
      }
      case 'R': {
        // Siemens Atellica emits several R records per analyte: a raw RLU signal
        // ("^^^Ca^^^1^RLU^..."), intermediate coefficients such as the assay
        // cutoff ("...^COFF^..."), and the reportable DOSE result ("...^DOSE^..").
        // The result-type is the 8th component (index 7) of the Universal Test
        // ID. File only the reportable value — skip the raw/intermediate rows so
        // HMIS receives one result per analyte (otherwise the COFF value is filed
        // as a second, conflicting result). Analyzers that omit this component
        // (empty index 7) are unaffected and still file.
        const resultType = comps(f[2], d)[7]?.trim().toUpperCase();
        if (resultType && NON_REPORTABLE_RESULT_TYPES.has(resultType)) break;

        const result: InstrumentResult = {
          sampleId: currentSampleId,
          testCode: testCodeFromUniversalId(f[2], d),
          value: (f[3] || '').trim(),
          unit: (f[4] || '').trim() || null,
          referenceRange: (f[5] || '').trim() || null,
          abnormalFlag: (f[6] || '').trim() || null,
          // Result status may carry a repeat delimiter (Atellica sends "F\R");
          // keep the first component so HMIS gets a clean F | P | C | X.
          status: reps(f[8], d)[0]?.trim() || null,
          completedAt: (f[12] || '').trim() || null, // VERIFY-SPEC: date completed position
          instrument: (f[13] || '').trim() || null,
        };
        if (result.testCode) msg.results.push(result);
        break;
      }
      // C (comment) and L (terminator) carry no data we file today.
      default:
        break;
    }
  }
  return msg;
}

function normaliseSex(v: string | undefined): 'M' | 'F' | 'O' | null {
  const s = (v || '').trim().toUpperCase();
  if (s === 'M') return 'M';
  if (s === 'F') return 'F';
  if (!s) return null;
  return 'O';
}

// =============================================================================
// Instrument dialects for the ORDER DOWNLOAD.
//
// Everything above is vendor-neutral — the Q/O/R positions read every analyzer
// we have logs for. The download is not: vendors disagree on how to express
// "run these assays on this tube", and an analyzer quietly ignores or rejects
// an order it cannot parse. Each entry below is one vendor's shape, taken from
// that vendor's spec and confirmed against its wire log — `npm run dialects`
// replays them and diffs the generated download.
//
// Adding a machine means adding an entry here: the config enum derives from
// this table, so nothing else changes.
// =============================================================================
export interface OrderFormat {
  /** H field 12 — the ASTM version the analyzer announces and expects back. */
  version: string;
  /** H field 4 — access password. Snibe expects the literal "PSWD". */
  password: string;
  /**
   * Universal Test ID components AFTER the code. The Atellica needs a rank /
   * dilution "1" ("^^^A1c_E^^^1") — the bare code is rejected as UNKNOWN_TEST
   * even when the assay is configured, because it does not resolve to a
   * runnable assay (confirmed against the CareTech host wire log). Snibe wants
   * the bare "^^^CA125" and treats trailing components as a malformed record.
   */
  testIdTail: readonly string[];
  /** One O record per assay (Snibe) vs one O carrying every assay (Siemens). */
  orderPerTest: boolean;
  /**
   * Keep O fields 12 (report type "O") and 16 (specimen descriptor). The
   * Atellica/CareTech host rejects an empty field 16 with "invalid specimen
   * type"; the Maglumi stops reading the record after the priority field.
   */
  fullOrderRecord: boolean;
  /** Trailing empty fields on a P record when demographics are suppressed. */
  emptyPatientFields: number;
  /**
   * H field 14 granularity. The Atellica exchanges a full YYYYMMDDHHMMSS. Every
   * Maglumi header in the Snibe spec and in all three captured wire logs carries
   * an 8-digit DATE ("20100319") — the only field where our download still
   * differed from the vendor's own examples, so we match them.
   */
  timestamp: 'date' | 'datetime';
}

export const ORDER_FORMATS = {
  /** Siemens Atellica CI, via the CareTech host. */
  atellica: {
    version: 'LIS2-A2',
    password: '',
    testIdTail: ['', '', '1'],
    orderPerTest: false,
    fullOrderRecord: true,
    emptyPatientFields: 7,
    timestamp: 'datetime',
  },
  /** Snibe Maglumi — "Chapter 16: Host Result Management", §16.4.2. */
  maglumi: {
    version: 'E1394-97',
    password: 'PSWD',
    testIdTail: [],
    orderPerTest: true,
    fullOrderRecord: false,
    emptyPatientFields: 0,
    timestamp: 'date',
  },
} as const satisfies Record<string, OrderFormat>;

export type AstmDialect = keyof typeof ORDER_FORMATS;

export const DEFAULT_DIALECT: AstmDialect = 'atellica';

// -----------------------------------------------------------------------------
// Build an order-download message (host-query reply / broadcast download).
// Returns record strings WITHOUT frame numbers/checksums — the link frames them.
// -----------------------------------------------------------------------------
export function buildOrderMessage(
  orders: OrderDownload[],
  opts: { senderId: string; receiverId: string; sendDemographics: boolean; dialect?: AstmDialect },
  d: Delimiters = DEFAULT_DELIMS,
): string[] {
  const F = d.field;
  const fmt: OrderFormat = ORDER_FORMATS[opts.dialect ?? DEFAULT_DIALECT];
  const lines: string[] = [];

  // H|\^&||<password>|<sender>|||||<receiver>||P|<version>|<ts>
  lines.push(
    ['H', `${d.repeat}${d.component}${d.escape}`, '', fmt.password, opts.senderId, '', '', '', '', opts.receiverId, '', 'P', fmt.version, headerStamp(fmt)].join(F),
  );

  /** "^^^CODE" or "^^^CODE^^^1", per dialect. */
  const universalId = (code: string) => ['', '', '', code, ...fmt.testIdTail].join(d.component);

  // O|<seq>|<specimenId>||<universal>|<priority>[|||||||O|||<specimenType>]
  const orderRecord = (seq: number, o: OrderDownload, universal: string): string =>
    fmt.fullOrderRecord
      ? ['O', String(seq), o.sampleId, '', universal, o.priority ?? 'R', '', '', '', '', '', '', 'O', '', '', o.specimenType ?? ''].join(F)
      : ['O', String(seq), o.sampleId, '', universal, o.priority ?? 'R'].join(F);

  orders.forEach((o, i) => {
    const seq = i + 1;

    if (opts.sendDemographics && o.patient) {
      const p = o.patient;
      const name = [p.lastName ?? '', p.firstName ?? '', p.middleName ?? ''].join(d.component);
      // P|<seq>|<practicePID>|<labPID>||<name>||<birth>|<sex>
      lines.push(['P', String(seq), p.patientId ?? '', '', '', name, '', p.birthDate ?? '', p.sex ?? ''].join(F));
    } else {
      lines.push(['P', String(seq), ...Array<string>(fmt.emptyPatientFields).fill('')].join(F));
    }

    if (fmt.orderPerTest) {
      // ASTM restarts the sequence number for each new parent record, so the O
      // records count 1..n within this patient — matching the Snibe example.
      o.testCodes.forEach((code, k) => lines.push(orderRecord(k + 1, o, universalId(code))));
    } else {
      // Assays repeat-delimited into one O, e.g. "^^^GluH_3^^^1\^^^NA^^^1".
      lines.push(orderRecord(seq, o, o.testCodes.map(universalId).join(d.repeat)));
    }
  });

  // L|1|N
  lines.push(['L', '1', 'N'].join(F));
  return lines;
}

/** H field 14, at the granularity this dialect's own headers use. */
function headerStamp(fmt: OrderFormat, dt = new Date()): string {
  const ts = astmTimestamp(dt);
  return fmt.timestamp === 'date' ? ts.slice(0, 8) : ts;
}

/** ASTM timestamp YYYYMMDDHHMMSS in local time. */
export function astmTimestamp(dt = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    String(dt.getFullYear()) +
    p(dt.getMonth() + 1) +
    p(dt.getDate()) +
    p(dt.getHours()) +
    p(dt.getMinutes()) +
    p(dt.getSeconds())
  );
}
