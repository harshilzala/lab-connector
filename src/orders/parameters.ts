import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../logger.js';
import type { MirthAcknowledgeItem } from '../types.js';

// =============================================================================
// ParameterCatalogue — what this analyzer has learned about the SHAPE of each
// HMIS service, so a result can still be filed when the pending list forgets a
// parameter it once offered.
//
// The problem it solves, measured on CH2609080028 (2026-09-08, BC-6000).
//
// HMIS registers a CBC (labServiceId 3141) as a PARAMETER service: one
// labResultId covers the whole panel, and each analyte is a separate pending
// row carrying its own parameterId. The results endpoint files against
// labResultId + parameterId, and the ONLY place a parameterId is ever offered
// is that pending row. So an analyte with no pending row cannot be filed.
//
// The gateway drops rows it has already offered. On CH2609080017 the full panel
// was there at 05:01:25 (38 rows, 22 of them under the analyzer's own mnemonic)
// and gone 29 seconds later at 05:01:54 (20 rows, 4 mnemonics) — for a sample
// nothing had yet filed. That sample survived only because the connector had
// already cached the complete list before the collapse. CH2609080028 was first
// seen AFTER its own collapse: every one of the 29 polls that mentioned it
// returned the same 20 rows, so 18 of the 22 interfaced analytes — WBC, RBC,
// HGB, HCT, PLT, the indices, the whole differential — never had a row. The
// analyzer sent all of them, 4 filed, and HMIS marked the sample "result
// interfaced" over a blank report.
//
// The observation that makes recovery safe: a parameterId is a property of the
// SERVICE, not of the sample. Across all 9,338 pending polls logged on
// 2026-09-08 every (labServiceId, identifier) pair mapped to exactly one
// parameterId — 164 pairs, zero conflicts. Service 3141 spells WBC 2123 and HGB
// 2130 on every sample it appears on. What varies per sample is the
// labResultId, and that is carried by every OTHER row of the same service on
// the same sample: the 16 rows CH2609080028 did keep all named labResultId
// 92910365.
//
// So a missing row can be rebuilt exactly — parameterId from this catalogue,
// labResultId (and labServiceId, equipmentId, ipAddress, portNo) borrowed from
// a sibling row of the same service on the same sample. Nothing is guessed and
// nothing is invented; both halves were observed, just not in the same reply.
//
// WHY IT IS RESTRICTED TO PARAMETER SERVICES. In a Numeric or Alphanumeric
// service the row IS the whole service: one labServiceId, one parameterId, one
// labResultId (1,875 Numeric groups on 2026-09-08, every one with exactly one
// parameter). A missing analyte there means the whole service is missing, so
// there is no sibling row to borrow a labResultId from — and borrowing one from
// a DIFFERENT service would file the value against the wrong test on a
// patient's report. The guards below make that impossible rather than unlikely.
// =============================================================================

/** HMIS's shape for a service where one labResultId covers many parameters. */
const PARAMETER_RESULT_TYPE = 'PARAMETER';

/** A service the catalogue has seen fewer parameters than this for is not a
 *  panel, whatever its resultType claims — and a panel of one is exactly the
 *  shape whose labResultId must never be lent to another analyte. */
const MIN_PANEL_PARAMETERS = 2;

interface CatalogueParameter {
  parameterId: number;
  /** The identifier as HMIS spells it — what the far end keys the report on. */
  identifier: string;
}

interface ServiceEntry {
  /** resultType as HMIS spelled it, e.g. "PARAMETER". */
  resultType: string | null;
  /** Upper-cased identifier → the parameter HMIS registers under it. */
  parameters: Record<string, CatalogueParameter>;
  updatedAt: string;
}

interface CatalogueFile {
  /** labServiceId (as a string key) → what is known about that service. */
  services: Record<string, ServiceEntry>;
  updatedAt: string;
}

export interface SynthesisResult {
  /** Rows rebuilt for this sample, ready to be joined and acknowledged. */
  rows: MirthAcknowledgeItem[];
  /** Codes asked for that the catalogue has never seen — still unfilable. */
  unknown: string[];
}

const codeKey = (identifier: string): string => (identifier ?? '').trim().toUpperCase();

export class ParameterCatalogue {
  private cache: CatalogueFile | null = null;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Where the catalogue lives for one analyzer's spool directory. */
  static fileFor(spoolDir: string): string {
    return join(spoolDir, 'parameters.json');
  }

  /**
   * Record what these pending rows say about their services.
   *
   * Called on every poll, so it sees the complete panel whenever HMIS happens
   * to offer it — which is what later lets a collapsed reply be repaired. A
   * parameter is only ever ADDED or corrected, never removed: HMIS withdrawing
   * a row is the exact situation this exists for, so a shrinking pending list
   * must not shrink the catalogue with it.
   */
  learn(rows: MirthAcknowledgeItem[]): number {
    if (rows.length === 0) return 0;
    const cat = this.read();
    const now = new Date().toISOString();
    let learned = 0;

    for (const row of rows) {
      if (row.synthesized) continue; // never learn from our own reconstruction
      const svc = row.labServiceId;
      const pid = row.parameterId;
      const key = codeKey(row.identifier);
      if (svc === null || pid === null || !key) continue;

      const svcKey = String(svc);
      let entry = cat.services[svcKey];
      if (!entry) {
        entry = { resultType: null, parameters: {}, updatedAt: now };
        cat.services[svcKey] = entry;
      }
      if (row.resultType) entry.resultType = row.resultType;

      const have = entry.parameters[key];
      if (have && have.parameterId === pid && have.identifier === row.identifier) continue;
      if (have && have.parameterId !== pid) {
        // Never seen live — 164 pairs, no conflicts — but if HMIS ever re-keys
        // a parameter, the newest reply is authoritative and the change is
        // worth seeing in the log, because it moves where a value lands.
        this.logger.warn(
          { labServiceId: svc, identifier: row.identifier, was: have.parameterId, now: pid },
          'HMIS re-keyed a parameter — the catalogue now points at the new parameterId',
        );
      }
      entry.parameters[key] = { parameterId: pid, identifier: row.identifier };
      entry.updatedAt = now;
      learned++;
    }

    if (learned > 0) {
      cat.updatedAt = now;
      this.write(cat);
    }
    return learned;
  }

