import { EventEmitter } from 'node:events';
import type { Logger } from '../logger.js';
import type { Transport } from './types.js';

export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  /** Raise DTR after open so the analyzer sees the host as ready to receive. */
  dtr: boolean;
  /** Raise RTS after open (same purpose; no hardware flow control is used). */
  rts: boolean;
  logger: Logger;
}

// Serial (RS-232) transport. `serialport` is an optional native dependency so a
// TCP-only install doesn't need build tools on the lab PC. It is imported
// lazily; if it isn't installed we fail only when a serial analyzer is used.
export class SerialTransport extends EventEmitter implements Transport {
  readonly kind = 'serial' as const;
  private port: any = null;
  private stopping = false;

  constructor(private readonly opts: SerialOptions) {
    super();
  }

  get connected(): boolean {
    return !!this.port?.isOpen;
  }

  get describe(): string {
    return `serial://${this.opts.path}@${this.opts.baudRate}`;
  }

  async start(): Promise<void> {
    this.stopping = false;
    let SerialPortCtor: any;
    try {
      ({ SerialPort: SerialPortCtor } = await import('serialport'));
    } catch {
      throw new Error(
        'Serial transport requested but the "serialport" package is not installed. Run: npm install serialport',
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.port = new SerialPortCtor(
        {
          path: this.opts.path,
          baudRate: this.opts.baudRate,
          dataBits: this.opts.dataBits,
          stopBits: this.opts.stopBits,
          parity: this.opts.parity,
        },
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
      this.port.on('data', (chunk: Buffer) => this.emit('data', chunk));
      this.port.on('error', (err: Error) => this.emit('error', err));
      this.port.on('close', () => {
        this.emit('close');
        if (!this.stopping) setTimeout(() => this.start().catch(() => {}), 3000);
      });
    });

    // Assert the modem-control lines so the analyzer will transmit. The Siemens
    // ADVIA 2120i / CLINITEK Advantus (and the legacy caretech middleware) hold
    // their result send until DTR/RTS are high. Best-effort: a failure here
    // shouldn't stop the port from working for devices that don't need it.
    await new Promise<void>((resolve) => {
      this.port.set({ dtr: this.opts.dtr, rts: this.opts.rts }, (err: Error | null) => {
        if (err) this.opts.logger.warn({ err: err.message }, 'could not set DTR/RTS lines');
        resolve();
      });
    });

    this.opts.logger.info(
      { endpoint: this.describe, dtr: this.opts.dtr, rts: this.opts.rts },
      'serial port opened',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await new Promise<void>((resolve) => (this.port?.isOpen ? this.port.close(() => resolve()) : resolve()));
    this.port = null;
  }

  async write(data: Buffer): Promise<void> {
    if (!this.port?.isOpen) throw new Error('Serial transport: port not open');
    await new Promise<void>((resolve, reject) => this.port.write(data, (err: Error | null) => (err ? reject(err) : resolve())));
  }
}
