import type { AutoCertifyConfig } from '../config.js';

// =============================================================================
// Where Auto Certify finds its work: the HIS Oracle database.
//
// The SQL is the old Auto_Certify.exe query, moved over clause for clause, with
// two changes:
//   - every value is a bind variable. The old service pasted config values
//     straight into the SQL text.
//   - the accepted_date window compares the DATE column directly
//     (>= TRUNC(SYSDATE) - n, < TRUNC(SYSDATE) + 1) rather than through
//     to_char(). It selects the same calendar days, and an index on
//     accepted_date can still be used.
//
// A result with parameters (ithasparameter = 'Y') is handled as the old
// service did (AutoCertify.cs, read from its IL):
//   1. blockingParameters: this equipment's parameter rows that are STILL in a
//      parameterResultStatus (1108 on site). Any row here means the analyzer
//      has not finished the result, so it waits for a later run.
//   2. none left: allParameters, meaning EVERY parameter row of the result,
//      with no equipment or status filter, and each one is certified.
// So parameterResultStatus is the status that holds a result back. It does
// not mark a parameter as ready.
// =============================================================================

/** One lab result that is ready to certify. */
export interface CertifyCandidate {
  labResultId: string;
  resultStatus: string;
  interfacedValue: string | null;
  acceptedDate: string | null;
  equipmentId: string;
  /** ithasparameter = 'Y': certified per parameter rather than as a whole. */
  hasParameter: boolean;
  labOrderId: string;
  sampleId: string;
  /** LM.lab_service_id: the lab service (test) the result belongs to. */
  labServiceId: string;
  /** LM.autocertifylab: the service's auto-certify flag in HIS. Selected as
   *  the newest Auto_Certify source does, for display and the log. That source
   *  never filters on it, so neither does this port. */
  autoCertifyLab: string | null;
}

export interface CertifySource {
  /** Results in the window that are ready to certify, oldest accepted first. */
  pendingResults(): Promise<CertifyCandidate[]>;
  /** This equipment's parameter rows of the result still in a parameterResultStatus.
   *  Non-empty means the result is not finished and must wait. */
  blockingParameters(labResultId: string): Promise<string[]>;
  /** Every parameter row of the result: what gets certified once nothing blocks. */
  allParameters(labResultId: string): Promise<string[]>;
  close(): Promise<void>;
}

/** Positional bind names for an IN list: (:p0, :p1, …). */
function inList(prefix: string, values: string[], binds: Record<string, string | number>): string {
  return values
    .map((v, i) => {
      binds[`${prefix}${i}`] = v;
      return `:${prefix}${i}`;
    })
    .join(', ');
}

export function buildResultsQuery(cfg: AutoCertifyConfig): { sql: string; binds: Record<string, string | number> } {
  const binds: Record<string, string | number> = { siteId: cfg.siteId ?? '', lookback: cfg.lookbackDays };
  const sql = `
    select distinct LR.lab_result_id,
           LR.result_status,
           LR.interfaced_value,
           LR.accepted_date,
           ES.equipmentid,
           LR.ithasparameter,
           LO.lab_order_id,
           LO.sample_id,
           LM.lab_service_id,
           LM.autocertifylab
      from labresult LR
     inner join laborder LO on LO.lab_order_id = LR.lab_order_id
     inner join labservicemaster LM on LM.lab_service_id = LR.lab_service_master_id
     inner join equipmentservice ES on ES.labserviceid = LM.lab_service_id
     inner join servicecenter SC on SC.service_center_id = LR.service_center_id
     inner join hisdepartment HD on HD.department_id = SC.department_id
      left join labresultparameter LRP on LRP.lab_result_id = LR.lab_result_id
                                      and LRP.parameter_id = ES.parameterid
     where LR.siteid = :siteId
       and ES.equipmentid in (${inList('eq', cfg.equipmentIds, binds)})
       and LR.result_status in (${inList('rs', cfg.resultStatus, binds)})
       and (LRP.isinterfaced = 1 or LR.isinterfaced = 1)
       ${cfg.requireHod ? 'and HD.hod_id is not null' : ''}
       and LR.accepted_date >= trunc(sysdate) - :lookback
       and LR.accepted_date < trunc(sysdate) + 1
     order by LR.accepted_date asc`;
  return { sql, binds };
}

export function buildBlockingParametersQuery(
  cfg: AutoCertifyConfig,
  labResultId: string,
): { sql: string; binds: Record<string, string | number> } {
  const binds: Record<string, string | number> = { resultId: labResultId };
  const sql = `
    select distinct LRP.lab_result_parameter_id
      from labresultparameter LRP
     inner join equipmentservice ES on ES.parameterid = LRP.parameter_id
     where LRP.lab_result_id = :resultId
       and ES.equipmentid in (${inList('eq', cfg.equipmentIds, binds)})
       and LRP.parameterresultstatus in (${inList('ps', cfg.parameterResultStatus, binds)})`;
  return { sql, binds };
}

