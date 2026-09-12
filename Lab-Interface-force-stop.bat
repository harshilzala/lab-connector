@echo off
rem ===========================================================================
rem  Lab-Interface - force stop  (double-click this)
rem
rem  Stops the connector no matter how it was started:
rem
rem    * under PM2 as Lab-Interface - the normal case, Lab-Interface.bat
rem    * under the retired PM2 name "lab-connector"
rem    * as a bare "node dist\index.js" started from a console, which PM2 knows
rem      nothing about. Lab-Interface-stop.bat cannot stop one of those - it
rem      reports "nothing to stop" while the connector is still running, still
rem      holding the analyzer ports and still posting to HMIS.
rem
rem  Like Lab-Interface-stop.bat it raises the .lab-maintenance flag first,
rem  so the 5-minute watchdog does not start it again behind the stop. This is
rem  a deliberate stop: it stays down until Lab-Interface.bat is run.
rem
rem  Analyzer results already written to .\spool stay on disk and are delivered
rem  when the connector next starts - stopping never loses them.
rem
rem  The work is done by Lab-Interface-force-stop.ps1 next to this file; the
rem  two ship together. Pass -KeepWatchdogArmed there for a bounce instead of a
rem  stop.
rem ===========================================================================
setlocal
title Lab-Interface - force stop
cd /d "%~dp0"

if not exist "%~dp0Lab-Interface-force-stop.ps1" goto no_script

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Lab-Interface-force-stop.ps1"
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%

:no_script
echo.
echo  ERROR: Lab-Interface-force-stop.ps1 is missing from
echo         %~dp0
echo  Both files ship together - restore it from the repository.
echo.
pause
exit /b 1
