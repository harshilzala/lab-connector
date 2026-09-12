@echo off
rem ===========================================================================
rem  magic-stop  -  stop the lab connector.  (double-click this)
rem
rem  Results already in the spool stay on disk and are delivered the next time
rem  it starts - stopping never loses a result. The analyzer sockets close and
rem  the spool is flushed on SIGTERM (PM2 allows 8s, see kill_timeout in
rem  ecosystem.config.cjs).
rem
rem  This is the ONLY way to put the connector down and have it STAY down. PM2
rem  restarts anything that exits without a deliberate `pm2 stop`, and a
rem  watchdog task checks every 5 minutes - so killing the process any other
rem  way just gets it started again. That is the point of it.
rem
rem  Start it again with magic-start.bat
rem ===========================================================================
setlocal
title magic-stop

rem Work from the connector root - see the note in magic-start.bat.
cd /d "%~dp0.." || goto no_root
set "ROOT=%CD%"

rem The same PM2 home the start script and Lab-Interface.bat use. Pointing
rem somewhere else here would mean talking to a daemon that has never heard of
rem this app, and reporting "nothing to stop" while it kept running.
set "PM2_HOME=%ROOT%\.pm2"

where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

rem ---------------------------------------------------------------------------
rem  Raise the maintenance flag BEFORE stopping, not after: the watchdog fires
rem  on a 5-minute tick that can land in the middle of the stop, and would
rem  start the connector again a second after it went down.
rem
rem  It is the same flag file the existing Lab-Interface scripts use, on
rem  purpose. A second flag of our own would leave that watchdog none the wiser.
rem ---------------------------------------------------------------------------
echo Stopped by magic-stop.bat on %DATE% %TIME%> ".lab-maintenance"

call pm2 describe Lab-Interface >nul 2>&1
if errorlevel 1 goto not_registered

echo  stopping...
call pm2 stop Lab-Interface

rem Record the stopped state, so a logon does not resurrect it behind your back.
call pm2 save >nul 2>&1

echo.
call pm2 list
echo.
echo  ==========================================================
echo   Lab-Interface is stopped and will STAY stopped.
echo   Start it again with magic-start.bat
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:not_registered
echo.
echo  Lab-Interface is not registered with PM2 - nothing to stop here.
echo  The maintenance flag was still raised, so the watchdog will leave it be.
echo.
echo  NOTE: "not registered with PM2" is not the same as "not running". If
echo        someone started it by hand with  node dist\index.js  then it is
echo        still up and PM2 cannot see it. Use Lab-Interface-force-stop.bat
echo        in the folder above - that stops it however it was started.
echo.
pause
exit /b 0

:no_root
echo  ERROR: could not find the connector folder above this one.
echo         Keep the magic folder inside the connector directory.
echo.
pause
exit /b 1

:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo.
pause
exit /b 1
