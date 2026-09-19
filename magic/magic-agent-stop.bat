@echo off
rem ===========================================================================
rem  magic-agent-stop  -  stop the Lab-Watch-Agent now.  (double-click)
rem
rem  Removes the agent from PM2 so it does not come back. The connector itself
rem  (Lab-Interface) is NOT touched - stopping the watch never stops the
rem  interface. The reports it wrote stay in logs\agent-watch-*.log.
rem ===========================================================================
setlocal
title magic-agent-stop
cd /d "%~dp0.." || goto no_root
set "PM2_HOME=%CD%\.pm2"

where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

call pm2 describe Lab-Watch-Agent >nul 2>&1
if errorlevel 1 goto not_running

call pm2 delete Lab-Watch-Agent
echo Stopped by magic-agent-stop.bat on %DATE% %TIME%>> "logs\agent-runner.log"
echo.
echo  Lab-Watch-Agent stopped. Lab-Interface keeps running.
echo.
pause
exit /b 0

:not_running
echo.
echo  Lab-Watch-Agent is not running (either never started, or its 48 hours
echo  are over and it exited on its own). Nothing to stop.
echo.
pause
exit /b 0
:no_pm2
echo  ERROR: PM2 was not found on PATH.
pause
exit /b 1
:no_root
echo  ERROR: could not find the connector folder above this one.
pause
exit /b 1
