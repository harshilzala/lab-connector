@echo off
rem ===========================================================================
rem  Lab-Interface - unattended keep-alive.
rem
rem  Two callers, same job:
rem    * the "Lab-Interface.lnk" shortcut in the Startup folder, at logon
rem    * the "Lab-Interface Watchdog" scheduled task, every 5 minutes -
rem      via Lab-Interface-startup-hidden.vbs, so no console window flashes
rem
rem  Not meant to be double-clicked - use Lab-Interface.bat for that.
rem
rem  It brings the connector up if, and only if, it is not already up:
rem
rem    1. If .lab-maintenance exists, someone stopped the connector on
rem       purpose with Lab-Interface-stop.bat. Leave it alone.
rem    2. If PM2 already reports it online, do nothing.
rem    3. Otherwise `pm2 resurrect` (restores the last saved list), and if the
rem       entry still is not there - missing dump, PM2 reinstalled, fresh
rem       machine - start it from the ecosystem file instead. A reboot must
rem       never leave the lab without a connector.
rem ===========================================================================
cd /d "%~dp0"

rem Same PM2 home as Lab-Interface.bat - beside the connector, writable by
rem every operator, so the watchdog works from any session without elevation.
set "PM2_HOME=%~dp0.pm2"

rem ---- 1. deliberate stop wins ----------------------------------------------
if exist "%~dp0.lab-maintenance" exit /b 0

rem ---- 1b. is a connector already up, whoever started it? -------------------
rem  The PM2 check below only sees THIS session's PM2. A connector started by
rem  another operator, or by the machine-wide LocalSystem PM2 service, is
rem  invisible to it - and starting a second one would have two processes
rem  fighting over the analyzer ports and both posting to HMIS.
rem
rem  The admin dashboard port is the reliable machine-wide answer: exactly one
rem  connector can hold it. If something is listening, this tick is done.
rem  Keep this in step with admin.port in config.json.
netstat -ano -p tcp | find "LISTENING" | find ":7071" >nul 2>&1
if not errorlevel 1 exit /b 0

rem ---- 2. already running? --------------------------------------------------
rem  `pm2 pid <name>` prints the OS pid and exits 0 only when the app is
rem  online; it prints nothing for a stopped or unknown app. That makes it a
rem  cheaper and more honest liveness check than parsing `pm2 list`.
for /f "usebackq tokens=* delims=" %%p in (`pm2 pid Lab-Interface 2^>nul`) do (
  if not "%%p"=="" if not "%%p"=="0" exit /b 0
)

rem ---- 3. bring it up ------------------------------------------------------
call pm2 resurrect >nul 2>&1

call pm2 describe Lab-Interface >nul 2>&1
if errorlevel 1 (
  call pm2 start "%~dp0ecosystem.config.cjs" >nul 2>&1
) else (
  rem Registered but not online - resurrect restored it in a stopped state.
  call pm2 start Lab-Interface >nul 2>&1
)

call pm2 save >nul 2>&1
exit /b 0
