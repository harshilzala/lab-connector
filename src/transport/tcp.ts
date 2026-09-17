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

  get listening(): boolean {
    return this.opts.mode === 'server' && !!this.server && this.server.listening;
  }

  private dialError: string | null = null;
  get lastDialError(): string | null {
    return this.dialError;
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
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Almost always a second copy of the connector: the LAB-Interface
          // Windows service is already up and someone ran "npm run dev" beside
          // it (2026-09-16). Note that killing the service's node process is
          // not a stop — the SCM restarts it 10s later and takes the port back,
          // which is why the hint points at the force-stop script and not at
          // Task Manager or the PM2-only Lab-Interface-stop.bat.
          this.opts.logger.error(
            { endpoint: this.describe },
            'port already in use — another Lab-Interface is probably running (the LAB-Interface Windows service, or a second "npm run dev"). ' +
              'Only one instance can run: stop the other one first with Lab-Interface-force-stop.bat ' +
              '(or magic\\magic-force-stop.bat), which stops the service, the watchdog and any stray process.',
          );
        } else {
          this.opts.logger.error({ err }, 'TCP server error');
        }
        this.emit('error', err);
        reject(err);
      });
      server.listen(this.opts.port, this.opts.host, () => {
        // Trust the OS, not the config. On 2026-09-16 a lab PC silently bound
        // every requested port to a random ~20xxx one (a host-level network
        // filter): "listening" was logged, the analyzer dialled 2807, nothing
        // answered. A bound port that differs from the configured one is a
        // failed start, not a healthy connector.
        const addr = server.address();
        const bound = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        if (this.opts.port !== 0 && bound !== this.opts.port) {
          const err = new Error(
            `TCP server asked for port ${this.opts.port} but the OS bound ${bound} — something on this PC is ` +
              'rewriting socket binds (a security agent / network sandbox). The analyzer cannot reach the connector ' +
              'until that is fixed at the OS level; the config is not the problem.',
          );
          this.opts.logger.error({ endpoint: this.describe, boundPort: bound }, err.message);
          server.close();
          reject(err);
          return;
        }
        this.opts.logger.info({ endpoint: this.describe, boundPort: bound }, 'TCP server listening');
        resolve();
      });
      this.server = server;
    });
  }

  private async dial(): Promise<void> {
    const socket = net.connect({ host: this.opts.host, port: this.opts.port });
    socket.on('connect', () => {
      this.dialError = null;
      this.opts.logger.info({ endpoint: this.describe }, 'TCP client connected');
      this.adoptSocket(socket);
    });
    socket.on('error', (err) => {
      this.dialError = err.message;
      this.opts.logger.warn({ err: err.message }, 'TCP client connection error');
      // Not 'error': a refused dial is routine while an analyzer is off, and the
      // protocol links treat 'error' as a link fault. Anyone who needs to know
      // why a client link is not up (the connector-tool probe) listens for this.
      this.emit('dial-error', err);
    });
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
