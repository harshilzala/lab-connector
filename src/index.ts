import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { Connector } from './connector.js';
import { installHostPins } from './hmis/hosts.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Before any gateway client exists: their first lookup must already see it.
  installHostPins(cfg.hmis.hosts, logger);
  const connector = new Connector(cfg, logger);
  await connector.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await connector.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal: failed to start');
  process.exit(1);
});
