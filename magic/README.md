# magic — start and stop the lab connector

Five double-clickable scripts. **None of them ever needs "Run as
administrator".** Everything runs as the operator who is signed in, under PM2,
from the PM2 home beside the connector (`..\.pm2`).

| Script | What it does |
|---|---|
| `magic-start.bat` | Builds if needed, starts the connector under PM2 (restarts it if already registered — so this is also how you redeploy after a code change; `magic-start.bat /build` recompiles first), then registers the logon entry and the 5-minute watchdog. |
| `magic-stop.bat` | Stops it, and makes it **stay** stopped: raises the maintenance flag, `pm2 stop`, `pm2 save`. |
| `magic-force-stop.bat` | Stops **everything** the operator owns, however it was started: the PM2 app, the watchdog task, any watchdog worker mid-tick, and any stray `npm run dev` or `node dist\index.js`. Use it when `magic-stop.bat` reports "nothing to stop" but the dashboard still answers. |
| `magic-add-to-startup.bat` | Registers the logon entry and the 5-minute watchdog for this operator. `magic-start.bat` runs it for you; run it by hand only to re-register without starting. |
| `magic-remove-from-startup.bat` | Undoes the above. |

`magic-startup.cmd` is the worker the logon entry and the watchdog run. It is
not meant to be double-clicked — it never pauses and never builds. It is
launched through `magic-startup-hidden.vbs` so no console window flashes on the
lab PC (falls back to a minimised window where Windows Script Host is
policy-blocked).

## The Windows service on this PC

This PC also has the **LAB-Interface Windows service** installed
(`..\service\`). It is **not used** by anything in this folder, and it is left
**stopped with start type Manual**, so it does not come back at boot. A standard
user cannot start, stop or reconfigure a Windows service, and the magic scripts
never try to — that is what used to produce the administrator prompt.

The only time the service matters is if an administrator starts it by hand.
Then `magic-start.bat` refuses to start a PM2 copy beside it (two copies would
fight for the analyzer ports), and `magic-stop.bat` / `magic-force-stop.bat`
tell you it is running and that only an administrator can stop it:

```
sc stop LAB-Interface
sc config LAB-Interface start= demand
```

The `Lab-Interface-*.bat` scripts in the folder above still drive the service
where it is the chosen mode. On this PC, use the magic folder.

## How the pieces agree with each other

- **The maintenance flag.** `magic-stop.bat` and `magic-force-stop.bat` write
  `.lab-maintenance` in the connector folder; the watchdog and the logon entry
  stand aside while it exists; `magic-start.bat` clears it. If the connector
  ever refuses to start on its own, look for that file.
- **The watchdog after a force stop.** `magic-force-stop.bat` *disables* the
  watchdog task as well as raising the flag. `magic-start.bat` re-creates the
  task, which re-enables it.
- **One copy only.** The worker first checks whether anything is already
  listening on the dashboard port (7071). The service, a PM2 copy or an
  `npm run dev` from a terminal all bind it, so the worker never starts a
  second connector beside a running one.
- **Session-bound.** PM2 runs in the operator's session, so a logoff takes the
  connector down with it. The logon entry brings it back at the next sign-in,
  and the watchdog covers anything that dies mid-shift. After a reboot it is
  up as soon as an operator signs in.
- **Stopping never loses a result.** Anything already in the spool stays on
  disk and is delivered when it next starts. The analyzer sockets close cleanly
  on stop (PM2 allows 8 s — `kill_timeout` in `ecosystem.config.cjs`).

Dashboard: **http://127.0.0.1:7071** · Live logs: `pm2 logs Lab-Interface`
(with `PM2_HOME` set to `..\.pm2`, as the scripts do)

## If something goes wrong

**A UAC / administrator prompt appears** — it should not, from any script in
this folder. If it does, the script you ran is one of the `Lab-Interface-*.bat`
scripts in the folder above, which drive the Windows service.

**"The LAB-Interface Windows service is RUNNING"** — an administrator started
the service. Ask them to stop it (commands above); then the magic scripts work
as the operator again.

**"another connector is already running" / port 7071 in use** — someone
started it by hand (`npm run dev`, `node dist\index.js`). Stop that one (Ctrl+C
in its terminal, or `magic-force-stop.bat`), then start again.

**"PM2 was not found on PATH"** — install it once, as the operator:
`npm install -g pm2`.

**An error mentioning `EPERM` or a pipe** — a machine-wide *PM2* Windows
service is running and owns the daemon's fixed pipes. An administrator has to
remove it once (`sc.exe stop pm2.exe`, `sc.exe delete pm2.exe`). This PC has
no such service.
