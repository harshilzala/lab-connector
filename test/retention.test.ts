// Retention sweeper: 7-day boundary, createdAt-over-mtime, and the warn line
// that records a discarded result. Run with:  npx tsx test/retention.test.ts
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionSweeper } from '../src/maintenance/retention.js';

const root = mkdtempSync(join(tmpdir(), 'retention-'));
const logDir = join(root, 'logs');
const spoolRoot = join(root, 'spool');
const spoolPending = join(spoolRoot, 'meglumi', 'pending');
const spoolFailed = join(spoolRoot, 'meglumi', 'failed');
for (const d of [logDir, spoolPending, spoolFailed]) mkdirSync(d, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function log(name: string, daysOld: number) {
  const p = join(logDir, name);
  writeFileSync(p, 'x'.repeat(100));
  const t = ago(daysOld);
  utimesSync(p, t, t);
}

/** mtimeDays lets a stale item look freshly touched, as a retry would. */
function spooled(dir: string, id: string, createdDaysAgo: number, mtimeDays = createdDaysAgo) {
  const p = join(dir, `${id}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      id,
      createdAt: ago(createdDaysAgo).toISOString(),
      attempts: 50,
      payload: { barcode: id.split('-')[0], results: [{ testCode: 'TG II', value: '4996' }] },
    }),
  );
  const t = ago(mtimeDays);
  utimesSync(p, t, t);
}

log('old.log', 30);
log('boundary.log', 8);
log('fresh.log', 2);

spooled(spoolFailed, 'OLD001-aaa', 30);
spooled(spoolFailed, 'FRESH1-bbb', 1);
// Created 30 days ago but rewritten an hour ago by a retry: must still expire.
spooled(spoolPending, 'RETRIED-ccc', 30, 0);
spooled(spoolPending, 'RECENT-ddd', 3);

const lines: string[] = [];
const logger = {
  info: (o: unknown, m: string) => lines.push(`info  ${m} ${JSON.stringify(o)}`),
  warn: (o: unknown, m: string) => lines.push(`warn  ${m} ${JSON.stringify(o)}`),
  error: () => {},
  debug: () => {},
} as never;

const report = new RetentionSweeper({
  days: 7,
  logDir,
  spoolRoot,
  intervalMs: 60_000,
  includeSpoolPending: true,
  logger,
}).sweep();

console.log('report:', report);
console.log('logs left  :', readdirSync(logDir));
console.log('pending left:', readdirSync(spoolPending));
console.log('failed left :', readdirSync(spoolFailed));
console.log('\ndeletion records:');
for (const l of lines.filter((x) => x.includes('unfiled result'))) console.log(' ', l);

const ok =
  report.logFilesDeleted === 2 &&
  report.spoolItemsDeleted === 2 &&
  readdirSync(logDir).join() === 'fresh.log' &&
  readdirSync(spoolPending).join() === 'RECENT-ddd.json' &&
  readdirSync(spoolFailed).join() === 'FRESH1-bbb.json';
console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');

// includeSpoolPending:false must leave pending alone.
spooled(spoolPending, 'OLD002-eee', 30);
const r2 = new RetentionSweeper({
  days: 7,
  logDir,
  spoolRoot,
  intervalMs: 60_000,
  includeSpoolPending: false,
  logger,
}).sweep();
console.log('pending held:', r2.spoolItemsDeleted === 0 && readdirSync(spoolPending).includes('OLD002-eee.json') ? 'PASS' : 'FAIL');

rmSync(root, { recursive: true, force: true });

// ---- separate log window: logDays keeps logs longer than spool items --------
const logDir2 = join(root, 'logs2');
mkdirSync(logDir2, { recursive: true });
const log2 = (name: string, daysOld: number) => {
  const p = join(logDir2, name);
  writeFileSync(p, 'x'.repeat(100));
  const t = ago(daysOld);
  utimesSync(p, t, t);
};
log2('hmis-2026-08-01.log', 31);
log2('hmis-2026-08-10.log', 29);
log2('wire-cancer-abl9-2026-08-20.log', 8);
const r3 = new RetentionSweeper({
  days: 7,
  logDays: 30,
  logDir: logDir2,
  spoolRoot: join(root, 'no-spool'),
  intervalMs: 60_000,
  includeSpoolPending: true,
  logger,
}).sweep();
const left3 = readdirSync(logDir2).sort();
console.log('\nlogDays=30 sweep:', r3, 'left:', left3);
const ok3 = r3.logFilesDeleted === 1 && left3.join() === 'hmis-2026-08-10.log,wire-cancer-abl9-2026-08-20.log';
console.log(ok3 ? 'OK  logs older than logDays go, 8-day-old log stays' : 'FAILED logDays window');
if (!ok3) process.exitCode = 1;
rmSync(root, { recursive: true, force: true });
