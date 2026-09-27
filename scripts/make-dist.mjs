// =============================================================================
// Build a RUN-ONLY deployment folder.
//
//   npm run dist              -> .\deploy
//   npm run dist -- ..\out    -> anywhere else
//
// What comes out is everything the connector needs to run and nothing it needs
// to be BUILT: one bundled, minified dist\index.js in place of the 100-odd
// compiled files, the site's own config.json and .env, and the magic\ startup
// scripts untouched. No src\, no node_modules\, no .ts, no source maps.
//
// The startup path is deliberately identical to a source checkout, so an
// operator learns one thing: magic\magic-start.bat. It finds dist\index.js
// already present and skips the build step it would otherwise run.
//
// Not obfuscation-proof, and not meant to be: see README-DEPLOY.md. Minifying
// removes the comments and mangles the local names, which is the difference
// between "readable in Notepad" and "someone has to want it".
//
// serialport and oracledb stay OUT of the bundle on purpose. Both are imported
// dynamically and both are optional — a site that runs neither never needs
// them, and one that does installs them in the deploy folder (README-DEPLOY).
// Bundling them is not possible anyway: serialport ships native .node binaries.
// =============================================================================
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const SEAL = args.includes('--seal');
const OUT = resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? 'deploy');

if (OUT === ROOT) {
  console.error('refusing to build into the connector root — pass a different folder');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log(`\n  building a run-only deployment`);
console.log(`  from : ${ROOT}`);
console.log(`  into : ${OUT}\n`);

// A rebuild must not leave last build's files behind — a renamed module would
// otherwise linger and a stale config could be picked up over the new one.
// logs\ and spool\ are the site's own runtime state and are never touched.
for (const stale of ['dist', 'magic', 'package.json', 'ecosystem.config.cjs', 'README-DEPLOY.md', 'seal.mjs']) {
  rmSync(join(OUT, stale), { recursive: true, force: true });
}
mkdirSync(join(OUT, 'dist'), { recursive: true });

// ---- 1. the connector itself -------------------------------------------------
// CommonJS, not ESM, and that is the load-bearing decision here.
//
// Two reasons. pino and its dependencies are CJS and call require("node:os");
// bundled into ESM output those hit esbuild's require shim and the process died
// on the first import with "Dynamic require of node:os is not supported". And
// `npm run seal` has to be able to decrypt the bundle and run it from memory —
// a CJS string runs under a plain function with a real `require`, where an ESM
// string would need a data: URL, and a data: URL cannot resolve the bare
// specifiers this app needs (`import("serialport")`).
//
// dist\index.cjs is therefore the application, and dist\index.js is a three-line
// ESM shim that loads it — so the entry point PM2 and magic-start.bat look for
// is dist\index.js either way, sealed or not.
const result = await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  outfile: join(OUT, 'dist', 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  sourcemap: false, // a map would name every source file and hand back the shape
  legalComments: 'none',
  external: ['serialport', 'oracledb'],
  // Turn `await import("serialport")` into a require, rather than leaving a real
  // dynamic import in the output. A dynamic import resolves bare specifiers
  // against the importing FILE's URL, and once sealed this code is a string run
  // from memory with no URL at all — the optional-dependency loads would fail
  // with nothing to resolve against. require() resolves against the __filename
  // the loader supplies, which is the real path inside dist\.
  supported: { 'dynamic-import': false },
  // Kills the pino-pretty transport in the bundle: there is no node_modules
  // here for pino's worker thread to load it from. See src/logger.ts.
  define: { 'process.env.LAB_CONNECTOR_BUNDLED': '"1"' },
  logLevel: 'warning',
  metafile: true,
});
const bundleBytes = statSync(join(OUT, 'dist', 'index.cjs')).size;

writeFileSync(
  join(OUT, 'dist', 'index.js'),
  `// Entry point. The application is dist\\index.cjs; this shim exists so the
// entry is always dist\\index.js, whether the deployment is sealed or not.
// After \`node seal.mjs\` this file is replaced by the decrypting loader.
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./index.cjs');
`,
  'utf8',
);
console.log(`  [1/5] bundled dist\\index.cjs  ${(bundleBytes / 1024).toFixed(0)} KB  (+ dist\\index.js shim)`);

// ---- 2. the manifest PM2 and Node need --------------------------------------
// "type": "module" is not optional: the bundle is ESM and is named .js, so Node
// reads the module system off the nearest package.json. Without it the process
// dies on the first `import` with "Cannot use import statement outside a
// module". The build script is a friendly no-op rather than absent, because
// magic-start.bat /build calls `npm run build` and checks the exit code.
writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      description: 'Run-only deployment. The sources live in the connector repository.',
      scripts: {
        start: 'node dist/index.js',
        build: 'node -e "console.log(\'This is a run-only deployment — dist/index.js is already built. Rebuild it from the source checkout with: npm run dist\')"',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log('  [2/5] package.json written (type: module, build = no-op)');

// ---- 3. the startup path, unchanged -----------------------------------------
// ecosystem.config.cjs resolves dist\index.js and the PM2 home against its own
// __dirname, and every magic script works from %~dp0.. — so both are copied
// verbatim and simply run from wherever this folder ends up.
cpSync(join(ROOT, 'ecosystem.config.cjs'), join(OUT, 'ecosystem.config.cjs'));
cpSync(join(ROOT, 'magic'), join(OUT, 'magic'), { recursive: true });
console.log('  [3/5] ecosystem.config.cjs + magic\\ copied verbatim');

// ---- 4. this site's configuration -------------------------------------------
// Copied, never generated: the live config.json is the only record of how this
// site is wired. An existing one in the target is left alone — a site may have
// edited it since the last build, and overwriting that would be destroying the
// thing hardest to reconstruct.
const carried = [];
for (const f of ['config.json', '.env', 'admin-auth.json']) {
  if (!existsSync(join(ROOT, f))) continue;
  if (existsSync(join(OUT, f))) {
    carried.push(`${f} (kept the one already there)`);
    continue;
  }
  cpSync(join(ROOT, f), join(OUT, f));
  carried.push(f);
}
console.log(`  [4/5] ${carried.join(', ') || 'no config files found to carry'}`);

// ---- 5. runtime state directories -------------------------------------------
// The spool is the connector's durability guarantee: a result that cannot be
// filed yet waits on disk. Create both up front so a first start never races a
// missing directory.
for (const d of ['logs', 'spool']) mkdirSync(join(OUT, d), { recursive: true });

// seal.mjs travels WITH the deployment, because sealing binds to a machine and
// so has to be run on the machine that will run the connector — a folder built
// here and sealed here would not open at a site.
cpSync(join(ROOT, 'scripts', 'seal.mjs'), join(OUT, 'seal.mjs'));

writeFileSync(join(OUT, 'README-DEPLOY.md'), readme(pkg, bundleBytes), 'utf8');
console.log('  [5/5] logs\\, spool\\, seal.mjs and README-DEPLOY.md ready');

// A quick census, so the operator can see at a glance that no source shipped.
const inputs = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs ?? {});
console.log(`\n  ${inputs.length} source modules folded into one file.`);

