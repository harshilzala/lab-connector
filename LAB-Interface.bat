@echo off
rem ===========================================================================
rem  LAB-Interface - start / redeploy  (double-click this)
rem
rem  Builds the TypeScript, starts (or restarts) the connector under PM2, saves
rem  the PM2 process list, and registers the two things that keep it alive
rem  without anyone watching:
rem
rem    1. a logon entry   - Windows boots or the user logs on  -> started
rem    2. a watchdog task - checked every 5 minutes            -> restarted if
rem                                                               it is not up
rem
rem  Crashes and hand-killed processes are handled by PM2 itself (autorestart in
rem  ecosystem.config.cjs), usually within a second or two - the watchdog is the
rem  backstop for the cases PM2 cannot cover, such as the PM2 daemon itself
rem  being killed.
rem
rem  Safe to run repeatedly: every step is idempotent. Re-running it after a
rem  code or config change is the normal way to redeploy.
rem ===========================================================================
setlocal
title LAB-Interface - start

rem Always work from the folder this script lives in, however it was launched.
cd /d "%~dp0"

echo.
echo  ==========================================================
echo   LAB-Interface   (HMIS lab connector)
echo   folder: %CD%
echo  ==========================================================
echo.

rem ---- service mode wins -----------------------------------------------------
rem  Since 2026-09-08 the connector runs as the "LAB-Interface" Windows service
rem  (see service\), which starts at boot with nobody logged on and is restarted
rem  by the Service Control Manager. Starting a second copy under PM2 would
rem  fight it for the analyzer and dashboard ports, so refuse while the service
rem  is installed. Redeploy in service mode: build, then restart the service.
sc query LAB-Interface >nul 2>&1
if not errorlevel 1 goto service_mode

rem ---- prerequisites --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto no_node
where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

if not exist "config.json" goto no_config

rem Clear the maintenance flag: starting by hand means "I want this running",
rem so the watchdog is allowed to keep it running from here on.
if exist "%~dp0.lab-interface-maintenance" del "%~dp0.lab-interface-maintenance" >nul 2>&1

rem ---- dependencies ---------------------------------------------------------
if exist "node_modules\typescript\package.json" goto have_deps
echo  [1/6] installing dependencies (first run - this takes a minute)...
call npm install
if errorlevel 1 goto failed
goto build

:have_deps
echo  [1/6] dependencies OK

:build
echo  [2/6] building...
call npm run build
if errorlevel 1 goto failed
if not exist "logs" mkdir "logs"

rem ---- retire the old names --------------------------------------------------
rem  This app used to run under the names "lab-connector" and then
rem  "GENEX-Interface". If either entry is still registered it would bind the
rem  same analyzer ports and fight this one, so remove it before starting. The
rem  old GENEX logon shortcut, watchdog task and maintenance flag go too, so a
rem  machine set up under the previous name does not keep two of everything.
call pm2 describe lab-connector >nul 2>&1
if errorlevel 1 goto retire_genex
echo  [3/6] removing the old "lab-connector" PM2 entry...
call pm2 delete lab-connector >nul 2>&1

:retire_genex
call pm2 describe GENEX-Interface >nul 2>&1
if errorlevel 1 goto retire_genex_startup
echo  [3/6] removing the old "GENEX-Interface" PM2 entry...
call pm2 delete GENEX-Interface >nul 2>&1

:retire_genex_startup
if exist "%~dp0.genex-maintenance" del "%~dp0.genex-maintenance" >nul 2>&1
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\GENEX-Interface.lnk" del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\GENEX-Interface.lnk" >nul 2>&1
schtasks /Query /TN "GENEX-Interface Watchdog" >nul 2>&1
if not errorlevel 1 schtasks /Delete /TN "GENEX-Interface Watchdog" /F >nul 2>&1

:start_app
echo  [3/6] starting under PM2 as LAB-Interface...
call pm2 describe LAB-Interface >nul 2>&1
if errorlevel 1 goto fresh_start
call pm2 restart ecosystem.config.cjs --update-env
if errorlevel 1 goto failed
goto save

:fresh_start
call pm2 start ecosystem.config.cjs
if errorlevel 1 goto failed

:save
rem `pm2 save` writes the dump that `pm2 resurrect` reads at logon. Without
rem this, the startup entry would find nothing to bring back.
echo  [4/6] saving the PM2 process list...
call pm2 save
if errorlevel 1 goto failed

echo  [5/6] registering the logon entry...
call :install_startup

echo  [6/6] registering the 5-minute watchdog...
call :install_watchdog