export function buildAllParametersQuery(labResultId: string): { sql: string; binds: Record<string, string | number> } {
  return {
    sql: 'select LRP.lab_result_parameter_id from labresultparameter LRP where LRP.lab_result_id = :resultId',
    binds: { resultId: labResultId },
  };
}

/** The old service compared ithasparameter to "Y" exactly. Anything else, 'y'
 *  and '1' included, was certified as a whole result. Kept identical so the
 *  port never picks a different path for the same row. */
export function isYes(v: unknown): boolean {
  return String(v ?? '').trim() === 'Y';
}

// The oracledb module is loaded on first use. It is an optional dependency, so a
// site that does not run Auto Certify never needs it installed.
type OracleDb = typeof import('oracledb');
let oracledbModule: OracleDb | null = null;

async function loadOracle(): Promise<OracleDb> {
  if (oracledbModule) return oracledbModule;
  try {
    const mod = (await import('oracledb')) as unknown as { default?: OracleDb } & OracleDb;
    oracledbModule = mod.default ?? mod;
  } catch {
    throw new Error('Auto Certify needs the "oracledb" package, which is not installed. Run: npm install oracledb');
  }
  return oracledbModule;
}

/**
 * Oracle-backed source. Opens one connection per run and closes it at the end
 * of the run. At one run a minute, a pool would only hold an idle session open
 * on the HIS database between runs.
 *
 * Uses node-oracledb's Thin mode, so this PC needs no Oracle Instant Client.
 * Thin mode needs Oracle Database 12.1 or later.
 */
export class OracleCertifySource implements CertifySource {
  private conn: import('oracledb').Connection | null = null;

  constructor(private readonly cfg: AutoCertifyConfig) {}

  private async connection(): Promise<import('oracledb').Connection> {
    if (this.conn) return this.conn;
    const oracledb = await loadOracle();
    this.conn = await oracledb.getConnection({
      user: this.cfg.oracle.user,
      password: this.cfg.oracle.password,
      connectString: this.cfg.oracle.connectString,
    });
    return this.conn;
  }

  private async rows(sql: string, binds: Record<string, string | number>): Promise<Record<string, unknown>[]> {
    const oracledb = await loadOracle();
    const conn = await this.connection();
    const res = await conn.execute<Record<string, unknown>>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      // Ids come back as strings: a NUMBER id must never be rounded by a JS double.
      fetchInfo: {
        LAB_RESULT_ID: { type: oracledb.STRING },
        RESULT_STATUS: { type: oracledb.STRING },
        EQUIPMENTID: { type: oracledb.STRING },
        LAB_ORDER_ID: { type: oracledb.STRING },
        LAB_RESULT_PARAMETER_ID: { type: oracledb.STRING },
        ITHASPARAMETER: { type: oracledb.STRING },
        INTERFACED_VALUE: { type: oracledb.STRING },
        LAB_SERVICE_ID: { type: oracledb.STRING },
        AUTOCERTIFYLAB: { type: oracledb.STRING },
      },
    });
    return res.rows ?? [];
  }

  async pendingResults(): Promise<CertifyCandidate[]> {
    const { sql, binds } = buildResultsQuery(this.cfg);
    const rows = await this.rows(sql, binds);
    const seen = new Set<string>();
    const out: CertifyCandidate[] = [];
    // DISTINCT still returns a result once for each equipment id that maps its
    // service. Certify it only once.
    for (const r of rows) {
      const id = String(r.LAB_RESULT_ID ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const accepted = r.ACCEPTED_DATE;
      out.push({
        labResultId: id,
        resultStatus: String(r.RESULT_STATUS ?? ''),
        interfacedValue: r.INTERFACED_VALUE == null ? null : String(r.INTERFACED_VALUE),
        acceptedDate: accepted instanceof Date ? accepted.toISOString() : accepted == null ? null : String(accepted),
        equipmentId: String(r.EQUIPMENTID ?? ''),
        hasParameter: isYes(r.ITHASPARAMETER),
        labOrderId: String(r.LAB_ORDER_ID ?? ''),
        sampleId: String(r.SAMPLE_ID ?? ''),
        labServiceId: String(r.LAB_SERVICE_ID ?? ''),
        autoCertifyLab: r.AUTOCERTIFYLAB == null ? null : String(r.AUTOCERTIFYLAB),
      });
    }
    return out;
  }

  async blockingParameters(labResultId: string): Promise<string[]> {
    const { sql, binds } = buildBlockingParametersQuery(this.cfg, labResultId);
    return this.ids(sql, binds);
  }

  async allParameters(labResultId: string): Promise<string[]> {
    const { sql, binds } = buildAllParametersQuery(labResultId);
    return this.ids(sql, binds);
  }

  private async ids(sql: string, binds: Record<string, string | number>): Promise<string[]> {
    const rows = await this.rows(sql, binds);
    return rows.map((r) => String(r.LAB_RESULT_PARAMETER_ID ?? '')).filter(Boolean);
  }

  async close(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    if (c) await c.close().catch(() => {});
  }
}
