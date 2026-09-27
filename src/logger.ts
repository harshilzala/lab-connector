import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// Pretty transport only when a TTY is attached (dev). Under the Windows service
// wrapper stdout is a pipe → emit line-delimited JSON, which the wrapper logs.
//
// Never in a bundled deployment, whatever stdout is. pino resolves a transport
// target by NAME and spawns a worker thread to load it, so a missing pino-pretty
// throws before the first line is logged — and `npm run dist` ships no
// node_modules. Under PM2 stdout is a pipe so this path was never taken, but
// run from a console the connector would have died on its own logger. The flag
// is replaced with "1" at bundle time (see scripts/make-dist.mjs); in a source
// checkout it is unset and the TTY check decides as before.
const pretty = process.env.LAB_CONNECTOR_BUNDLED !== '1' && process.stdout.isTTY;

export const logger = pino({
  level,
  transport: pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
    : undefined,
});

export type Logger = pino.Logger;

/** Child logger scoped to a subsystem (e.g. an analyzer id). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
