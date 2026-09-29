// =============================================================================
// One command from a source checkout to the running site:
//
//   npm run deploy                         -> D:\lab-deploy\deploy (the live folder)
//   npm run deploy -- E:\other\deploy      -> another deployment folder
//   (or set LAB_DEPLOY_DIR)
//
// Steps, stopping at the first failure so a broken build never reaches the lab:
//   1. typecheck the sources
//   2. wait until no analyzer has been on the wire for a few seconds
//   3. npm run dist into the deployment folder (its config.json, .env, spool\
//      and logs\ are kept — see make-dist.mjs)
//   4. re-seal it, when it was sealed before (or with --seal)
//   5. restart Lab-Interface under that folder's own PM2 home (.pm2\), or
//      start it when PM2 does not know it yet, and save the process list
//   6. read the fresh startup block and fail loudly if it did not come up
// =============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const TARGET = resolve(args.find((a) => !a.startsWith('--')) ?? process.env.LAB_DEPLOY_DIR ?? 'D:\\lab-deploy\\deploy');
const FORCE_SEAL = args.includes('--seal');
const APP = 'Lab-Interface';

const step = (n, text) => console.log(`\n  [${n}/6] ${text}`);
const die = (msg) => {
  console.error(`\n  DEPLOY FAILED: ${msg}\n`);
  process.exit(1);
};
const run = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

console.log(`\n  deploying lab-connector`);
console.log(`  from : ${ROOT}`);
console.log(`  into : ${TARGET}`);
if (!existsSync(join(TARGET, 'config.json'))) die(`${TARGET} has no config.json — is this the deployment folder?`);

step(1, 'typecheck');
if (run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { cwd: ROOT }).status !== 0) die('the sources do not typecheck');

step(2, 'waiting for the analyzer links to be quiet');
const logDir = join(TARGET, 'logs');
const lastWire = () => {
  try {
    return Math.max(0, ...readdirSync(logDir).filter((f) => f.startsWith('wire-')).map((f) => statSync(join(logDir, f)).mtimeMs));
  } catch {
    return 0;
  }
};
const QUIET_MS = 15_000;
const giveUpAt = Date.now() + 120_000;
while (Date.now() - lastWire() < QUIET_MS) {
  if (Date.now() > giveUpAt) die('an analyzer has been transferring for 2 minutes — try again in a moment');
  console.log('        a transfer is in progress, waiting…');
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('        quiet');

const wasSealed = existsSync(join(TARGET, 'dist', 'app.enc'));

step(3, 'building the run-only bundle');
if (run(process.execPath, [join(ROOT, 'scripts', 'make-dist.mjs'), TARGET], { cwd: ROOT, shell: false }).status !== 0) {
  die('npm run dist failed — the deployment folder is unchanged except for dist\\');
}

step(4, wasSealed || FORCE_SEAL ? 're-sealing (binding to this PC)' : 'not sealed before — leaving it unsealed');
if (wasSealed || FORCE_SEAL) {
  if (run(process.execPath, [join(TARGET, 'seal.mjs')], { cwd: TARGET, shell: false }).status !== 0) {
    die('sealing failed — the folder holds an UNSEALED build; run node seal.mjs in it');
  }
}

step(5, `restarting ${APP}`);
const env = { ...process.env, PM2_HOME: join(TARGET, '.pm2') };
const startedAt = Date.now();
const known = run('pm2', ['describe', APP], { cwd: TARGET, env, stdio: 'ignore' }).status === 0;
const pm2 = known
  ? run('pm2', ['restart', APP, '--update-env'], { cwd: TARGET, env })
  : run('pm2', ['start', 'ecosystem.config.cjs'], { cwd: TARGET, env });
if (pm2.status !== 0) die('PM2 could not (re)start the connector');
run('pm2', ['save', '--force'], { cwd: TARGET, env, stdio: 'ignore' });

step(6, 'checking the startup');
const outLog = join(logDir, 'lab-interface.out.log');
const deadline = Date.now() + 45_000;
let started = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (!existsSync(outLog)) continue;
  const fresh = readFileSync(outLog, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = /"time":(\d+)/.exec(l);
      return t && Number(t[1]) >= startedAt - 1000;
    });
  const runtimes = fresh.filter((l) => l.includes('"analyzer runtime started"')).length;
  const errors = fresh.filter((l) => /"level":(50|60)/.test(l));
  if (fresh.some((l) => l.includes('"lab-connector started"'))) {
    started = { runtimes, errors };
    break;
  }
}
if (!started) die(`no "lab-connector started" in ${outLog} within 45 s — check pm2 logs ${APP}`);
console.log(`        lab-connector started — ${started.runtimes} analyzer runtime(s) up`);
if (started.errors.length) {
  console.log(`        ${started.errors.length} error line(s) at startup:`);
  for (const l of started.errors.slice(0, 5)) console.log('          ' + l.slice(0, 220));
}
console.log(`\n  deployed.\n`);
