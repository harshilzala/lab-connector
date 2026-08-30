import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// Pretty transport only when a TTY is attached (dev). Under the Windows service
// wrapper stdout is a pipe → emit line-delimited JSON, which the wrapper logs.
const pretty = process.stdout.isTTY;

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
