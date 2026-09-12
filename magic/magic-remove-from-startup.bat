@echo off
rem ===========================================================================
rem  magic-remove-from-startup  -  undo magic-add-to-startup.bat.
rem
rem  Removes the logon shortcut and the 5-minute watchdog task registered for
rem  THIS account. It does not stop a running connector - use magic-stop.bat
rem  for that, in that order if you want it down and staying down:
rem
rem      magic-remove-from-startup.bat      (stop it coming back)
rem      magic-stop.bat                     (put it down now)
rem
rem  Leaves the Lab-Interface.bat entries alone. If this machine was set up with
rem  those as well, use Lab-Interface-remove-startup.bat in the folder above.
rem ===========================================================================
setlocal
title magic - remove from startup

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\magic-lab-connector.lnk"
set "WDNAME=magic Lab Connector Watchdog - %USERNAME%"

echo.
echo  ==========================================================
echo   magic  -  remove from Windows startup
echo  ==========================================================
echo.

if not exist "%LNK%" goto no_lnk
del "%LNK%" >nul 2>&1
if exist "%LNK%" goto lnk_failed
echo  removed the logon entry.
goto task

:no_lnk
echo  no logon entry was registered for %USERNAME%.

:task
schtasks /Query /TN "%WDNAME%" >nul 2>&1
if errorlevel 1 goto no_task
schtasks /Delete /TN "%WDNAME%" /F >nul 2>&1
if errorlevel 1 goto task_failed
echo  removed the watchdog task.
goto done

:no_task
echo  no watchdog task was registered for %USERNAME%.

:done
echo.
echo  ==========================================================
echo   The connector will no longer start on its own.
echo   If it is running right now, magic-stop.bat puts it down.
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
:lnk_failed
echo  WARNING: could not delete
echo           %LNK%
echo  Delete it by hand, or the connector still starts at logon.
echo.
pause
exit /b 1

:task_failed
echo  WARNING: could not delete the task "%WDNAME%".
echo  Remove it by hand with:
echo      schtasks /Delete /TN "%WDNAME%" /F
echo.
pause
exit /b 1
