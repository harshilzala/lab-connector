import { resolve, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ResultStore } from '../src/results/store.js';
import { importFiledFromAudit } from '../src/results/import-audit.js';
import { DailyLogFile } from '../src/maintenance/daily-log.js';
import { assayKey } from '../src/codec/astm/records.js';

// Restore the samples a staged analyzer filed BEFORE it was switched to
// staged, from the HMIS transaction log, so the console lists them and
// "Force" can re-push them. See src/results/import-audit.ts.
//
//   npm run import:filed                       every staged analyzer, last 2 days
//   npm run import:filed -- --days 5
//   npm run import:filed -- --analyzer vitros-eciq
//   npm run import:filed -- --config ./config.json
//
// Safe to run while the service is up: it only adds values the store does not
// hold, one atomic file write per sample. Safe to run twice.

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
  else args.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[++i]! : 'true');
}
const days = Number(args.get('days') ?? '2');
const only = args.get('analyzer');
const cfg = loadConfig(args.get('config') ?? './config.json');

if (!cfg.hmis.auditLog) {
  console.error('hmis.auditLog is off in config.json — there is no transaction log to read');
  process.exit(1);
}
const files = DailyLogFile.files(resolve(cfg.hmis.auditLog));
if (files.length === 0) {
  console.error(`no transaction log files found for ${cfg.hmis.auditLog}`);
  process.exit(1);
}
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const spoolRoot = resolve(cfg.spoolDir);

const log = {
  child: () => log,
  info: (o: unknown, m?: string) => console.log(`  ${m ?? ''} ${JSON.stringify(o)}`),
  warn: (o: unknown, m?: string) => console.warn(`  ! ${m ?? ''} ${JSON.stringify(o)}`),
  error: (o: unknown, m?: string) => console.error(`  !! ${m ?? ''} ${JSON.stringify(o)}`),
  debug() {},
  trace() {},
  fatal() {},
} as any;

let ran = 0;
for (const a of cfg.analyzers) {
  if (only && a.id !== only) continue;
  if (a.filing.mode !== 'staged') {
    if (only) console.error(`${a.id} is not a staged analyzer (filing.mode = ${a.filing.mode}) — nothing to restore into`);
    continue;
  }
  if (Object.keys(a.testCodeScale ?? {}).length > 0) {
    // The log holds values AFTER unit scaling; the store must hold them
    // BEFORE it, or Force would scale them a second time.
    console.error(`${a.id}: skipped — it has testCodeScale, and the transaction log holds scaled values`);
    continue;
  }
  ran++;
  console.log(`${a.id} (${[a.equipmentCode, ...a.extraEquipmentCodes].join(', ')}) — uploads since ${since.toISOString()} in ${files.length} log file(s)`);
  const report = importFiledFromAudit({
    store: new ResultStore(join(spoolRoot, a.id, 'results'), log),
    files,
    eqCodes: [a.equipmentCode, ...a.extraEquipmentCodes],
    equipmentId: a.equipmentId ?? null,
    canonicalCode: a.protocol === 'astm' ? assayKey(a.astm.dialect) : undefined,
    aliases: a.testCodeAliases,
    since,
    log,
  });
  console.log(
    `  ${report.uploads} accepted upload(s) read → ${report.values} value(s) restored on ${report.samples} sample(s); ` +
      `${report.skipped} already held`,
  );
}
if (!ran) {
  console.error(only ? `no staged analyzer with id "${only}"` : 'no staged analyzer in config.json');
  process.exit(1);
}
