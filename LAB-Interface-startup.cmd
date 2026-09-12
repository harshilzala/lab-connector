@echo off
rem ===========================================================================
rem  LAB-Interface - unattended keep-alive.
rem
rem  Two callers, same job:
rem    * the "LAB-Interface.lnk" shortcut in the Startup folder, at logon
rem    * the "LAB-Interface Watchdog" scheduled task, every 5 minutes -
rem      via LAB-Interface-startup-hidden.vbs, so no console window flashes
rem
rem  Not meant to be double-clicked - use LAB-Interface.bat for that.
rem
rem  It brings the connector up if, and only if, it is not already up:
rem
rem    1. If .lab-interface-maintenance exists, someone stopped the connector on
rem       purpose with LAB-Interface-stop.bat. Leave it alone.
rem    2. If PM2 already reports it online, do nothing.
rem    3. Otherwise `pm2 resurrect` (restores the last saved list), and if the
rem       entry still is not there - missing dump, PM2 reinstalled, fresh
rem       machine - start it from the ecosystem file instead. A reboot must
rem       never leave the lab without a connector.
rem ===========================================================================
cd /d "%~dp0"

rem ---- 0. service mode wins -------------------------------------------------
rem  The connector runs as the LAB-Interface Windows service since 2026-09-08.
rem  Never start a PM2 copy beside it.
sc query LAB-Interface >nul 2>&1
if not errorlevel 1 exit /b 0

rem ---- 1. deliberate stop wins ----------------------------------------------
if exist "%~dp0.lab-interface-maintenance" exit /b 0

rem ---- 2. already running? --------------------------------------------------
rem  `pm2 pid <name>` prints the OS pid and exits 0 only when the app is
rem  online; it prints nothing for a stopped or unknown app. That makes it a
rem  cheaper and more honest liveness check than parsing `pm2 list`.
for /f "usebackq tokens=* delims=" %%p in (`pm2 pid LAB-Interface 2^>nul`) do (
  if not "%%p"=="" if not "%%p"=="0" exit /b 0
)

rem ---- 3. bring it up ------------------------------------------------------
call pm2 resurrect >nul 2>&1

call pm2 describe LAB-Interface >nul 2>&1
if errorlevel 1 (
  call pm2 start "%~dp0ecosystem.config.cjs" >nul 2>&1
) else (
  rem Registered but not online - resurrect restored it in a stopped state.
  call pm2 start LAB-Interface >nul 2>&1
)

call pm2 save >nul 2>&1
exit /b 0
