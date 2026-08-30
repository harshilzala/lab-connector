import type { EventEmitter } from 'node:events';

// =============================================================================
// Transport = the raw byte pipe to the analyzer. TCP or serial. It knows
// nothing about ASTM/HL7 — it only moves bytes and reports connect/close.
//
// Events:
//   'data'    (chunk: Buffer)   bytes arrived from the analyzer
//   'connect' ()                a peer connected (TCP) / port opened (serial)
//   'close'   ()                peer disconnected / port closed
//   'error'   (err: Error)
// =============================================================================
export interface Transport extends EventEmitter {
  readonly kind: 'tcp' | 'serial';
  readonly connected: boolean;
  /** Human-readable endpoint, e.g. "tcp://0.0.0.0:5001" or "serial://COM3@9600". */
  readonly describe: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  write(data: Buffer): Promise<void>;
}
