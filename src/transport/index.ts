import type { Logger } from '../logger.js';
import type { TransportConfig } from '../config.js';
import type { Transport } from './types.js';
import { TcpTransport } from './tcp.js';
import { SerialTransport } from './serial.js';

export function createTransport(cfg: TransportConfig, logger: Logger): Transport {
  if (cfg.type === 'tcp') {
    return new TcpTransport({ mode: cfg.mode, host: cfg.host, port: cfg.port, logger: logger.child({ transport: 'tcp' }) });
  }
  return new SerialTransport({
    path: cfg.path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    dtr: cfg.dtr,
    rts: cfg.rts,
    logger: logger.child({ transport: 'serial' }),
  });
}

export type { Transport } from './types.js';
