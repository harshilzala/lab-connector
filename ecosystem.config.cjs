// PM2 process definition for Lab-Interface — the HMIS lab connector.
//
// This file is .cjs (not .js) on purpose: package.json sets "type": "module",
// so a plain .js file is treated as ESM and `module.exports` would throw. PM2
// reads CommonJS config, hence the .cjs extension.
//
// Day to day this is driven by Lab-Interface.bat (start/redeploy) and
// Lab-Interface-stop.bat (stop), not by the npm scripts below.
//
// Build + start together:   npm run pm2:start      (tsc, then pm2 start this)
// Redeploy after edits:     npm run pm2:restart    (tsc, then pm2 restart)
// Tail logs:                npm run pm2:logs
//
// PM2 runs the COMPILED entry (dist/index.js) — always build before starting.

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'Lab-Interface',
      script: path.join(__dirname, 'dist', 'index.js'),
      cwd: __dirname,

      // Single stateful process. It binds the analyzer TCP ports (3010/3011)
      // and the local admin server; cluster mode would have N workers fight
      // over those ports. Keep it fork / 1 instance.
      exec_mode: 'fork',
      instances: 1,

      // dist/index.js is ESM; the system node handles that via package "type".
      interpreter: 'node',

      autorestart: true,
      watch: false,

      // This is unattended lab equipment: it has to come back on its own after
      // a crash AND after someone kills the process by hand. PM2 covers both —
      // every exit that is not a deliberate `pm2 stop` is restarted.
      //
      // A start that cannot stay up 10s counts as a failed start and is retried
      // after a delay rather than hammered. The ceiling is deliberately high
      // (not PM2's default 10) so a transient fault — the analyzer switch down
      // overnight, the network not up yet at logon — never parks the connector
      // permanently. If PM2 ever does give up entirely, the Lab-Interface
      // watchdog scheduled task brings it back within 5 minutes.
      min_uptime: 10000,
      max_restarts: 1000,
      restart_delay: 5000,

      // The app closes sockets + flushes the spool on SIGTERM (see index.ts).
      // Give it room before PM2 SIGKILLs.
      kill_timeout: 8000,

      env: {
        NODE_ENV: 'production',
        // config.json and .env in cwd are picked up by default. Uncomment to
        // point elsewhere:
        // LAB_CONNECTOR_CONFIG: path.join(__dirname, 'config.json'),
        // LAB_CONNECTOR_ENV: path.join(__dirname, '.env'),
      },

      // Timestamped, merged stdout/stderr under ./logs (gitignored).
      time: true,
      merge_logs: true,
      out_file: path.join(__dirname, 'logs', 'lab-interface.out.log'),
      error_file: path.join(__dirname, 'logs', 'lab-interface.err.log'),
    },
  ],
};
