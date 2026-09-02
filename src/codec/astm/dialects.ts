import type { Delimiters } from './records.js';

// =============================================================================
// ASTM DIALECT LIBRARY
//
// One entry per analyzer model. Adding a machine to this file is the only edit
// needed to support it: the config enum, the order-download builder and the
// result parser all derive from this table.
//
// WHY A LIBRARY AND NOT ONE SHARED FORMAT
// ASTM E1394 fixes the record TYPES (H P O Q R L) and the delimiters, but not
// which field carries what. Every vendor lands its values on different indices,
// and an analyzer silently ignores an order it cannot parse — there is no error
// frame — so a wrong layout looks exactly like a dead cable. Each dialect below
// is therefore a literal field map confirmed against that vendor's own traffic.
//
// HOW A DIALECT IS DEFINED
// Records are sparse field maps: 0-based ASTM field index -> literal text or a
// `$placeholder` filled at build time. Unlisted indices are emitted empty, and
// the record is padded to the highest index in the map — that padding is
// load-bearing, because several analyzers reject a record that ends early.
//
// PLACEHOLDERS
//   $delims $sender $receiver $stamp $seq $sample $priority $tests
//   $patientId $name $birth $sex $specimen
// =============================================================================

/** Sparse ASTM record layout: 0-based field index -> literal or `$placeholder`. */
export type FieldMap = Readonly<Record<number, string>>;

/**
 * Encode/decode the Universal Test ID. This is the field vendors disagree on
 * most, and the one that silently loses results when it is wrong: `decode` runs
 * on every inbound R record, so a bad decoder files real results under a
 * garbage assay code rather than failing loudly.
 */
export interface TestIdCodec {
  /** Build the whole Universal Test ID field from the assay codes on a tube. */
  encode(codes: readonly string[], d: Delimiters): string;
  /** Read ONE assay code back out of an R record's Universal Test ID field. */
  decode(component: string): string;
}

export interface DialectProfile {
  /** Vendor and model this profile was confirmed against. */
  readonly label: string;
  /** Where the confirmation came from. Keep this honest — it is the difference
   *  between a layout we have seen work and one we inferred from a datasheet. */
  readonly confirmedBy: string;
  readonly header: FieldMap;
  /** P record when demographics are sent. */
  readonly patient: FieldMap;
  /** P record when demographics are suppressed. */
  readonly patientAnonymous: FieldMap;
  readonly order: FieldMap;
  readonly terminator: FieldMap;
  /** One O record per assay, vs one O carrying every assay for the tube. */
  readonly orderPerTest: boolean;
  /** H timestamp granularity: 8-digit date or full YYYYMMDDHHMMSS. */
  readonly timestamp: 'date' | 'datetime';
  readonly tests: TestIdCodec;
}

// -----------------------------------------------------------------------------
// Universal Test ID codecs
// -----------------------------------------------------------------------------

/** Manual dilution the host announces on a VITROS download. */
const VITROS_MANUAL_DILUTION = '1.0';
/** Per-assay dilution on a VITROS download: 1 = neat, no on-board dilution. */
const VITROS_TEST_DILUTION = '1';

/** "^^^CA125" — the bare assay code in component 4. */
const plainCode: TestIdCodec = {
  encode: (codes, d) => codes.map((c) => ['', '', '', c].join(d.component)).join(d.repeat),
  decode: (component) => component.trim(),
};

/**
 * "^^^A1c_E^^^1\^^^NA^^^1" — one full Universal Test ID per assay, joined by
 * the repeat delimiter. The trailing "^^^1" is a rank/dilution the Atellica
 * requires: the bare code is rejected as UNKNOWN_TEST even when the assay is
 * configured, because it does not resolve to a runnable assay.
 */
const rankedCode: TestIdCodec = {
  encode: (codes, d) => codes.map((c) => ['', '', '', c, '', '', '1'].join(d.component)).join(d.repeat),
  decode: (component) => component.trim(),
};

