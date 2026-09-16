@echo off
rem ===========================================================================
rem  magic-add-to-startup  -  start the connector automatically at Windows
rem                           logon.  (double-click this once)
rem
rem  Puts a shortcut to magic-startup.cmd in this account's Startup folder, so
rem  the connector comes back after a reboot without anyone opening anything.
rem
rem  Needs no "Run as administrator": it writes to your own Startup folder and
rem  registers a task that runs as you.
rem
rem  Undo it with magic-remove-from-startup.bat
rem ===========================================================================
setlocal
title magic - add to startup

cd /d "%~dp0.." || goto no_root
set "ROOT=%CD%"

rem /quiet: called from magic-start.bat - no banner, no pause, same work.
set "QUIET="
if /I "%~1"=="/quiet" set "QUIET=1"
set "WORKER=%~dp0magic-startup.cmd"

if not exist "%WORKER%" goto no_worker

if defined QUIET goto choose_launcher
echo.
echo  ==========================================================
echo   magic  -  add to Windows startup
echo   folder: %ROOT%
echo  ==========================================================
echo.
:choose_launcher

rem ---------------------------------------------------------------------------
rem  No window. The worker runs in the operator's own session, so pointed at
rem  directly it flashes a console box at every logon and every 5 minutes.
rem  magic-startup-hidden.vbs runs the same .cmd with window style 0.
rem
rem  Windows Script Host is policy-blocked on some hospital machines, and a
rem  .vbs entry silently does nothing there - so check the policy and fall
rem  back to the .cmd itself, minimised (WindowStyle 7), when WSH is off. A
rem  visible watchdog beats none on unattended lab equipment.
rem
rem  A .lnk in the Startup FOLDER rather than a Run registry key: the folder
rem  always allows shortcuts and needs no elevation to write.
rem ---------------------------------------------------------------------------
set "LAUNCH=%WORKER%"
set "LAUNCHVBS="
set "LAUNCHMODE=minimised - WSH unavailable"
if not exist "%~dp0magic-startup-hidden.vbs" goto launcher_chosen
rem  Full path to find.exe: a PATH with a Unix "find" first (Git for Windows)
rem  would otherwise break the check.
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKLM\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| "%SystemRoot%\System32\find.exe" /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto launcher_chosen
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKCU\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| "%SystemRoot%\System32\find.exe" /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto launcher_chosen
set "LAUNCH=%SystemRoot%\System32\wscript.exe"
set "LAUNCHVBS=%~dp0magic-startup-hidden.vbs"
set "LAUNCHMODE=hidden"
:launcher_chosen

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\magic-lab-connector.lnk"
if not exist "%STARTUP%" mkdir "%STARTUP%" >nul 2>&1

echo  [1/2] creating the logon entry (%LAUNCHMODE%)...
rem The .vbs path is quoted with [char]34 inside PowerShell so no double quote
rem has to survive cmd's own parsing of the -Command line.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$s = $w.CreateShortcut('%LNK%');" ^
  "$s.TargetPath = '%LAUNCH%';" ^
  "$a = ''; if ('%LAUNCHVBS%' -ne '') { $a = '//nologo ' + [char]34 + '%LAUNCHVBS%' + [char]34 };" ^
  "$s.Arguments = $a;" ^
  "$s.WorkingDirectory = '%ROOT%';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Starts the HMIS lab connector at logon';" ^
  "$s.Save()"
if errorlevel 1 goto lnk_failed
if not exist "%LNK%" goto lnk_failed
echo        %LNK%

rem ---------------------------------------------------------------------------
rem  A logon entry alone only covers logon. This lab PC runs unattended for
rem  days, so also register a 5-minute check that starts the connector if it is
rem  down. The worker exits immediately when it is already online, so the normal
rem  case costs nothing.
rem
rem  The task is named after the account that registered it, because /F on
rem  another user's task is refused unless you are elevated - which is exactly
rem  the administrator prompt this is meant to avoid.
rem ---------------------------------------------------------------------------
echo  [2/2] registering the 5-minute watchdog (%LAUNCHMODE%)...
set "WDNAME=magic Lab Connector Watchdog - %USERNAME%"
set "WDTR=\"%WORKER%\""
if defined LAUNCHVBS set "WDTR=\"%LAUNCH%\" //nologo \"%LAUNCHVBS%\""
schtasks /Create /TN "%WDNAME%" /TR "%WDTR%" /SC MINUTE /MO 5 /F >nul 2>&1
if errorlevel 1 goto task_failed
echo        task: %WDNAME%
if defined QUIET exit /b 0

echo.
echo  ==========================================================
echo   Done. The connector will start at logon, and be checked
echo   every 5 minutes in case it goes down.
echo.
echo   magic-stop.bat still stops it and keeps it stopped - the
echo   watchdog honours that until you run magic-start.bat.
echo.
echo   Remove all this with magic-remove-from-startup.bat
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:lnk_failed
echo.
echo  ERROR: could not create the logon entry in
echo         %STARTUP%
echo  The connector still runs when you use magic-start.bat, but it will NOT
echo  come back on its own after a reboot.
echo.
if not defined QUIET pause
exit /b 1

:task_failed
echo        WARNING: could not register the watchdog task.
echo        The logon entry was created, so a reboot still brings it back -
echo        but nothing will restart it if it goes down mid-shift.
echo.
if not defined QUIET pause
exit /b 0

:no_worker
echo  ERROR: magic-startup.cmd is missing from
echo         %~dp0
echo         Keep all the magic scripts together in the magic folder.
echo.
pause
exit /b 1

:no_root
echo  ERROR: could not find the connector folder above this one.
echo         Keep the magic folder inside the connector directory.
echo.
pause
exit /b 1
