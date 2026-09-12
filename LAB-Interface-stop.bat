@echo off
rem ===========================================================================
rem  LAB-Interface - deliberate stop.
rem
rem  The analyzer sockets close and the spool is flushed on SIGTERM (PM2 allows
rem  8s, see kill_timeout in ecosystem.config.cjs). Results already spooled stay
rem  on disk and are delivered when it next starts - stopping never loses them.
rem
rem  This is the ONLY way to put the connector down and have it stay down. It
rem  writes a .lab-interface-maintenance flag that the watchdog honours; killing the
rem  process any other way just gets it restarted, which is the point.
rem
rem  Start it again with LAB-Interface.bat - that clears the flag.
rem
rem  The logon entry and the watchdog task are left in place. Use
rem  LAB-Interface-remove-startup.bat to unregister those as well.
rem ===========================================================================
setlocal
title LAB-Interface - stop
cd /d "%~dp0"

where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

rem Raise the flag BEFORE stopping, so a watchdog tick landing in the middle of
rem the stop does not immediately start it again.
echo Stopped by LAB-Interface-stop.bat on %DATE% %TIME%> "%~dp0.lab-interface-maintenance"

call pm2 describe LAB-Interface >nul 2>&1
if errorlevel 1 goto not_running

echo  stopping...
call pm2 stop LAB-Interface

rem Record the stopped state, so a logon does not resurrect it behind your back.
call pm2 save

echo.
call pm2 list
echo.
echo  ==========================================================
echo   LAB-Interface is stopped and will STAY stopped.
echo   Start it again with LAB-Interface.bat
echo  ==========================================================
echo.
pause
exit /b 0

:not_running
echo  LAB-Interface is not registered with PM2 - nothing to stop.
echo  (the maintenance flag was still set, so the watchdog will leave it alone)
echo.
pause
exit /b 0

:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo.
pause
exit /b 1