echo.
call pm2 list
echo.
echo  ==========================================================
echo   LAB-Interface is running.
echo.
echo   Comes back automatically after: a crash, a killed process,
echo   a logon and a reboot.
echo.
echo   Dashboard : http://127.0.0.1:7071
echo   Live logs : pm2 logs LAB-Interface
echo   Stop      : LAB-Interface-stop.bat
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
rem Put a shortcut in the current user's Startup folder pointing at
rem LAB-Interface-startup.cmd. A .lnk (rather than a .vbs) because Startup
rem always allows shortcuts, while Windows Script Host is often policy-blocked
rem on hospital machines. WindowStyle 7 = minimised, so logon is not
rem interrupted by a console window; the script exits on its own in seconds.
rem
rem The old "HMIS Lab Connector.lnk" entry is deleted first so a machine that
rem was set up under the previous name does not end up with two logon entries.
rem ---------------------------------------------------------------------------
:install_startup
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\LAB-Interface.lnk"
if not exist "%STARTUP%" mkdir "%STARTUP%"
if exist "%STARTUP%\HMIS Lab Connector.lnk" del "%STARTUP%\HMIS Lab Connector.lnk" >nul 2>&1
rem Launch through the hidden .vbs (same as the watchdog) so logon does not
rem flash a console window at the operator. Falls back to the .cmd, minimised,
rem when Windows Script Host is policy-blocked.
set "LNKTARGET=%~dp0LAB-Interface-startup.cmd"
set "LNKVBS="
set "LNKMODE=minimised - WSH unavailable"
if not exist "%~dp0LAB-Interface-startup-hidden.vbs" goto make_startup_lnk
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKLM\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto make_startup_lnk
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKCU\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto make_startup_lnk
set "LNKTARGET=%SystemRoot%\System32\wscript.exe"
set "LNKVBS=%~dp0LAB-Interface-startup-hidden.vbs"
set "LNKMODE=hidden"
:make_startup_lnk
rem The .vbs path is quoted with [char]34 inside PowerShell so no double quote
rem has to survive cmd's own parsing of the -Command line.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$s = $w.CreateShortcut('%LNK%');" ^
  "$s.TargetPath = '%LNKTARGET%';" ^
  "$a = ''; if ('%LNKVBS%' -ne '') { $a = '//nologo ' + [char]34 + '%LNKVBS%' + [char]34 };" ^
  "$s.Arguments = $a;" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Starts LAB-Interface under PM2 at logon';" ^
  "$s.Save()"
if errorlevel 1 goto startup_failed
echo        logon entry: %LNK% (%LNKMODE%)
exit /b 0

:startup_failed
echo        WARNING: could not create the logon entry.
echo        The connector is running, but will NOT come back after a reboot.
exit /b 0

rem ---------------------------------------------------------------------------
rem Scheduled task that runs the same startup script every 5 minutes. It only
rem acts when the connector is not online, so the normal case costs nothing.
rem /F replaces an existing task, which makes re-running this script safe.
rem
rem The task runs in the logged-on operator's own session, so pointing it
rem straight at the .cmd gave that session a console window every 5 minutes -
rem a black box flashing on the lab PC's screen all day. It is launched
rem through LAB-Interface-startup-hidden.vbs instead, which runs the same
rem .cmd with window style 0. Same account, same session, same work, no window.
rem
rem Windows Script Host is policy-blocked on some hospital machines. When it
rem is, fall back to registering the .cmd directly: a visible watchdog beats no
rem watchdog on unattended lab equipment.
rem ---------------------------------------------------------------------------
:install_watchdog
set "WDTR=\"%~dp0LAB-Interface-startup.cmd\""
set "WDMODE=visible - WSH unavailable"
if not exist "%~dp0LAB-Interface-startup-hidden.vbs" goto register_watchdog

set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKLM\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto register_watchdog
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKCU\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto register_watchdog

set "WDTR=\"%SystemRoot%\System32\wscript.exe\" //nologo \"%~dp0LAB-Interface-startup-hidden.vbs\""
set "WDMODE=hidden"

:register_watchdog
schtasks /Create /TN "LAB-Interface Watchdog" /TR "%WDTR%" /SC MINUTE /MO 5 /F >nul 2>&1
if errorlevel 1 goto watchdog_failed
echo        watchdog task: LAB-Interface Watchdog (every 5 minutes, %WDMODE%)
exit /b 0

:watchdog_failed
echo        WARNING: could not create the watchdog task.
echo        PM2 still restarts crashes; only the backstop is missing.
exit /b 0

rem ---- error paths ----------------------------------------------------------
:service_mode
echo  LAB-Interface is installed as a Windows service - not starting under PM2.
echo.
echo   Status  : sc query LAB-Interface
echo   Logs    : logs\LAB-Interface-service.out.log
echo   Redeploy: npm run build, then run (as administrator)
echo             service\restart-service.ps1
echo   Dashboard: http://127.0.0.1:7071
echo.
sc query LAB-Interface | findstr STATE
goto stop

:no_node
echo  ERROR: Node.js was not found on PATH.
echo         Install Node 20 or newer from https://nodejs.org and re-run this.
goto stop

:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo         Install it once with:   npm install -g pm2
goto stop

:no_config
echo  ERROR: config.json is missing from %CD%.
echo         Copy config.example.json to config.json and set the analyzers up
echo         for this site before starting.
goto stop

:failed
echo.
echo  ERROR: a step above failed - LAB-Interface was NOT started.
echo         Scroll up for the first error message.

:stop
echo.
pause
exit /b 1