/**
 * "^^^1.0+075+1\035+1\032+1" — the VITROS shape.
 *
 * The LIS Guide calls component 4 the LocalOrMfctrCode and defines it as
 * ManualDilution + TestCode + TestDilution, repeated per assay. On the wire
 * that reads as: a single leading manual dilution ("1.0"), then one
 * "+<assay>+<dilution>" group per test, groups joined by the REPEAT delimiter.
 *
 * Two traps live here, both confirmed against the analyzer's own traffic:
 *
 *  1. The published guide shows "~" between assays. The instrument does not use
 *     it — it uses "\". A "~"-joined download is read as one unknown assay.
 *  2. The analyzer echoes a DIFFERENT manual dilution back on results
 *     ("1.000000", not the "1.0" we send), so `decode` must never assume the
 *     value it sent. It takes the middle "+"-group, which is the assay code.
 */
/**
 * Reduce any VITROS assay identifier to the bare code.
 *
 * This has to cope with BOTH forms, because both are in play:
 *   • the analyzer sends "1.000000+032+1" on results,
 *   • the host sends "1.0+032+1" on downloads,
 *   • and HMIS stores the identifier as "1.000000+032+1" in its pending rows,
 *     while a differently-configured deployment may store the bare "032".
 * All of them canonicalise to "032", and the function is idempotent, which is
 * what lets it be used as the join key on both sides of the exchange.
 */
const bareVitrosCode = (identifier: string): string => {
  const parts = identifier.trim().split('+');
  return (parts.length >= 3 ? parts[1] : parts[0])?.trim() ?? '';
};

const vitrosDilutionCode: TestIdCodec = {
  encode: (codes, d) =>
    [
      '',
      '',
      '',
      // Normalise first: the assay codes reaching us come from the HMIS pending
      // row's `eqIdntifier`, which is the FULL "1.000000+032+1" identifier, not
      // a bare code. Wrapping that unchanged would emit
      // "^^^1.0+1.000000+032+1+1" and the analyzer would run nothing.
      `${VITROS_MANUAL_DILUTION}+${codes.map((c) => `${bareVitrosCode(c)}+${VITROS_TEST_DILUTION}`).join(d.repeat)}`,
    ].join(d.component),
  decode: bareVitrosCode,
};

// -----------------------------------------------------------------------------
// The library
// -----------------------------------------------------------------------------

