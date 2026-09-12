# magic — start and stop the lab connector

Four double-clickable scripts. Nothing here needs **Run as administrator**.

| Script | What it does |
|---|---|
| `magic-start.bat` | Starts the connector under PM2. If it is already registered, restarts it — so this is also how you redeploy after a code change. |
| `magic-stop.bat` | Stops it, and makes it **stay** stopped. |
| `magic-add-to-startup.bat` | Run once. The connector then starts at Windows logon and is checked every 5 minutes. |
| `magic-remove-from-startup.bat` | Undoes the above. |

`magic-startup.cmd` is the worker the logon entry and the watchdog run. It is
not meant to be double-clicked — it never pauses and never builds.

Dashboard: **http://127.0.0.1:7071** · Live logs: `pm2 logs Lab-Interface`

## Two things worth knowing

**Stopping it takes the stop script.** PM2 restarts anything that exits without
a deliberate `pm2 stop`, and the watchdog checks every 5 minutes, so killing the
process from Task Manager just gets it started again. `magic-stop.bat` raises a
`.lab-maintenance` flag in the connector folder that tells the watchdog to stand
aside; `magic-start.bat` clears it again. That is the whole mechanism — if you
ever find the connector refusing to start on its own, look for that file.

**Stopping never loses a result.** Anything already in the spool stays on disk
and is delivered when it next starts. The analyzer sockets close cleanly on
SIGTERM (PM2 allows 8 seconds; see `kill_timeout` in `ecosystem.config.cjs`).

## Where the connector actually lives

These scripts drive the folder **above** this one. They set `PM2_HOME` to
`..\.pm2` — deliberately not the machine-wide `C:\ProgramData\pm2\home`, which
belongs to the LocalSystem PM2 service and grants ordinary users read access
only. Pointing PM2 there is what used to force "Run as administrator" and leak
half-started daemons.

They also share the `Lab-Interface` PM2 name, the same `PM2_HOME` and the same
`.lab-maintenance` flag as the older `Lab-Interface-*.bat` scripts in the folder
above, so the two sets agree about what is running. They are alternatives, not
rivals — use whichever you prefer.

## If something goes wrong

**"PM2 was not found on PATH"** — install it once: `npm install -g pm2`.

**An error mentioning `EPERM` or a pipe** — the machine-wide *PM2* Windows
service is running and owns the daemon. On Windows, PM2's daemon sockets are the
fixed pipes `\\.\pipe\rpc.sock` and `\\.\pipe\pub.sock`, not derived from
`PM2_HOME`, so while that service runs no ordinary session can reach a daemon of
its own. Remove it once from an elevated prompt:

```
sc.exe stop pm2.exe
sc.exe delete pm2.exe
```

Then run `magic-start.bat` as yourself. The trade-off: that service is what
starts the connector at **boot** with nobody logged on. Without it, the logon
entry and watchdog start it when an operator signs in. If unattended boot
matters more than avoiding elevation, keep the service instead.

**"not registered with PM2" when stopping** — that is not the same as "not
running". If someone started it by hand with `node dist\index.js`, PM2 cannot
see it. Use `Lab-Interface-force-stop.bat` in the folder above, which stops it
however it was started.
