@echo off
rem ===========================================================================
rem  LAB-Interface - FORCE stop.  (double-click this)
rem
rem  Use this when the ordinary LAB-Interface-stop.bat is not enough: the
rem  connector keeps coming back, PM2 is confused, a stray node process is
rem  holding the analyzer ports, or the machine was set up under one of the
rem  old names (GENEX-Interface / lab-connector) and both are registered.
rem
rem  It takes everything down and makes sure nothing brings it back:
rem
rem    1. raises the maintenance flag        - the watchdog leaves it alone
rem    2. removes the logon shortcuts        - old and new names
rem    3. removes the watchdog tasks         - old and new names
rem    4. stops the Windows service          - if one was ever installed
rem    5. pm2 stop + pm2 delete              - LAB-Interface, GENEX-Interface,
rem                                            lab-connector; then pm2 save
rem    6. kills any node.exe still running   - this folder's dist\index.js
rem    7. checks the listening ports are free
rem
rem  Results already spooled stay on disk and are delivered when it next
rem  starts - stopping never loses them.
rem
rem  Start it again with LAB-Interface.bat - that clears the flag and
rem  re-registers the logon entry and the watchdog.
rem ===========================================================================
setlocal EnableDelayedExpansion
title LAB-Interface - FORCE stop
cd /d "%~dp0"

echo.
echo  ==========================================================
echo   LAB-Interface   FORCE STOP
echo   folder: %CD%
echo  ==========================================================
echo.

rem ---- 1. maintenance flag FIRST ---------------------------------------------
rem  Raised before anything is stopped, so a watchdog tick landing in the middle
rem  of this script does not immediately start it again.
echo Force-stopped by LAB-Interface-force-stop.bat on %DATE% %TIME%> "%~dp0.lab-interface-maintenance"
echo  [1/7] maintenance flag raised

rem ---- 2. logon shortcuts ------------------------------------------------------
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "REMOVED="
for %%n in ("LAB-Interface.lnk" "GENEX-Interface.lnk" "HMIS Lab Connector.lnk") do (
  if exist "%STARTUP%\%%~n" (
    del "%STARTUP%\%%~n" >nul 2>&1
    if exist "%STARTUP%\%%~n" (
      echo        WARNING: could not delete %STARTUP%\%%~n
    ) else (
      set "REMOVED=!REMOVED! %%~n"
    )
  )
)
if defined REMOVED (echo  [2/7] logon entries removed:!REMOVED!) else (echo  [2/7] no logon entries found)

rem ---- 3. watchdog tasks -------------------------------------------------------
set "REMOVED="
for %%t in ("LAB-Interface Watchdog" "GENEX-Interface Watchdog") do (
  schtasks /Query /TN "%%~t" >nul 2>&1
  if not errorlevel 1 (
    schtasks /End /TN "%%~t" >nul 2>&1
    schtasks /Delete /TN "%%~t" /F >nul 2>&1
    if errorlevel 1 (
      echo        WARNING: could not delete task "%%~t" - remove it in Task Scheduler
    ) else (
      set "REMOVED=!REMOVED! "%%~t""
    )
  )
)
if defined REMOVED (echo  [3/7] watchdog tasks removed:!REMOVED!) else (echo  [3/7] no watchdog tasks found)

rem ---- 4. Windows service (only if one was installed) --------------------------
set "REMOVED="
for %%s in (LAB-Interface GENEX-Interface) do (
  sc query "%%s" >nul 2>&1
  if not errorlevel 1 (
    sc stop "%%s" >nul 2>&1
    sc config "%%s" start= demand >nul 2>&1
    set "REMOVED=!REMOVED! %%s"
  )
)
if defined REMOVED (echo  [4/7] Windows service stopped and set to Manual:!REMOVED!) else (echo  [4/7] no Windows service installed)

rem ---- 5. PM2 ----------------------------------------------------------------
where pm2 >nul 2>&1
if errorlevel 1 (
  echo  [5/7] PM2 not on PATH - skipping
  goto kill_strays
)
set "REMOVED="
for %%a in (LAB-Interface GENEX-Interface lab-connector) do (
  call pm2 describe %%a >nul 2>&1
  if not errorlevel 1 (
    call pm2 stop %%a >nul 2>&1
    call pm2 delete %%a >nul 2>&1
    set "REMOVED=!REMOVED! %%a"
  )
)
rem  Save the (now empty) list, so a logon `pm2 resurrect` has nothing to bring
rem  back. --force writes the dump even when no apps are left.
call pm2 save --force >nul 2>&1
if defined REMOVED (echo  [5/7] PM2 entries stopped and deleted:!REMOVED!) else (echo  [5/7] nothing registered with PM2)

rem ---- 6. stray node processes ---------------------------------------------
rem  Anything still running this folder's dist\index.js outside PM2's control -
rem  a hand-started `node dist/index.js`, a PM2 child orphaned by a killed
rem  daemon - would keep the analyzer ports and the dashboard port busy.
:kill_strays
set "KILLED=0"
for /f "usebackq delims=" %%k in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$here=[regex]::Escape('%~dp0dist\index.js'); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $here } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId } catch {} }"`) do (
  set /a KILLED+=1
  echo        killed node.exe pid %%k
)
if "%KILLED%"=="0" (echo  [6/7] no stray connector processes) else (echo  [6/7] killed %KILLED% stray connector process^(es^))

rem ---- 7. ports ----------------------------------------------------------------
rem  Give the OS a moment to release the sockets, then confirm.
ping -n 3 127.0.0.1 >nul
set "BUSY="
for %%p in (7071 3010 3011) do (
  netstat -ano -p tcp | findstr /r /c:":%%p .*LISTENING" >nul 2>&1
  if not errorlevel 1 set "BUSY=!BUSY! %%p"
)
if defined BUSY (
  echo  [7/7] WARNING: still listening on port^(s^):!BUSY!
  echo        Something outside this folder owns them. Find it with:
  echo          netstat -ano ^| findstr LISTENING
) else (
  echo  [7/7] ports 7071 / 3010 / 3011 are free
)

echo.
where pm2 >nul 2>&1 && call pm2 list
echo.
echo  ==========================================================
echo   LAB-Interface is force-stopped and will STAY stopped:
echo   no PM2 entry, no logon entry, no watchdog, flag raised.
echo.
echo   Start it again with LAB-Interface.bat
echo  ==========================================================
echo.
pause
exit /b 0
