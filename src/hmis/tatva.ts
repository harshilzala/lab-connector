import type { Logger } from '../logger.js';
import type { HmisResultUploadResponse, LisInboundResultRow, MirthAcknowledgeItem } from '../types.js';
import type { HmisAudit } from './audit.js';
import type { HmisGateway, PendingQuery } from './client.js';
import { GenxHmisClient, type GenxClientOptions } from './genx.js';
import type { ClientTls } from './http.js';
import type { TatvaEquipmentOptions } from './tatva-equipment.js';

// =============================================================================
// Tatva v1 — ZyHos HMIS "Lab Middleware API" (contract v3.1,
// ZyHos-Preprod-Lab-Middleware.postman_collection.json, 2026-11).
//
// A LANE OF ITS OWN (2026-11-17): "tatva" sits beside "hinai" and "genx"
// (src/hmis/lanes.ts) and is picked like them — hmis "use": "tatva" (single)
// or "tatva" in hmis "both" (with HINAI or GenX). Nothing uses it by default.
//
// Where the lane's ORDERS come from is `hmis.tatva.orders`:
//   "hinai" (default) — the new system and HINAI share one synced database,
//            so the lane reads HINAI's pending rows (ResultRoutedGateway) and
//            posts its results to Tatva v1. In both mode with HINAI the HINAI
//            lane files to /mirth as before and the Tatva lane files the same
//            tubes to Tatva v1.
//   "tatva"  — the lane reads Tatva's own worklist (auth "oauth" only),
//            mapped like GenX (serviceTests / equipmentServices).
//
// TWO WAYS TO AUTHENTICATE (`hmis.tatva.auth`). The contract forbids mixing
// them on one instrument.
//
//   "oauth"      Partner API (Postman folder 2). One client_id/secret for the
//                connector → Bearer token (~600 s, cached).
//                  POST {tokenPath}
//                  GET  {apiPrefix}/lab/equipment/worklist?barcode=  (accession lookup)
//                  POST {apiPrefix}/lab/equipment/results
//                  POST {apiPrefix}/lab/equipment/acknowledge
//                Same wire as GenX, so it is a PRESET of GenxHmisClient
//                (src/hmis/genx.ts) — `outOfRange` counted as not filed, and
//                `unit` / `flag` sent with each value.
//
//   "equipment"  Mirth-compatibility API (Postman folder 3). Each MACHINE has
//                its own X-Equipment-ID / X-Equipment-Secret, from
//                analyzers[].tatva — one client per machine.
//                  POST {equipmentResultsPath}       (/diagnostic-service/mirth/labresult)
//                  POST {equipmentAcknowledgePath}   (/diagnostic-service/mirth/acknowledge)
//                See src/hmis/tatva-equipment.ts.
//
// Both: optional X-Facility-ID / X-Organization-ID headers, optional client
// certificate (mTLS — "HIGH security, may require mTLS").
// =============================================================================

export const TATVA_LABEL = 'Tatva v1';

/** hmis.tatva as the client builders read it. */
export interface TatvaSettings {
  baseUrl: string;
  apiPrefix: string;
  tokenPath: string;
  revokePath: string;
  worklistPath: string;
  acknowledgePath: string;
  resultsPath: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  clientAuth: 'basic' | 'body';
  apiKey: string;
  apiKeyHeader: string;
  barcodeField: 'sampleNumber' | 'accessionNumber';
  accessionCacheFile: string | null;
  equipmentResultsPath?: string;
  equipmentAcknowledgePath?: string;
  facilityId?: string;
  organizationId?: string;
  sendUnitAndFlag?: boolean;
  tls?: { certFile: string; keyFile: string; caFile: string; passphrase: string } | null;
  /** Where the Tatva lane's orders come from (see hmis.tatva.orders). */
  orders?: 'hinai' | 'tatva';
  /** orders "tatva": the GenX-style order mapping. */
  serviceTests?: Record<string, string[]>;
  equipmentServices?: Record<string, string[]>;
  pendingLineStatuses?: string[];
  batchDays?: number;
  batchPageSize?: number;
}

interface Common {
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  logger: Logger;
  audit?: HmisAudit;
}

/** `{apiPrefix}/lab/equipment/<name>` unless the path is set outright. */
export function tatvaPath(s: Pick<TatvaSettings, 'apiPrefix'>, explicit: string, name: string): string {
  if (explicit) return explicit;
  return `${s.apiPrefix.replace(/\/$/, '')}/lab/equipment/${name}`;
}

/** The optional partner headers, set only when configured. */
function tatvaHeaders(s: TatvaSettings): Record<string, string> {
  return {
    ...(s.facilityId ? { 'x-facility-id': s.facilityId } : {}),
    ...(s.organizationId ? { 'x-organization-id': s.organizationId } : {}),
  };
}