  /**
   * Rebuild the order rows HMIS is not offering for a sample.
   *
   * `known` is every row the connector holds for this barcode; `wanted` is the
   * assay codes a result is still waiting on. `canonical` reduces an identifier
   * to the key both sides agree on, exactly as the join does, so an analyzer
   * whose codec reports "032" against an HMIS `eqIdntifier` of "1.000000+032+1"
   * still matches.
   */
  synthesize(
    known: MirthAcknowledgeItem[],
    wanted: string[],
    canonical: (identifier: string) => string = (id) => id,
  ): SynthesisResult {
    const out: SynthesisResult = { rows: [], unknown: [] };
    if (wanted.length === 0) return out;
    if (known.length === 0) {
      // No sibling row means no labResultId for this sample, and a labResultId
      // is not something the catalogue may supply — it is per-sample.
      out.unknown = [...wanted];
      return out;
    }
    const cat = this.read();
    const key = (id: string) => codeKey(canonical((id ?? '').trim()));

    // One template per service: the row whose labResultId and addressing every
    // rebuilt sibling inherits. Only PARAMETER panels qualify — see the note at
    // the top of this file.
    const templates = new Map<string, MirthAcknowledgeItem>();
    const haveCodes = new Set<string>();
    const haveParameterIds = new Set<number>();
    for (const row of known) {
      haveCodes.add(key(row.identifier));
      if (row.parameterId !== null) haveParameterIds.add(row.parameterId);
      if (row.labServiceId === null || row.labResultId === null) continue;
      const svcKey = String(row.labServiceId);
      const entry = cat.services[svcKey];
      // The stored resultType is preferred: it is what HMIS said about the
      // service across every reply, not only about this one row.
      const resultType = entry?.resultType ?? row.resultType ?? null;
      if (!resultType || resultType.toUpperCase() !== PARAMETER_RESULT_TYPE) continue;
      if (!entry || Object.keys(entry.parameters).length < MIN_PANEL_PARAMETERS) continue;
      if (!templates.has(svcKey)) templates.set(svcKey, row);
    }
    if (templates.size === 0) {
      out.unknown = [...wanted];
      return out;
    }

    for (const code of wanted) {
      const k = key(code);
      if (!k || haveCodes.has(k)) continue;
      let built = false;
      for (const [svcKey, template] of templates) {
        const param = cat.services[svcKey]?.parameters[k];
        if (!param) continue;
        // Two services on one sample must never file against the same parameter
        // twice, and a parameter already covered by a real row is never rebuilt.
        if (haveParameterIds.has(param.parameterId)) continue;
        haveParameterIds.add(param.parameterId);
        haveCodes.add(k);
        out.rows.push({
          sampleID: template.sampleID,
          equipmentId: template.equipmentId,
          // HMIS's own spelling, not the analyzer's.
          identifier: param.identifier,
          ipAddress: template.ipAddress,
          isTransmitted: true,
          labResultId: template.labResultId,
          labServiceId: template.labServiceId,
          portNo: template.portNo,
          parameterId: param.parameterId,
          resultType: cat.services[svcKey]?.resultType ?? template.resultType ?? null,
          synthesized: true,
        });
        built = true;
        break;
      }
      if (!built) out.unknown.push(code);
    }
    return out;
  }

  /** How many services and parameters are held — for the console/status page. */
  counts(): { services: number; parameters: number } {
    const cat = this.read();
    let parameters = 0;
    for (const entry of Object.values(cat.services)) parameters += Object.keys(entry.parameters).length;
    return { services: Object.keys(cat.services).length, parameters };
  }

  // ---------------------------------------------------------------------------
  private read(): CatalogueFile {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as CatalogueFile;
      if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
        this.cache = parsed;
        return parsed;
      }
    } catch {
      /* absent or unreadable — start empty; the next poll refills it */
    }
    this.cache = { services: {}, updatedAt: new Date().toISOString() };
    return this.cache;
  }

  private write(cat: CatalogueFile): void {
    this.cache = cat;
    const tmp = this.file + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(cat, null, 2));
      renameSync(tmp, this.file); // atomic on the same volume
    } catch (err) {
      // The catalogue is a cache. Failing to persist it must never stop a
      // result being filed; it stays correct in memory for this run.
      this.logger.warn(
        { file: this.file, err: err instanceof Error ? err.message : String(err) },
        'could not persist the parameter catalogue — it stays in memory for this run',
      );
    }
  }
}
