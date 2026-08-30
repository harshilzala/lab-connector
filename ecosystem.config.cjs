// PM2 process definition for the HMIS lab-connector.
//
// This file is .cjs (not .js) on purpose: package.json sets "type": "module",
// so a plain .js file is treated as ESM and `module.exports` would throw. PM2
// reads CommonJS config, hence the .cjs extension.
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
      name: 'lab-connector',
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

      // Back off instead of hammering a genuinely broken start (bad config,
      // port already bound). If it can't stay up 10s, count it as a failure and
      // stop after 10 tries.
      min_uptime: 10000,
      max_restarts: 10,
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
      out_file: path.join(__dirname, 'logs', 'lab-connector.out.log'),
      error_file: path.join(__dirname, 'logs', 'lab-connector.err.log'),
    },
  ],
};
