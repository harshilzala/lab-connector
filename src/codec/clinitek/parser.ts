import type { InstrumentResult } from '../../types.js';

// =============================================================================
// CLINITEK Advantus (Siemens urine chemistry) record parser.
//
// The CLINITEK Advantus speaks standard ASTM E1381/E1394 over serial: an
// ENQ→ACK handshake, STX-framed blocks with a leading frame number and a
// trailing checksum, and CR-delimited H/P/O/R/L records inside. The framing is
// handled by the link (see link.ts); this module is the record layer.
//
// The field positions below are transcribed 1:1 from the production caretech
// middleware that ran against the real instrument — CLINITEK_ADVANTUS.cs,
// method FormateData(). They intentionally DO NOT follow the generic ASTM
// component layout used by the Atellica/ASTM codec: the CLINITEK puts the test
// code and value at pipe-field positions 3 and 5 of the R record, the specimen
// id at field 2 of the O record, and re-uses field 4 of a "1" P record as the
// sample id. We reproduce those exact offsets rather than the standard because
// this is the layout the machine actually emits. Reference lines are cited at
// each case so the mapping can be audited against the .cs source.
//
// As everywhere in this connector, the instrument-code → HMIS-parameter mapping
// stays on the SERVER (LabInstrumentCodeMap); we emit the instrument's own code.
// =============================================================================

export interface ClinitekMessage {
  /** Specimen/sample id carried by the last O or P record, informational. */
  sampleId: string | null;
  results: InstrumentResult[];
}

/**
 * Parse the CR-delimited record lines of one CLINITEK Advantus transmission.
 *
 * Records arrive in order (H, then P and/or O to establish the sample id, then
 * one R per analyte, then L). The current sample id is threaded onto each R
 * result exactly as the legacy middleware did (objInsertData.Sample_ID persists
 * across records until the L terminator clears it).
 */
export function parseClinitekMessage(records: string[]): ClinitekMessage {
  const results: InstrumentResult[] = [];
  let currentSampleId: string | null = null;
  let lastSampleId: string | null = null; // retained past the L terminator for reporting

  for (const raw of records) {
    const line = raw.replace(/[\r\n]+$/g, '');
    if (line.length < 2) continue;
    const type = line[0]!.toUpperCase();

    switch (type) {
      // H — message header. Carries no result data. (CLINITEK_ADVANTUS.cs:274)
      case 'H':
        break;

      // O — order/specimen record. The sample id (barcode/accession) is at
      // pipe-field 2, after collapsing caret sub-components to spaces the way
      // the legacy parser did. (CLINITEK_ADVANTUS.cs:276-282)
      case 'O': {
        const f = line.replace(/\^/g, ' ').split('|');
        const id = (f[2] ?? '').trim();
        if (id) currentSampleId = lastSampleId = id;
        break;
      }

      // P — patient record. For the primary patient (sequence field == "1") the
      // CLINITEK re-uses pipe-field 4 as the sample id. (CLINITEK_ADVANTUS.cs:302-315)
      case 'P': {
        const f = line.split('|');
        if ((f[1] ?? '').trim() === '1') {
          const id = (f[4] ?? '').trim();
          if (id) currentSampleId = lastSampleId = id;
        }
        break;
      }

      // R — result record. Test code at pipe-field 3, value at pipe-field 5.
      // URO carries its value as "value^..." so only the first caret component
      // is taken; every other analyte uses the field verbatim.
      // (CLINITEK_ADVANTUS.cs:283-301)
      case 'R': {
        const f = line.split('|');
        const testCode = (f[3] ?? '').trim();
        if (!testCode) break;
        const rawValue = f[5] ?? '';
        const value = (testCode.toUpperCase() === 'URO' ? rawValue.split('^')[0]! : rawValue).trim();
        results.push({
          sampleId: currentSampleId ?? '',
          testCode,
          value,
          instrument: 'CLINITEK-ADVANTUS',
        });
        break;
      }

      // L — terminator. Clears the sample id. (CLINITEK_ADVANTUS.cs:316-320)
      case 'L':
        currentSampleId = null;
        break;

      default:
        break;
    }
  }

  return { sampleId: lastSampleId, results };
}
