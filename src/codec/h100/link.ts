import { EventEmitter } from 'node:events';
import type { Transport } from '../../transport/types.js';
import type { Logger } from '../../logger.js';
import type { OrderDownload, ParsedMessage } from '../../types.js';
import type { ProtocolLink } from '../types.js';
import { ETX, STX, parseH100Sample } from './parser.js';

export interface H100LinkOptions {
  logger: Logger;
  /** File a block whose test error code is E1/E2 (sampling too little / too
   *  much). Off: the values from a mis-sampled run are not results, the block
   *  is logged and dropped, and the rerun files. */
  fileOnSamplingError?: boolean;
  /** Refuse to buffer more than this without an ETX (runaway peer). */
  maxBufferBytes?: number;
}

// =============================================================================
// H100Link — Lifotronic H100 HbA1c analyzer, results-only.
//
// Lifotronic Appendix B interface: the PC is the TCP SERVER and the
// analyzer dials in (B.1 "TCP Communication Mode on PC: TCP Server"), then
// sends one STX…ETX block per test (B.3). No acknowledgement, handshake or
// query is defined, so this link is receive-only: it frames on STX/ETX, parses
// the 'S' sample block, and emits one 'message' per block. Anything outside a
// frame is discarded; a block that is not 'S' ('Q', 'C' — QC/calibration by
// the character table in B.2, format undocumented) is logged and dropped.
//
// A QC-material or calibrator run is marked by the blood-type byte (0x32 /
// 0x33), so the message carries isQc from the protocol itself.
//
// sendOrders is a no-op: the interface is results-only (keep hostQuery:false).
// =============================================================================
export class H100Link extends EventEmitter implements ProtocolLink {
  readonly name = 'h100' as const;

  private rx = Buffer.alloc(0);
  private readonly maxBuffer: number;
  private readonly onDataBound = (c: Buffer) => this.onData(c);
  private readonly onCloseBound = () => {
    this.rx = Buffer.alloc(0);
  };

  constructor(private readonly transport: Transport, private readonly opts: H100LinkOptions) {
    super();
    this.maxBuffer = opts.maxBufferBytes ?? 1024 * 1024;
  }

  async start(): Promise<void> {
    this.transport.on('data', this.onDataBound);
    this.transport.on('close', this.onCloseBound);
    this.transport.on('error', (e: Error) => this.emit('error', e));
    await this.transport.start();
  }

  async stop(): Promise<void> {
    this.transport.off('data', this.onDataBound);
    this.transport.off('close', this.onCloseBound);
    await this.transport.stop();
  }

  async sendOrders(orders: OrderDownload[]): Promise<void> {
    if (orders.length > 0) {
      this.opts.logger.warn({ count: orders.length }, 'H100 order-download not supported (results-only interface) — ignoring');
    }
  }

  // ---- inbound --------------------------------------------------------------
  private onData(chunk: Buffer): void {
    this.emit('wire', { direction: 'IN', text: printable(chunk) });
    this.rx = Buffer.concat([this.rx, chunk]);

    for (;;) {
      const start = this.rx.indexOf(STX);
      if (start === -1) {
        this.rx = Buffer.alloc(0); // noise with no frame start — drop it
        return;
      }
      if (start > 0) this.rx = this.rx.subarray(start);
      const end = this.rx.indexOf(ETX);
      if (end === -1) break; // frame still arriving
      const block = this.rx.subarray(1, end).toString('latin1');
      this.rx = this.rx.subarray(end + 1);
      this.handleBlock(block);
    }

    if (this.rx.length > this.maxBuffer) {
      this.rx = Buffer.alloc(0);
      this.emit('error', new Error(`H100: no ETX within ${this.maxBuffer} bytes — buffer reset`));
    }
  }

  private handleBlock(block: string): void {
    const specifier = block[0] ?? '';
    if (specifier !== 'S') {
      this.opts.logger.info(
        { specifier, length: block.length, head: block.slice(0, 40) },
        'H100 non-sample block (QC/calibration data) — not a result, dropped',
      );
      return;
    }

    let sample;
    try {
      sample = parseH100Sample(block);
    } catch (err) {
      // The widths are from the manual's placeholders, not a capture — say so
      // loudly on the first mismatch. The raw block is already in the wire log.
      this.opts.logger.warn({ err: (err as Error).message, length: block.length }, 'unparseable H100 sample block');
      return;
    }

    const isQc = sample.bloodType === 'qc' || sample.bloodType === 'calibrator';
    this.opts.logger.info(
      {
        sample: sample.sampleId,
        bloodType: sample.bloodType,
        testedAt: sample.testedAt,
        hba1c: sample.results[0]!.value,
        curvePoints: sample.curveCount,
        error: sample.error || null,
        codeLength: sample.fields.codeLength,
        version: sample.fields.version,
      },
      'H100 sample block parsed',
    );

    if (sample.errorCode !== '0' && !this.opts.fileOnSamplingError) {
      this.opts.logger.warn(
        { sample: sample.sampleId, error: sample.error },
        'H100 run reported a sampling error — values not filed; the rerun will file',
      );
      return;
    }
    if (!sample.sampleId) {
      this.opts.logger.warn('H100 sample block carried an empty sample id — cannot be filed');
      return;
    }

    const msg: ParsedMessage = {
      protocol: 'h100',
      sender: 'H100',
      patient: null,
      queries: [],
      results: sample.results,
      isQc,
      raw: block,
    };
    this.emit('message', msg);
  }
}

function printable(b: Buffer): string {
  return b.toString('latin1').replace(/\x02/g, '<STX>').replace(/\x03/g, '<ETX>\n');
}
