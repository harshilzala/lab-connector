@echo off
rem ===========================================================================
rem  Lab-Interface - deliberate stop.
rem
rem  The analyzer sockets close and the spool is flushed on SIGTERM (PM2 allows
rem  8s, see kill_timeout in ecosystem.config.cjs). Results already spooled stay
rem  on disk and are delivered when it next starts - stopping never loses them.
rem
rem  This is the ONLY way to put the connector down and have it stay down. It
rem  writes a .lab-maintenance flag that the watchdog honours; killing the
rem  process any other way just gets it restarted, which is the point.
rem
rem  Start it again with Lab-Interface.bat - that clears the flag.
rem
rem  The logon entry and the watchdog task are left in place. Use
rem  Lab-Interface-remove-startup.bat to unregister those as well.
rem ===========================================================================
setlocal
title Lab-Interface - stop
cd /d "%~dp0"

rem Same PM2 home as Lab-Interface.bat - beside the connector, writable by
rem every operator - so this stops without "Run as administrator". See the long
rem note in Lab-Interface.bat for why the machine-wide home is not used.
set "PM2_HOME=%~dp0.pm2"

where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

rem Raise the flag BEFORE stopping, so a watchdog tick landing in the middle of
rem the stop does not immediately start it again.
echo Stopped by Lab-Interface-stop.bat on %DATE% %TIME%> "%~dp0.lab-maintenance"

call pm2 describe Lab-Interface >nul 2>&1
if errorlevel 1 goto not_running

echo  stopping...
call pm2 stop Lab-Interface

rem Record the stopped state, so a logon does not resurrect it behind your back.
call pm2 save

echo.
call pm2 list
echo.
echo  ==========================================================
echo   Lab-Interface is stopped and will STAY stopped.
echo   Start it again with Lab-Interface.bat
echo  ==========================================================
echo.
pause
exit /b 0

:not_running
echo  Lab-Interface is not registered with PM2 - nothing to stop here.
echo  (the maintenance flag was still set, so the watchdog will leave it alone)
echo.
echo  NOTE: "not registered with PM2" does not mean "not running". If someone
echo        started it by hand (node dist\index.js) it is still up and PM2
echo        cannot see it. Use Lab-Interface-force-stop.bat - that stops the
echo        connector however it was started.
echo.
pause
exit /b 0

:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo.
pause
exit /b 1