// --seal only makes sense when the build machine IS the run machine. Left off by
// default so a folder can be built here and sealed at the site.
if (SEAL) {
  const { status } = spawnSync(process.execPath, [join(OUT, 'seal.mjs')], { stdio: 'inherit' });
  if (status !== 0) {
    console.error('\n  sealing FAILED — the deployment is built but NOT sealed.\n');
    process.exit(status ?? 1);
  }
} else {
  console.log(`  start it with:  ${join(OUT, 'magic', 'magic-start.bat')}`);
  console.log(`  bind it to this machine first with:  node ${join(OUT, 'seal.mjs')}\n`);
}

function readme(pkg, bytes) {
  return `# ${pkg.name} — run-only deployment

Built from source on ${new Date().toISOString().slice(0, 10)}. Version ${pkg.version}.

This folder RUNS the connector. It cannot build it: there is no TypeScript here
and no \`node_modules\`. \`dist/index.js\` is the whole application bundled into
one minified file (${(bytes / 1024).toFixed(0)} KB).

## Start and stop

Exactly as on a source checkout — the scripts are the same files:

    magic\\magic-start.bat     start (or restart) under PM2, register the
                              logon entry and the 5-minute watchdog
    magic\\magic-stop.bat      stop, and tell the watchdog it was deliberate
    magic\\magic-force-stop.bat  stop everything including the watchdog

Dashboard: http://127.0.0.1:7071 · live log: \`pm2 logs Lab-Interface\`

Requires Node 22+ and PM2 on PATH (\`npm install -g pm2\`). Nothing else.

## What is where

    dist\\index.js          entry point (a shim, or the loader once sealed)
    dist\\index.cjs         the connector, bundled and minified
    config.json            this site's analyzer wiring — the file to edit
    .env                   secrets and overrides; wins over config.json
    admin-auth.json        dashboard credential (created on first start)
    ecosystem.config.cjs   PM2 process definition
    seal.mjs               binds this folder to this machine (see below)
    magic\\                 the start/stop scripts
    logs\\  spool\\          runtime state — never delete spool\\ while running

\`spool\\\` holds results that HMIS has not accepted yet. Deleting it loses
patient data that has not been filed.

## Serial analyzers and Auto Certify

Both are optional and are not in the bundle. Install them here only if this
site needs them:

    npm install serialport      # only for a serial (RS-232 / COM) analyzer
    npm install oracledb        # only for Auto Certify

Without them the connector runs normally and says so if a serial transport or
Auto Certify is configured.

## Rebuilding

From the source checkout, not here:

    npm run dist -- <path-to-this-folder>

\`config.json\`, \`.env\`, \`logs\\\` and \`spool\\\` are left untouched by a rebuild.

## Sealing: binding this folder to this PC

Run ONCE on the machine that will run the connector:

    node seal.mjs

It encrypts the application and the secrets with AES-256-GCM and hands the key
to Windows DPAPI, which holds it against this machine. Afterwards:

    dist\\app.enc    the application, encrypted
    .env.enc        the secrets, encrypted
    dist\\app.key    the key, wrapped by DPAPI — unusable on any other PC
    dist\\index.js   the loader that undoes all three at startup

Then DELETE \`.env\`. Its values live in \`.env.enc\` now, and leaving the
plaintext beside the encrypted copy defeats the whole exercise.

Nothing about starting or stopping changes: \`magic\\magic-start.bat\` as always.
Unattended restart still works — no key is typed, so the watchdog, the logon
entry and a reboot all behave exactly as before.

**Seal each machine separately.** A sealed folder copied to another PC will not
start; it prints what to do and exits 1. To move it, copy the folder and run
\`node seal.mjs\` there.

## What this protection is, and what it is not

It genuinely stops one thing: a copied folder is useless anywhere else. The key
is not in the folder in any usable form.

It does NOT keep the code from someone with administrator rights on THIS PC.
They can ask DPAPI to unwrap the key exactly as the loader does. No scheme can
prevent that while the connector still has to start by itself at 3am with nobody
logged in — the key has to be reachable without a human, and whatever the
program can reach, a person on that machine can reach.

So: a real deterrent and a real barrier to redistribution, not secrecy. The
controls that carry the weight are still filesystem permissions on this folder
and not handing it out.
`;
}
