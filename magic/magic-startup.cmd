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
rem  It runs the connector under PM2, as the operator, from the PM2 home beside
rem  the connector - nothing here needs administrator rights. It never starts a
rem  second copy beside one that is already up, however that one was started.
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

rem ---------------------------------------------------------------------------
rem  Is a connector already up, however it was started? PM2's view below only
rem  covers what PM2 started; the Windows service, or an "npm run dev" from a
rem  terminal, is invisible to it - and a second copy would fight the first for
rem  the analyzer ports and post to HMIS twice. The admin dashboard port is the
rem  one thing every copy binds. Keep this in step with admin.port in config.json.
rem ---------------------------------------------------------------------------
rem  Full paths: a PATH that puts a Unix "find" first (Git for Windows) would
rem  otherwise break this check and let a second copy start.
"%SystemRoot%\System32\netstat.exe" -ano -p tcp | "%SystemRoot%\System32\find.exe" "LISTENING" | "%SystemRoot%\System32\find.exe" ":7071" >nul 2>&1
if not errorlevel 1 exit /b 0

rem ---------------------------------------------------------------------------
rem  PM2 only, as the operator. The LAB-Interface Windows service may still be
rem  installed on this PC (stopped, start type Manual) but it is NOT used from
rem  here: starting it needs administrator rights the operator account does
rem  not have, so a worker that tried would fail at every tick and never bring
rem  the connector back. If an administrator does start the service, the port
rem  check above sees it and this worker does nothing - one copy only.
rem ---------------------------------------------------------------------------
where pm2 >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "ecosystem.config.cjs" exit /b 1
if not exist "dist\index.js" exit /b 1

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