export const ASTM_DIALECT_LIBRARY = {
  /**
   * Siemens Atellica CI, via the CareTech host.
   * H|\^&|||<sender>|||||<receiver>||P|LIS2-A2|<ts14>
   * O|1|<sample>||^^^GluH_3^^^1\^^^NA^^^1|R|||||||O|||<specimen>
   */
  atellica: {
    label: 'Siemens Atellica CI',
    confirmedBy: 'CareTech host wire log',
    header: { 0: 'H', 1: '$delims', 4: '$sender', 9: '$receiver', 11: 'P', 12: 'LIS2-A2', 13: '$stamp' },
    patient: { 0: 'P', 1: '$seq', 2: '$patientId', 5: '$name', 7: '$birth', 8: '$sex' },
    patientAnonymous: { 0: 'P', 1: '$seq', 8: '' },
    order: { 0: 'O', 1: '$seq', 2: '$sample', 4: '$tests', 5: '$priority', 12: 'O', 15: '$specimen' },
    terminator: { 0: 'L', 1: '1', 2: 'N' },
    orderPerTest: false,
    timestamp: 'datetime',
    tests: rankedCode,
  },

  /**
   * Snibe Maglumi — "Chapter 16: Host Result Management", §16.4.2.
   * Every Maglumi header in the spec and in all three captured wire logs
   * carries an 8-digit DATE, and the order record stops after the priority
   * field — the analyzer stops reading a longer one.
   */
  maglumi: {
    label: 'Snibe Maglumi',
    confirmedBy: 'Snibe spec §16.4.2 + three captured wire logs',
    header: { 0: 'H', 1: '$delims', 3: 'PSWD', 4: '$sender', 9: '$receiver', 11: 'P', 12: 'E1394-97', 13: '$stamp' },
    patient: { 0: 'P', 1: '$seq', 2: '$patientId', 5: '$name', 7: '$birth', 8: '$sex' },
    patientAnonymous: { 0: 'P', 1: '$seq' },
    order: { 0: 'O', 1: '$seq', 2: '$sample', 4: '$tests', 5: '$priority' },
    terminator: { 0: 'L', 1: '1', 2: 'N' },
    orderPerTest: true,
    timestamp: 'date',
    tests: plainCode,
  },

  /**
   * Ortho Clinical Diagnostics / QuidelOrtho VITROS ECi / ECiQ.
   *
   * Confirmed byte-for-byte against the outgoing traffic of the lab's existing
   * integration (E:\API_Integration\Devices\ECiQ), which has been running
   * against this analyzer in production:
   *
   *   H|\^&|||HOST|||||||||20260831095904
   *   P|1|10062026002906|||JIGISHBHATT^^|||M|||||||||||||||||||||||||||
   *   O|1|SF2608310003||^^^1.0+075+1\035+1\032+1\074+1|R||||||N||||4||||||||||O||||||
   *   L|1|N
   *
   * Note what is ABSENT from the header: no password, no receiver id, no
   * processing id and no version string — fields 4, 10, 12 and 13 are all
   * empty, where the Siemens and Snibe dialects all populate them. Only the
   * sender ("HOST") and the 14-digit timestamp are sent.
   *
   * The order record's trailing run is load-bearing: action code "N" (new) at
   * field 12, specimen descriptor "4" at field 16, report type "O" at field 26,
   * and the record padded out to field 32.
   */
  'vitros-eciq': {
    label: 'Ortho/QuidelOrtho VITROS ECi / ECiQ',
    confirmedBy: 'production wire log of the existing integration (ECiQ Serial.log / ASTM.log)',
    header: { 0: 'H', 1: '$delims', 4: '$sender', 13: '$stamp' },
    // The analyzer is sent one flat name in component 1; birth date is not sent.
    patient: { 0: 'P', 1: '$seq', 2: '$patientId', 5: '$name', 8: '$sex', 35: '' },
    patientAnonymous: { 0: 'P', 1: '$seq', 35: '' },
    order: {
      0: 'O',
      1: '$seq',
      2: '$sample',
      4: '$tests',
      5: '$priority',
      11: 'N', // action code — new order
      15: '4', // specimen descriptor, as the live integration sends it
      25: 'O', // report type — order
      31: '', // pad the record out; the analyzer expects the full run
    },
    terminator: { 0: 'L', 1: '1', 2: 'N' },
    orderPerTest: false,
    timestamp: 'datetime',
    tests: vitrosDilutionCode,
  },
} as const satisfies Record<string, DialectProfile>;

export type AstmDialect = keyof typeof ASTM_DIALECT_LIBRARY;

export const ASTM_DIALECT_NAMES = Object.keys(ASTM_DIALECT_LIBRARY) as [AstmDialect, ...AstmDialect[]];

export const DEFAULT_DIALECT: AstmDialect = 'atellica';

export function dialect(name: AstmDialect | undefined): DialectProfile {
  return ASTM_DIALECT_LIBRARY[name ?? DEFAULT_DIALECT];
}

/**
 * The key used to join an analyzer's results back to the HMIS pending rows.
 *
 * Both sides name the same assay, but not always with the same string: HMIS
 * carries the VITROS `eqIdntifier` as the full "1.000000+032+1" while the codec
 * reports "032". Running both through the dialect's decoder — which is
 * idempotent — puts them on common ground. Without this the join silently finds
 * nothing and real results are reported as unfileable.
 */
export function assayKey(name: AstmDialect | undefined): (identifier: string) => string {
  const profile = dialect(name);
  return (identifier) => profile.tests.decode(identifier ?? '');
}

// -----------------------------------------------------------------------------
// Field-map rendering
// -----------------------------------------------------------------------------

/**
 * Render a sparse field map into an ASTM record. Every index from 0 to the
 * highest key is emitted, so the trailing empty fields several analyzers insist
 * on are preserved. A placeholder with no value resolves to an empty field.
 */
export function renderRecord(map: FieldMap, values: Record<string, string>, d: Delimiters): string {
  const indices = Object.keys(map).map(Number);
  const max = Math.max(...indices);
  const out: string[] = [];
  for (let i = 0; i <= max; i++) {
    const slot = map[i];
    if (slot === undefined) {
      out.push('');
    } else if (slot.startsWith('$')) {
      out.push(values[slot] ?? '');
    } else {
      out.push(slot);
    }
  }
  return out.join(d.field);
}
