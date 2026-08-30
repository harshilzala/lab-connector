import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Logger } from '../logger.js';
import type { Transport } from './types.js';

export interface TcpOptions {
  mode: 'server' | 'client';
  host: string;
  port: number;
  logger: Logger;
}

// TCP transport. In 'server' mode we listen and the analyzer dials in (the
// common Atellica setup). In 'client' mode we dial the analyzer and auto
// reconnect. Either way exactly one peer socket is active at a time.
export class TcpTransport extends EventEmitter implements Transport {
  readonly kind = 'tcp' as const;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TcpOptions) {
    super();
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  get describe(): string {
    return `tcp://${this.opts.host}:${this.opts.port} (${this.opts.mode})`;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.opts.mode === 'server') return this.listen();
    return this.dial();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  async write(data: Buffer): Promise<void> {
    const s = this.socket;
    if (!s || s.destroyed) throw new Error('TCP transport: no connected peer to write to');
    await new Promise<void>((resolve, reject) => s.write(data, (err) => (err ? reject(err) : resolve())));
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.adoptSocket(socket));
      server.on('error', (err) => {
        this.opts.logger.error({ err }, 'TCP server error');
        this.emit('error', err);
        reject(err);
      });
      server.listen(this.opts.port, this.opts.host, () => {
        this.opts.logger.info({ endpoint: this.describe }, 'TCP server listening');
        resolve();
      });
      this.server = server;
    });
  }

  private async dial(): Promise<void> {
    const socket = net.connect({ host: this.opts.host, port: this.opts.port });
    socket.on('connect', () => {
      this.opts.logger.info({ endpoint: this.describe }, 'TCP client connected');
      this.adoptSocket(socket);
    });
    socket.on('error', (err) => this.opts.logger.warn({ err: err.message }, 'TCP client connection error'));
    socket.on('close', () => {
      if (this.stopping) return;
      this.reconnectTimer = setTimeout(() => this.dial().catch(() => {}), 3000);
    });
  }

  private adoptSocket(socket: net.Socket): void {
    // Replace any stale peer with the newest connection.
    if (this.socket && this.socket !== socket) this.socket.destroy();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.emit('data', chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('close');
    });
    this.emit('connect');
    this.opts.logger.info({ peer: `${socket.remoteAddress}:${socket.remotePort}` }, 'analyzer connected');
  }
}
