import type {
  InstrumentResult,
  OrderDownload,
  ParsedMessage,
  PatientDemographics,
  HostQuery,
} from '../../types.js';
import { dialect, renderRecord, type AstmDialect } from './dialects.js';

export {
  assayKey,
  ASTM_DIALECT_LIBRARY,
  ASTM_DIALECT_NAMES,
  DEFAULT_DIALECT,
  type AstmDialect,
  type DialectProfile,
} from './dialects.js';

// =============================================================================
// ASTM E1394 (LIS2-A2) record layer — pure text ⇄ structured conversion.
//
// Records are delimited lines:  H | P | O | R | Q | C | L
// Field delimiter defaults to '|', component '^', repeat '\', escape '&'.
// The H record's second field redefines them, so we read them from there.
//
// Record POSITIONS here follow the ASTM standard and read every analyzer we
// have logs for. Everything a vendor does differently — the order-download
// field maps and the Universal Test ID's inner shape — lives in the dialect
// library, ./dialects.ts. Add a machine there, not here.
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

/**
 * Pick the assay code out of a Universal Test ID field ("^^^CODE^Name").
 *
 * ASTM places the code in the 4th component (index 3), but what that component
 * CONTAINS is vendor-specific — a VITROS wraps the code in a dilution pair
 * ("1.000000+032+1"), so the dialect's own decoder unpacks it. Getting this
 * wrong does not fail loudly: real results simply get filed under a garbage
 * assay code.
 */
function testCodeFromUniversalId(field: string | undefined, d: Delimiters, name?: AstmDialect): string {
  const c = comps(field, d);
  const raw = c[3] && c[3].trim() ? c[3].trim() : (c.find((x) => x.trim())?.trim() ?? '');
  return raw ? dialect(name).tests.decode(raw) : '';
}

// -----------------------------------------------------------------------------
// Parse a whole inbound message (record lines, control chars already stripped).
//
// Record POSITIONS here are vendor-neutral — they read every analyzer we have
// logs for. Only the Universal Test ID's inner shape needs the dialect.
// -----------------------------------------------------------------------------
export function parseMessage(recordLines: string[], raw: string, name?: AstmDialect): ParsedMessage {
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
          testCode: testCodeFromUniversalId(f[2], d, name),
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
// -----------------------------------------------------------------------------
// Build an order-download message (host-query reply / broadcast download).
//
// Every vendor difference lives in the dialect library (./dialects.ts) — this
// function only fills placeholders into that dialect's field maps. Supporting a
// new analyzer means adding one entry there, not editing this code.
//
// Returns record strings WITHOUT frame numbers/checksums — the link frames them.
// -----------------------------------------------------------------------------
export function buildOrderMessage(
  orders: OrderDownload[],
  opts: { senderId: string; receiverId: string; sendDemographics: boolean; dialect?: AstmDialect },
  d: Delimiters = DEFAULT_DELIMS,
): string[] {
  const fmt = dialect(opts.dialect);
  const lines: string[] = [];

  const stamp = astmTimestamp();
  lines.push(
    renderRecord(fmt.header, {
      $delims: `${d.repeat}${d.component}${d.escape}`,
      $sender: opts.senderId,
      $receiver: opts.receiverId,
      $stamp: fmt.timestamp === 'date' ? stamp.slice(0, 8) : stamp,
    }, d),
  );

  orders.forEach((o, i) => {
    const seq = i + 1;

    if (opts.sendDemographics && o.patient) {
      const p = o.patient;
      lines.push(
        renderRecord(fmt.patient, {
          $seq: String(seq),
          $patientId: p.patientId ?? '',
          $name: [p.lastName ?? '', p.firstName ?? '', p.middleName ?? ''].join(d.component),
          $birth: p.birthDate ?? '',
          $sex: p.sex ?? '',
        }, d),
      );
    } else {
      lines.push(renderRecord(fmt.patientAnonymous, { $seq: String(seq) }, d));
    }

    const orderRecord = (n: number, codes: readonly string[]) =>
      renderRecord(fmt.order, {
        $seq: String(n),
        $sample: o.sampleId,
        $tests: fmt.tests.encode(codes, d),
        $priority: o.priority ?? 'R',
        $specimen: o.specimenType ?? '',
      }, d);

    if (fmt.orderPerTest) {
      // ASTM restarts the sequence number for each new parent record, so the O
      // records count 1..n within this patient.
      o.testCodes.forEach((code, k) => lines.push(orderRecord(k + 1, [code])));
    } else {
      lines.push(orderRecord(seq, o.testCodes));
    }
  });

  lines.push(renderRecord(fmt.terminator, {}, d));
  return lines;
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
