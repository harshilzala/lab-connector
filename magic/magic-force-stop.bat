@echo off
rem ===========================================================================
rem  magic-force-stop  -  stop EVERYTHING, however it was started.
rem                       (double-click this)
rem
rem  Use magic-stop.bat first. It is the gentle one, and on a machine where the
rem  connector runs under PM2 it is all you need.
rem
rem  This one is for the case magic-stop.bat cannot handle: the connector is
rem  installed as a Windows SERVICE (LAB-Interface, run by WinSW as
rem  LocalSystem). PM2 knows nothing about that service, so magic-stop.bat
rem  reports "not registered with PM2 - nothing to stop" and the connector
rem  keeps running: still bound to the analyzer ports, still posting to HMIS.
rem
rem  Killing its node process from Task Manager does not work either. The
rem  Service Control Manager reads that as a crash and starts it again ten
rem  seconds later - which is why "npm run dev" kept losing port 3010 to a
rem  connector nobody thought was running.
rem
rem  What this stops, in one go:
rem    * the 5-minute watchdog tasks (both the "magic Lab Connector Watchdog"
rem      one this folder registers and the older "Lab-Interface Watchdog" one),
rem      and any watchdog worker running at that moment;
rem    * the LAB-Interface Windows service - a clean SCM stop, and its start
rem      type set to Manual so a reboot does not bring it back;
rem    * the PM2 apps, if PM2 has any;
rem    * any node still on dist\index.js or holding the dashboard port,
rem      including a stray "npm run dev".
rem
rem  It raises the same .lab-maintenance flag magic-stop.bat uses, so nothing
rem  restarts it behind your back.
rem
rem  It never asks for administrator rights. Everything the operator account
rem  owns - the PM2 app, the watchdog task, the logon entry's worker, a stray
rem  "npm run dev" - is stopped as the operator. The one thing a standard user
rem  cannot touch is the LAB-Interface Windows service: it is normally left
rem  stopped (start type Manual) on this PC, and if an administrator has it
rem  running, this script says so and leaves it to them.
rem
rem  Results already in the spool stay on disk and are delivered when the
rem  connector next starts - stopping never loses a result.
rem
rem  Start it again with magic-start.bat - it clears the flag, starts PM2 and
rem  re-registers the logon entry and the watchdog.
rem ===========================================================================
setlocal
title magic-force-stop

rem Work from the connector root - see the note in magic-start.bat.
cd /d "%~dp0.." || goto no_root
set "ROOT=%CD%"

rem ---------------------------------------------------------------------------
rem  One engine, two front doors. The real work lives in
rem  Lab-Interface-force-stop.ps1 in the folder above, which is also what
rem  Lab-Interface-force-stop.bat runs. Duplicating that logic here would mean
rem  two force-stops that drift apart, and a machine where one of them misses
rem  the thing that is actually holding the port.
rem ---------------------------------------------------------------------------
set "ENGINE=%ROOT%\Lab-Interface-force-stop.ps1"
if not exist "%ENGINE%" goto no_engine

rem -NoElevate: run as the operator, start to finish. Never a UAC prompt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ENGINE%" -NoElevate
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" goto trouble

echo  ==========================================================
echo   Everything is stopped, and will STAY stopped.
echo   Start it again with magic-start.bat
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:trouble
echo  ==========================================================
echo   Something survived the stop - read the messages above.
echo.
echo   Most common cause: an administrator started the LAB-Interface
echo   Windows service, which a standard user cannot stop. Ask an
echo   administrator to run:  sc stop LAB-Interface
echo  ==========================================================
echo.
pause
exit /b %RC%

:no_engine
echo.
echo  ERROR: Lab-Interface-force-stop.ps1 is missing from
echo         %ROOT%
echo  That script is the engine this wrapper drives - restore it from
echo  the repository.
echo.
pause
exit /b 1

:no_root
echo  ERROR: could not find the connector folder above this one.
echo         Keep the magic folder inside the connector directory.
echo.
pause
exit /b 1
