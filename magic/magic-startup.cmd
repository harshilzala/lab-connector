@echo off
rem ===========================================================================
rem  magic-startup  -  the unattended worker. NOT for double-clicking.
rem
rem  This is what the logon entry runs. It differs from magic-start.bat in the
rem  three ways an unattended run has to:
rem
rem    * it never pauses and never asks anything - nothing is there to answer;
rem    * it never builds - a compile failure at logon would leave the lab with
rem      no connector and a console full of TypeScript errors nobody reads;
rem    * it honours the maintenance flag, so a machine that was deliberately
rem      stopped for service does not quietly start itself at the next logon.
rem
rem  It is also idempotent: if the connector is already online it does nothing,
rem  which is what makes it safe to run from a 5-minute watchdog as well.
rem
rem  Install it with magic-add-to-startup.bat
rem ===========================================================================
setlocal

cd /d "%~dp0.." || exit /b 1
set "ROOT=%CD%"
set "PM2_HOME=%ROOT%\.pm2"
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%" >nul 2>&1

rem Somebody stopped this on purpose. Leave it alone.
if exist ".lab-maintenance" exit /b 0

where pm2 >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "ecosystem.config.cjs" exit /b 1
if not exist "dist\index.js" exit /b 1

rem ---------------------------------------------------------------------------
rem  Is a connector already up, whoever started it? Exactly one connector can
rem  hold the admin dashboard port, so if something listens there this tick is
rem  done - without touching pm2 at all. Keep in step with admin.port in
rem  config.json (and with Lab-Interface-startup.cmd).
rem ---------------------------------------------------------------------------
netstat -ano -p tcp | find "LISTENING" | find ":7071" >nul 2>&1
if not errorlevel 1 exit /b 0

rem ---------------------------------------------------------------------------
rem  Does ANOTHER PM2 own the daemon pipe? On Windows every PM2 uses the fixed
rem  \\.\pipe\rpc.sock whatever PM2_HOME says. When a PM2 under another account
rem  (e.g. the LocalSystem service) holds it, every pm2 call from here fails to
rem  connect, spawns a fresh Daemon.js that cannot bind the pipe, and that
rem  daemon never exits - one leaked node.exe per tick, hundreds per day.
rem  Pipe present but our own pm2.pid is not a live process = not ours: stop.
rem ---------------------------------------------------------------------------
powershell -NoProfile -NonInteractive -Command "if (-not ([IO.Directory]::GetFiles('\\.\pipe\') -contains '\\.\pipe\rpc.sock')) { exit 1 }; $id = 0; try { $id = [int](Get-Content -Raw '%PM2_HOME%\pm2.pid') } catch {}; if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { exit 1 }; exit 0" >nul 2>&1
if not errorlevel 1 exit /b 0

rem ---------------------------------------------------------------------------
rem  Is it already up? `pm2 pid <name>` prints the process id, or 0 when the
rem  app is registered but stopped, and fails when PM2 has never heard of it.
rem  Checking the pid rather than blindly restarting is what keeps a watchdog
rem  tick from bouncing a perfectly healthy connector every five minutes.
rem ---------------------------------------------------------------------------
set "LIPID="
for /f "usebackq tokens=1" %%p in (`pm2 pid Lab-Interface 2^>nul`) do set "LIPID=%%p"

if not defined LIPID goto fresh_start
if "%LIPID%"=="0" goto start_stopped
rem Already online - nothing to do.
exit /b 0

:start_stopped
call pm2 start Lab-Interface >nul 2>&1
goto done

:fresh_start
call pm2 start ecosystem.config.cjs >nul 2>&1

:done
call pm2 save >nul 2>&1
exit /b 0
