import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { AnalyzerConfig } from '../config.js';
import type { HmisClient } from '../hmis/client.js';
import type { HmisResultUpload, OrderDownload, ParsedMessage } from '../types.js';
import type { ProtocolLink, WireEvent } from '../codec/types.js';
import { createTransport } from '../transport/index.js';
import type { Transport } from '../transport/types.js';
import { createProtocolLink } from '../codec/index.js';
import { SpoolQueue } from '../queue/spool.js';
import { normalizeBarcode, toResultUploads } from '../mapping/mapper.js';
import { formatApiDate, normalizePending } from '../hmis/pending.js';

export interface WireLogEntry {
  at: string;
  direction: 'IN' | 'OUT';
  text: string;
}

export interface AnalyzerStatus {
  id: string;
  equipmentCode: string;
  protocol: string;
  endpoint: string;
  connected: boolean;
  lastMessageAt: string | null;
  spool: { pending: number; failed: number };
}

// =============================================================================
// AnalyzerRuntime — everything for ONE analyzer: the byte transport, the
// protocol link, host-query order-download, and durable result upload.
//
//   inbound query   → GET  {pendingPath} → sendOrders() back to the analyzer
//                                        → POST {acknowledgePath}
//   inbound results → spool.enqueue      → worker POSTs {resultsPath}
//                                          (durable store-and-forward)
// =============================================================================
export class AnalyzerRuntime {
  private readonly link: ProtocolLink;
  private readonly transport: Transport;
  private readonly spool: SpoolQueue<HmisResultUpload>;
  private readonly log: Logger;
  private readonly wireLog: WireLogEntry[] = [];
  private lastMessageAt: string | null = null;

  constructor(
    private readonly cfg: AnalyzerConfig,
    private readonly hmis: HmisClient,
    spoolRoot: string,
    logger: Logger,
  ) {
    this.log = logger.child({ analyzer: cfg.id });
    this.transport = createTransport(cfg.transport, this.log);
    this.link = createProtocolLink(cfg, this.transport, this.log);
    this.spool = new SpoolQueue<HmisResultUpload>(join(spoolRoot, cfg.id), this.log);

    this.link.on('message', (m: ParsedMessage) => void this.onMessage(m));
    this.link.on('wire', (w: WireEvent) => this.recordWire(w));
    this.link.on('error', (e: Error) => this.log.error({ err: e.message }, 'protocol link error'));
  }

  async start(): Promise<void> {
    // Deliver spooled results to HMIS; a throw here keeps the item queued.
    this.spool.start(async (payload) => {
      const res = await this.hmis.postResults(payload);
      if (res.unmatched?.length) {
        this.log.warn({ barcode: payload.barcode, unmatched: res.unmatched }, 'some test codes had no HMIS mapping');
      }
      this.log.info({ barcode: payload.barcode, filed: res.filed, status: res.sampleStatus }, 'results filed to HMIS');
    });
    await this.link.start();
    this.log.info({ endpoint: this.cfg.transport.type }, 'analyzer runtime started');
  }

  async stop(): Promise<void> {
    this.spool.stop();
    await this.link.stop();
  }

  status(): AnalyzerStatus {
    return {
      id: this.cfg.id,
      equipmentCode: this.cfg.equipmentCode,
      protocol: this.cfg.protocol,
      endpoint: describeTransport(this.cfg),
      connected: this.transport.connected,
      lastMessageAt: this.lastMessageAt,
      spool: this.spool.counts(),
    };
  }

  recentWire(limit = 50): WireLogEntry[] {
    return this.wireLog.slice(-limit);
  }

  spoolPending(limit = 100) {
    return this.spool.listPending(limit);
  }

  spoolFailed(limit = 100) {
    return this.spool.listFailed(limit);
  }

  retryFailed(id: string): boolean {
    return this.spool.requeueFailed(id);
  }

