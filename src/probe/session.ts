// =============================================================================
// PROBE SESSION — a protocol-agnostic link to an unknown device.
//
// The production path (Connector → transport → ProtocolLink) assumes you
// already know what the machine speaks. Commissioning a new analyzer is the
// opposite problem: you have a cable, a port number and no idea what will come
// down it. A probe session opens the same transports the production code uses
// but binds NO codec — it records every byte with a timestamp and direction,
// and lets the operator push arbitrary bytes back.
//
// Deliberately outside the Connector's analyzer set: a probe never files a
// result, never touches the spool and never talks to HMIS. It is a listening
// device, so it holds its capture in memory (bounded) and writes to disk only
// when the operator asks.
// =============================================================================
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import { TcpTransport } from '../transport/tcp.js';
import { SerialTransport } from '../transport/serial.js';
import type { Transport } from '../transport/types.js';
import { identify, renderBytes, type IdentifyResult } from './identify.js';

export interface ProbeTcpConfig {
  type: 'tcp';
  /** 'server' = the device dials us (most analyzers). 'client' = we dial it. */
  mode: 'server' | 'client';
  host: string;
  port: number;
}

export interface ProbeSerialConfig {
  type: 'serial';
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  dtr: boolean;
  rts: boolean;
}

export type ProbeTransportConfig = ProbeTcpConfig | ProbeSerialConfig;

export interface ProbeOptions {
  transport: ProbeTransportConfig;
  /**
   * Auto-answer the handshakes a device needs before it will transmit. Without
   * this, an ASTM analyzer sends ENQ, waits for an ACK it never gets, and gives
   * up — so the capture is one byte long and says nothing. With it on, the
   * probe plays a minimal, protocol-neutral receiver: ACK an ENQ, ACK a frame,
   * do nothing else. It never interprets or files what it receives.
   */
  autoAck: boolean;
  /** Cap on retained capture bytes; older bytes are dropped from the head. */
  maxCaptureBytes: number;
  /** Cap on retained per-event log lines. */
  maxEvents: number;
}

export interface ProbeEvent {
  at: string;
  direction: 'IN' | 'OUT' | 'SYS';
  bytes: number;
  /** Human-readable rendering — printable ASCII plus <ENQ>-style mnemonics. */
  text: string;
}

export interface ProbeState {
  running: boolean;
  endpoint: string;
  autoAck: boolean;
  connected: boolean;
  startedAt: string | null;
  connectedAt: string | null;
  bytesIn: number;
  bytesOut: number;
  lastActivityAt: string | null;
  error: string | null;
}

const ENQ = 0x05;
const ACK = 0x06;
const STX = 0x02;
const EOT = 0x04;
const VT = 0x0b;
const FS = 0x1c;

export class ProbeSession extends EventEmitter {
  private transport: Transport | null = null;
  private capture: Buffer[] = [];
  private captureBytes = 0;
  private events: ProbeEvent[] = [];
  private state: ProbeState;

  constructor(
    private opts: ProbeOptions,
    private readonly logger: Logger,
    /** Where `save()` drops capture files; created on demand. */
    private readonly captureDir: string,
  ) {
    super();
    this.state = {
      running: false,
      endpoint: describe(opts.transport),
      autoAck: opts.autoAck,
      connected: false,
      startedAt: null,
      connectedAt: null,
      bytesIn: 0,
      bytesOut: 0,
      lastActivityAt: null,
      error: null,
    };
  }

  snapshot(): ProbeState {
    return { ...this.state, connected: this.transport?.connected ?? false };
  }

  log(limit = 400): ProbeEvent[] {
    return this.events.slice(-limit);
  }

  /** The raw capture, oldest byte first. */
  buffer(): Buffer {
    return Buffer.concat(this.capture);
  }

  analyze(): IdentifyResult {
    return identify(this.buffer(), { transport: transportBlock(this.opts.transport) });
  }

