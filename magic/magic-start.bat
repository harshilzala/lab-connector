@echo off
rem ===========================================================================
rem  magic-start  -  start the lab connector under PM2.  (double-click this)
rem
rem  Starts the app PM2 knows as "Lab-Interface". If it is already registered
rem  this restarts it, so running this after a code change redeploys.
rem
rem  Pass /build to force a rebuild first:   magic-start.bat /build
rem  (a build happens automatically when dist\index.js is missing).
rem
rem  Safe to run repeatedly. Needs no "Run as administrator".
rem  Stop it again with magic-stop.bat
rem ===========================================================================
setlocal
title magic-start

rem ---------------------------------------------------------------------------
rem  This script lives in <connector>\magic\, but everything it drives lives one
rem  level up: package.json, ecosystem.config.cjs and the .pm2 home are all in
rem  the connector root. Work from there, however the script was launched.
rem ---------------------------------------------------------------------------
cd /d "%~dp0.." || goto no_root
set "ROOT=%CD%"

rem ---------------------------------------------------------------------------
rem  PM2 home - the SAME one Lab-Interface.bat uses, beside the connector rather
rem  than the machine-wide C:\ProgramData\pm2\home.
rem
rem  This is not a detail. The machine-wide home belongs to the LocalSystem PM2
rem  service and grants Users read only, so an unelevated pm2 cannot write
rem  pm2.pid there - every call dies with EPERM and leaks a half-started daemon.
rem  Pointing at a different home from the other scripts would be worse still:
rem  PM2 would look in one place while Lab-Interface.bat looked in another, and
rem  the two would each think the connector was not running.
rem ---------------------------------------------------------------------------
set "PM2_HOME=%ROOT%\.pm2"
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%" >nul 2>&1

echo.
echo  ==========================================================
echo   magic-start   -   HMIS lab connector
echo   folder: %ROOT%
echo  ==========================================================
echo.

rem ---- prerequisites --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto no_node
where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2
if not exist "ecosystem.config.cjs" goto no_ecosystem
if not exist "config.json" goto no_config

rem ---------------------------------------------------------------------------
rem  One copy only. The LAB-Interface Windows service may still be installed on
rem  this PC (left stopped, start type Manual - the operator account cannot
rem  start it and does not need to). It is only a problem if an administrator
rem  has it RUNNING right now: a PM2 copy beside it would fight for the analyzer
rem  and dashboard ports and crash-loop on EADDRINUSE. Refuse in that one case;
rem  an installed-but-stopped service is ignored and PM2 runs as the operator.
rem ---------------------------------------------------------------------------
sc query LAB-Interface 2>nul | "%SystemRoot%\System32\find.exe" "RUNNING" >nul 2>&1
if not errorlevel 1 goto service_running

rem ---------------------------------------------------------------------------
rem  Clear the maintenance flag. magic-stop.bat and Lab-Interface-stop.bat both
rem  raise it to tell the 5-minute watchdog "this is down on purpose". Starting
rem  by hand means the opposite, so the flag has to go or the watchdog would
rem  keep standing aside the next time the app fell over.
rem ---------------------------------------------------------------------------
if exist ".lab-maintenance" del ".lab-maintenance" >nul 2>&1

rem ---- build ----------------------------------------------------------------
if /I "%~1"=="/build" goto build
if not exist "dist\index.js" goto build
echo  [1/4] using the existing build in dist\
echo        run  magic-start.bat /build  to recompile first
goto start_app

:build
echo  [1/4] building...
if not exist "node_modules\typescript\package.json" call npm install
call npm run build
if errorlevel 1 goto build_failed
if not exist "logs" mkdir "logs"

:start_app
echo  [2/4] starting under PM2 as Lab-Interface...
call pm2 describe Lab-Interface >nul 2>&1
if errorlevel 1 goto fresh_start
call pm2 restart ecosystem.config.cjs --update-env
if errorlevel 1 goto pm2_failed
goto save

:fresh_start
call pm2 start ecosystem.config.cjs
if errorlevel 1 goto pm2_failed

:save
rem `pm2 save` writes the dump that `pm2 resurrect` reads at logon. Without it
rem the startup entry would come up and find nothing to bring back.
echo  [3/4] saving the PM2 process list...
call pm2 save >nul 2>&1

rem ---------------------------------------------------------------------------
rem  Logon entry + 5-minute watchdog, every start. magic-add-to-startup.bat
rem  does the work (/quiet: no banner, no pause). Re-running it is what brings
rem  the watchdog task back after magic-force-stop.bat disabled it - the task
rem  is re-created with /F, which also re-enables it. Everything it registers
rem  is per-operator and needs no administrator rights.
rem ---------------------------------------------------------------------------
echo  [4/4] registering the logon entry and the 5-minute watchdog...
if exist "%~dp0magic-add-to-startup.bat" call "%~dp0magic-add-to-startup.bat" /quiet

echo.
call pm2 list
echo.
echo  ==========================================================
echo   Lab-Interface is running.
echo.
echo   Dashboard : http://127.0.0.1:7071
echo   Live logs : pm2 logs Lab-Interface
echo   Stop      : magic-stop.bat  (everything: magic-force-stop.bat)
echo   Comes back after a crash, a logoff/logon and a reboot
echo   (once an operator signs in); checked every 5 minutes.
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:no_root
echo  ERROR: could not find the connector folder above this one.
echo         Keep the magic folder inside the connector directory.
echo.
pause
exit /b 1

:no_node
echo  ERROR: Node.js was not found on PATH.
echo         Install Node 20 or newer, then run this again.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------------
:service_running
echo  The LAB-Interface Windows service is RUNNING right now, so the connector
echo  is already up - not starting a second copy under PM2 (two copies would
echo  fight for the same ports).
echo.
echo   Dashboard: http://127.0.0.1:7071
echo   Logs     : logs\LAB-Interface-service.out.log
echo.
echo  The operator account cannot stop or start that service; only an
echo  administrator can (sc stop LAB-Interface). Once it is stopped, run this
echo  script again and the connector runs under PM2 as the operator.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------------
:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo         Install it once with:   npm install -g pm2
echo.
pause
exit /b 1

:no_ecosystem
echo  ERROR: ecosystem.config.cjs is not in %ROOT%.
echo         This script must sit in a folder directly inside the connector.
echo.
pause
exit /b 1

:no_config
echo  ERROR: config.json is missing from %ROOT%.
echo         Copy config.example.json to config.json and edit it first.
echo.
pause
exit /b 1

:build_failed
echo.
echo  BUILD FAILED - the connector was NOT started.
echo  Fix the errors above and run this again.
echo.
pause
exit /b 1

:pm2_failed
echo.
echo  PM2 could not start the connector.
echo.
echo  If the error mentions EPERM or a pipe, the machine-wide "PM2" service is
echo  probably running and owns the daemon. Remove it ONCE from an elevated
echo  prompt, then run this again as yourself:
echo      sc.exe stop pm2.exe
echo      sc.exe delete pm2.exe
echo.
pause
exit /b 1