  // ---------------------------------------------------------------------------
  private async onMessage(msg: ParsedMessage): Promise<void> {
    this.lastMessageAt = new Date().toISOString();

    // 1) Host-query → answer with the ordered tests.
    if (msg.queries.length > 0) {
      if (!this.cfg.hostQuery) {
        this.log.warn('received host query but hostQuery is disabled — ignoring');
      } else {
        for (const q of msg.queries) await this.answerQuery(q.sampleId);
      }
    }

    // 2) Results → durable upload.
    if (msg.results.length > 0) {
      const uploads = toResultUploads(this.cfg, msg);
      for (const u of uploads) {
        this.spool.enqueue(u, u.messageId); // messageId is deterministic → idempotent
        this.log.info({ barcode: u.barcode, count: u.results.length, qc: u.isQc }, 'results queued for upload');
      }
    }
  }

  private async answerQuery(barcode: string): Promise<void> {
    // HMIS matches barcodes case-sensitively; look up with the canonical
    // uppercase form so a lowercase-entered sample still resolves its order.
    const lookup = normalizeBarcode(barcode);
    try {
      const body = await this.hmis.getPending({
        sampleId: lookup,
        eqCode: this.cfg.equipmentCode,
        siteId: this.cfg.siteId,
        showCulture: this.cfg.showCulture,
        // Off by default: an order raised yesterday for a tube run today would
        // otherwise not be found.
        date: this.cfg.sendDate ? formatApiDate(new Date()) : undefined,
      });

      // One row per pending test — collapse the rows for this barcode into a
      // single order, keeping each row so it can be acknowledged afterwards.
      const pending = normalizePending(body, {
        sampleId: lookup,
        eqCode: this.cfg.equipmentCode,
        equipmentId: this.cfg.equipmentId ?? null,
        ipAddress: this.ackIpAddress,
        portNo: this.ackPortNo,
      });

      if (!pending.found) {
        this.log.info({ barcode, lookup }, 'no pending orders — sending empty download');
        await this.link.sendOrders([]); // header + terminator = "no work"
        return;
      }

      const order: OrderDownload = {
        // Reply with the barcode the analyzer sent so it matches its own sample.
        sampleId: barcode,
        testCodes: pending.testCodes,
        priority: pending.priority,
        patient: this.cfg.sendDemographics ? pending.patient : null,
        specimenType: pending.specimenType,
      };
      await this.link.sendOrders([order]);
      this.log.info({ barcode, tests: pending.testCodes }, 'order download sent to analyzer');

      // Acknowledge only now that the analyzer has the work. A failed download
      // must leave the rows pending so the next host query offers them again.
      try {
        await this.hmis.acknowledge(pending.ackItems);
        this.log.info({ barcode, rows: pending.ackItems.length }, 'pending rows acknowledged');
      } catch (err) {
        // The analyzer already holds the order, so this is not fatal — the rows
        // are simply offered again. Loud, because a persistent failure here is
        // what produces duplicate downloads.
        this.log.error(
          { barcode, rows: pending.ackItems.length, err: err instanceof Error ? err.message : String(err) },
          'acknowledge failed — rows stay pending and may be downloaded again',
        );
      }
    } catch (err) {
      this.log.error({ barcode, err: err instanceof Error ? err.message : String(err) }, 'host-query failed');
    }
  }

  /** Reported in the acknowledge body; derived from a TCP transport when the
   *  analyzer config does not set it explicitly. */
  private get ackIpAddress(): string {
    if (this.cfg.ipAddress) return this.cfg.ipAddress;
    return this.cfg.transport.type === 'tcp' ? this.cfg.transport.host : '';
  }

  private get ackPortNo(): string {
    if (this.cfg.portNo) return this.cfg.portNo;
    return this.cfg.transport.type === 'tcp' ? String(this.cfg.transport.port) : '';
  }

  private recordWire(w: WireEvent): void {
    this.wireLog.push({ at: new Date().toISOString(), direction: w.direction, text: w.text });
    if (this.wireLog.length > 200) this.wireLog.shift();
  }
}

function describeTransport(cfg: AnalyzerConfig): string {
  const t = cfg.transport;
  return t.type === 'tcp' ? `tcp://${t.host}:${t.port} (${t.mode})` : `serial://${t.path}@${t.baudRate}`;
}
