// Configure pm2-logrotate for a 7-day log window. Idempotent: re-running it
// when nothing has changed does nothing at all.
//
//   npm run pm2:logrotate
//
// Why a script rather than chained `pm2 set` calls: every `pm2 set` restarts
// the module AND re-prints its whole config, so setting seven keys meant seven
// restarts and seven near-identical config dumps scrolling past — which reads
// like a stuck loop. Here the current config is read first and only genuinely
// different keys are written, so a re-run is silent and a fresh machine takes
// one pass.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODULE = 'pm2-logrotate';

// Daily rotation with retain 7 gives the same 7-day window as the connector's
// own `retention.days`. max_size is the safety valve: a log storm rotates as
// soon as it hits 10M rather than waiting for midnight.
const WANTED = {
  max_size: '10M',
  retain: '7',
  compress: 'true',
  dateFormat: 'YYYY-MM-DD_HH-mm-ss',
  rotateInterval: '0 0 * * *',
  rotateModule: 'true',
  workerInterval: '30',
};

/** pm2 is a .cmd shim on Windows, so it needs a shell to be found on PATH. */
const pm2 = (args, quiet = true) => {
  try {
    const out = execFileSync('pm2', args, { encoding: 'utf8', shell: true, stdio: quiet ? 'pipe' : 'inherit' });
    return { ok: true, out: out ?? '' };
  } catch (err) {
    return { ok: false, out: err.stdout ?? '', err: err.stderr ?? String(err) };
  }
};

/** pm2 keeps module settings here; reading it beats parsing `pm2 conf`. */
function currentConfig() {
  const file = join(homedir(), '.pm2', 'module_conf.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'))[MODULE] ?? {};
  } catch {
    return {};
  }
}

const installed = pm2(['ls']).out.includes(MODULE);
if (!installed) {
  console.log(`installing ${MODULE} …`);
  const res = pm2(['install', MODULE], false);
  if (!res.ok) {
    console.error(`could not install ${MODULE}. Is pm2 on PATH?`);
    process.exit(1);
  }
} else {
  console.log(`${MODULE} already installed`);
}

const current = currentConfig();
const changes = Object.entries(WANTED).filter(([k, v]) => String(current[k] ?? '') !== v);

if (changes.length === 0) {
  console.log('configuration already correct — nothing to do');
} else {
  for (const [key, value] of changes) {
    // Quote the value: rotateInterval is a cron expression with spaces.
    const res = pm2(['set', `${MODULE}:${key}`, `"${value}"`]);
    console.log(`  ${res.ok ? 'set' : 'FAILED'}  ${key} = ${value}${current[key] ? ` (was ${current[key]})` : ''}`);
    if (!res.ok) process.exitCode = 1;
  }
}

console.log('\neffective configuration:');
for (const [k, v] of Object.entries(currentConfig())) console.log(`  ${k.padEnd(15)} ${v}`);
console.log('\nlogs rotate daily, 7 kept, gzipped, early rotation past 10M.');
console.log('verify any time with:  pm2 conf pm2-logrotate');