  async start(opts?: Partial<ProbeOptions>): Promise<void> {
    await this.stop();
    if (opts?.transport) this.opts = { ...this.opts, ...opts, transport: opts.transport };
    else if (opts) this.opts = { ...this.opts, ...opts };

    this.state = {
      ...this.state,
      endpoint: describe(this.opts.transport),
      autoAck: this.opts.autoAck,
      running: true,
      startedAt: new Date().toISOString(),
      connectedAt: null,
      error: null,
    };

    const t = this.opts.transport;
    const transport: Transport =
      t.type === 'tcp'
        ? new TcpTransport({ mode: t.mode, host: t.host, port: t.port, logger: this.logger.child({ probe: 'tcp' }) })
        : new SerialTransport({
            path: t.path,
            baudRate: t.baudRate,
            dataBits: t.dataBits,
            stopBits: t.stopBits,
            parity: t.parity,
            dtr: t.dtr,
            rts: t.rts,
            logger: this.logger.child({ probe: 'serial' }),
          });

    transport.on('data', (chunk: Buffer) => this.onData(chunk));
    transport.on('connect', () => {
      this.state.connected = true;
      this.state.connectedAt = new Date().toISOString();
      this.push('SYS', Buffer.from(`peer connected on ${transport.describe}`));
    });
    transport.on('close', () => {
      this.state.connected = false;
      this.push('SYS', Buffer.from('peer disconnected'));
    });
    transport.on('error', (err: Error) => {
      this.state.error = err.message;
      this.push('SYS', Buffer.from(`transport error: ${err.message}`));
    });

    this.transport = transport;
    try {
      await transport.start();
      this.push('SYS', Buffer.from(`probe listening on ${transport.describe}`));
      this.logger.info({ endpoint: transport.describe, autoAck: this.opts.autoAck }, 'connector-tool probe started');
    } catch (err) {
      this.state.running = false;
      this.state.error = err instanceof Error ? err.message : String(err);
      this.transport = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    this.state.running = false;
    this.state.connected = false;
    if (t) {
      try {
        await t.stop();
      } catch (err) {
        this.logger.warn({ err }, 'connector-tool probe did not stop cleanly');
      }
      this.push('SYS', Buffer.from('probe stopped'));
    }
  }

  /** Push operator-supplied bytes down the link verbatim. */
  async send(data: Buffer): Promise<void> {
    if (!this.transport) throw new Error('the probe is not running');
    if (!this.transport.connected) throw new Error('no device is connected to the probe');
    await this.transport.write(data);
    this.state.bytesOut += data.length;
    this.push('OUT', data);
  }

  clear(): void {
    this.capture = [];
    this.captureBytes = 0;
    this.events = [];
    this.state.bytesIn = 0;
    this.state.bytesOut = 0;
  }

  /** Write the capture to `captures/` as raw bytes plus a readable transcript. */
  save(): { bin: string; log: string; bytes: number } {
    mkdirSync(this.captureDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${describe(this.opts.transport).replace(/[^a-z0-9]+/gi, '_')}-${stamp}`;
    const buf = this.buffer();
    const bin = join(this.captureDir, `${base}.bin`);
    const log = join(this.captureDir, `${base}.log`);
    writeFileSync(bin, buf);
    writeFileSync(log, this.events.map((e) => `${e.at} ${e.direction} ${e.bytes}B ${e.text}`).join('\n') + '\n', 'utf8');
    this.logger.info({ bin, log, bytes: buf.length }, 'connector-tool capture saved');
    return { bin, log, bytes: buf.length };
  }

  // ---------------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.state.bytesIn += chunk.length;
    this.capture.push(chunk);
    this.captureBytes += chunk.length;
    // Bound the retained capture from the head so a machine left connected
    // overnight cannot grow the process without limit.
    while (this.captureBytes > this.opts.maxCaptureBytes && this.capture.length > 1) {
      this.captureBytes -= this.capture.shift()!.length;
    }
    this.push('IN', chunk);
    if (this.opts.autoAck) void this.maybeAck(chunk);
  }

  /**
   * The smallest reply that keeps a device talking, per framing family. This is
   * NOT a protocol implementation — it never parses content, never checks a
   * checksum and never sends an order. It exists so the analyzer completes its
   * transmission and the capture is worth fingerprinting.
   */
  private async maybeAck(chunk: Buffer): Promise<void> {
    const t = this.transport;
    if (!t?.connected) return;
    try {
      // ASTM E1381: ENQ opens the link, every frame is acknowledged, EOT closes
      // it and needs no reply.
      if (chunk.includes(ENQ) || chunk.includes(STX)) {
        if (!chunk.includes(EOT) || chunk.includes(STX)) {
          await t.write(Buffer.from([ACK]));
          this.state.bytesOut += 1;
          this.push('OUT', Buffer.from([ACK]), 'auto');
          return;
        }
      }
      // HL7 MLLP: a complete block is VT … FS CR. A general ACK needs the
      // control id from MSH-10, which is the one field worth reading here.
      if (chunk.includes(VT) && chunk.includes(FS)) {
        const ack = buildHl7Ack(chunk);
        if (ack) {
          await t.write(ack);
          this.state.bytesOut += ack.length;
          this.push('OUT', ack, 'auto');
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'connector-tool auto-ack failed');
    }
  }

  private push(direction: ProbeEvent['direction'], data: Buffer, note?: string): void {
    const at = new Date().toISOString();
    this.state.lastActivityAt = at;
    const text = direction === 'SYS' ? data.toString('utf8') : renderBytes(data);
    this.events.push({ at, direction, bytes: data.length, text: note ? `[${note}] ${text}` : text });
    if (this.events.length > this.opts.maxEvents) this.events.splice(0, this.events.length - this.opts.maxEvents);
    this.emit('event', this.events[this.events.length - 1]);
  }
}

/** Build the minimal MSA^AA reply to an inbound MLLP block, or null. */
function buildHl7Ack(chunk: Buffer): Buffer | null {
  const body = chunk.toString('latin1').replace(/[\x0b\x1c]/g, '').trim();
  const msh = body.split(/\r|\n/).find((l) => l.startsWith('MSH'));
  if (!msh) return null;
  const f = msh.split('|');
  const controlId = f[9] ?? '1';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ack =
    `MSH|^~\\&|PROBE|ZYDUS|${f[2] ?? ''}|${f[3] ?? ''}|${stamp}||ACK|${controlId}|P|${f[11] ?? '2.5'}\r` +
    `MSA|AA|${controlId}\r`;
  return Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'latin1'), Buffer.from([FS, 0x0d])]);
}

export function describe(t: ProbeTransportConfig): string {
  return t.type === 'tcp' ? `tcp://${t.host}:${t.port} (${t.mode})` : `serial://${t.path}@${t.baudRate}`;
}

/** The transport block as it would appear in config.json, for the suggestion. */
function transportBlock(t: ProbeTransportConfig): Record<string, unknown> {
  return t.type === 'tcp'
    ? { type: 'tcp', mode: t.mode, host: t.host, port: t.port }
    : {
        type: 'serial',
        path: t.path,
        baudRate: t.baudRate,
        dataBits: t.dataBits,
        stopBits: t.stopBits,
        parity: t.parity,
        dtr: t.dtr,
        rts: t.rts,
      };
}