/** The client certificate, or null when no cert + key are configured. */
export function tatvaTls(s: TatvaSettings): ClientTls | null {
  const t = s.tls;
  if (!t || !t.certFile || !t.keyFile) return null;
  return { certFile: t.certFile, keyFile: t.keyFile, caFile: t.caFile || undefined, passphrase: t.passphrase || undefined };
}

/** auth "oauth": the GenX-library options for the Tatva v1 preset. */
export function tatvaClientOptions(s: TatvaSettings, common: Common): GenxClientOptions {
  return {
    label: TATVA_LABEL,
    configBlock: 'hmis.tatva',
    outOfRangeUnfiled: true,
    sendUnitAndFlag: s.sendUnitAndFlag !== false,
    baseUrl: s.baseUrl,
    tokenPath: s.tokenPath,
    revokePath: s.revokePath,
    worklistPath: tatvaPath(s, s.worklistPath, 'worklist'),
    acknowledgePath: tatvaPath(s, s.acknowledgePath, 'acknowledge'),
    resultsPath: tatvaPath(s, s.resultsPath, 'results'),
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    scope: s.scope,
    clientAuth: s.clientAuth,
    apiKey: s.apiKey || undefined,
    apiKeyHeader: s.apiKeyHeader,
    barcodeField: s.barcodeField,
    // Orders from HINAI: the worklist is read only to turn a tube barcode
    // into its accessionNumber, so no service expansion is configured.
    // Orders from Tatva: the worklist IS the order source, mapped like GenX.
    ...(s.orders === 'tatva'
      ? {
          serviceTests: s.serviceTests ?? {},
          equipmentServices: s.equipmentServices ?? {},
          pendingLineStatuses: s.pendingLineStatuses ?? ['PENDING'],
          batchDays: s.batchDays ?? 1,
          batchPageSize: s.batchPageSize ?? 100,
        }
      : { serviceTests: {}, equipmentServices: {}, pendingLineStatuses: ['PENDING'], batchDays: 0, batchPageSize: 100 }),
    accessionCacheFile: s.accessionCacheFile ?? undefined,
    extraHeaders: tatvaHeaders(s),
    tls: tatvaTls(s),
    ...common,
  };
}

/** auth "equipment": the options for one machine's client. */
export function tatvaEquipmentOptions(
  s: TatvaSettings,
  machine: { equipmentId: string; equipmentSecret: string },
  common: Omit<Common, 'tlsRejectUnauthorized'>,
): TatvaEquipmentOptions {
  return {
    baseUrl: s.baseUrl,
    resultsPath: s.equipmentResultsPath || '/diagnostic-service/mirth/labresult',
    acknowledgePath: s.equipmentAcknowledgePath || '/diagnostic-service/mirth/acknowledge',
    equipmentId: machine.equipmentId,
    equipmentSecret: machine.equipmentSecret,
    extraHeaders: tatvaHeaders(s),
    tls: tatvaTls(s),
    ...common,
  };
}

/** Where the acknowledge goes while results are routed to Tatva v1. */
export type TatvaAckTarget = 'orders' | 'tatva' | 'off';

/**
 * A gateway whose orders come from one system and whose results go to
 * another. Used for the HINAI lane while Tatva v1 is enabled: getPending (and,
 * by default, acknowledge) are HINAI's; postResults is Tatva v1's. The lane is
 * still "hinai" to the rest of the connector — the order store, the staged
 * filer's joins, the both-mode hold rule — because the order rows still are.
 */
/** What the routed gateway needs from the results side: the OAuth partner
 *  client (GenxHmisClient preset) or the per-machine TatvaEquipmentClient. */
export type ResultSink = Pick<HmisGateway, 'postResults' | 'acknowledge'>;

export class ResultRoutedGateway implements HmisGateway {
  readonly resultsLabel = TATVA_LABEL;

  constructor(
    private readonly orders: HmisGateway,
    private readonly results: ResultSink,
    private readonly ackTarget: TatvaAckTarget = 'orders',
  ) {}

  get siteId(): string | null {
    return this.orders.siteId;
  }
  get defaultSiteIds(): (string | undefined)[] {
    return this.orders.defaultSiteIds;
  }
  get ignoresPollFilters(): boolean | undefined {
    return this.orders.ignoresPollFilters;
  }
  get rowStyle(): 'genx' | 'hinai' | undefined {
    return this.orders.rowStyle;
  }

  getPending(q: PendingQuery): Promise<unknown> {
    return this.orders.getPending(q);
  }

  async acknowledge(items: MirthAcknowledgeItem[], eqCode?: string): Promise<void> {
    if (this.ackTarget === 'off') return;
    const target = this.ackTarget === 'tatva' ? this.results : this.orders;
    return target.acknowledge(items, eqCode);
  }

  postResults(rows: LisInboundResultRow[], eqCode?: string): Promise<HmisResultUploadResponse> {
    return this.results.postResults(rows, eqCode);
  }
}

export function makeTatvaClient(opts: GenxClientOptions): GenxHmisClient {
  return new GenxHmisClient(opts);
}
