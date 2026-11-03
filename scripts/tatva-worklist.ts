// Read-only: print the raw Tatva v1 worklist (oauth partner API).
//
//   Run:  npx tsx scripts/tatva-worklist.ts                 batch, last 7 days
//         npx tsx scripts/tatva-worklist.ts 3               batch, last 3 days
//         npx tsx scripts/tatva-worklist.ts LB2611030633 …  by barcode
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { makeTatvaClient, tatvaClientOptions } from '../src/hmis/tatva.js';
import { logger } from '../src/logger.js';

const root = resolve(import.meta.dirname, '..');
const cfg = loadConfig(resolve(root, 'config.json'));
const opts = tatvaClientOptions(cfg.hmis.tatva as never, { timeoutMs: cfg.hmis.timeoutMs, tlsRejectUnauthorized: cfg.hmis.tlsRejectUnauthorized, logger } as never);
const client = makeTatvaClient(opts) as unknown as { call: (m: string, p: string, b: unknown, id: string) => Promise<unknown> };
const wl = opts.worklistPath;

const args = process.argv.slice(2);
const days = args.length === 1 && /^\d+$/.test(args[0]!) ? Number(args[0]) : null;
const barcodes = days === null ? args : [];

if (barcodes.length === 0) {
  const to = new Date();
  const from = new Date(to.getTime() - (days ?? 7) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const path = `${wl}?${new URLSearchParams({ from: iso(from), to: iso(to), page: '0', size: '200' })}`;
  console.log(`GET ${opts.baseUrl}${path}`);
  console.log(JSON.stringify(await client.call('GET', path, undefined, `wl-${Date.now()}`), null, 2));
}
for (const b of barcodes) {
  const path = `${wl}?barcode=${encodeURIComponent(b)}`;
  console.log(`\nGET ${opts.baseUrl}${path}`);
  try {
    console.log(JSON.stringify(await client.call('GET', path, undefined, `q-${Date.now()}`), null, 2));
  } catch (err) {
    console.log(`ERROR ${(err as Error).message}`);
  }
}
