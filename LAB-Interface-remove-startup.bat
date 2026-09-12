@echo off
rem ===========================================================================
rem  Removes both auto-start mechanisms created by LAB-Interface.bat:
rem  the logon shortcut and the 5-minute watchdog task.
rem
rem  This does NOT stop a running connector - it only stops it coming back.
rem  Use LAB-Interface-stop.bat to stop it now.
rem ===========================================================================
setlocal
title LAB-Interface - remove from startup

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LAB-Interface.lnk"

if not exist "%LNK%" goto no_lnk
del "%LNK%"
if exist "%LNK%" goto lnk_failed
echo  Removed logon entry: %LNK%
goto watchdog

:no_lnk
echo  No logon entry found (looked for: %LNK%)
goto watchdog

:lnk_failed
echo  ERROR: could not delete %LNK%
echo         Delete it by hand: press Win+R, type  shell:startup  and hit Enter.

:watchdog
schtasks /Query /TN "LAB-Interface Watchdog" >nul 2>&1
if errorlevel 1 goto no_task
schtasks /Delete /TN "LAB-Interface Watchdog" /F >nul 2>&1
if errorlevel 1 goto task_failed
echo  Removed watchdog task: LAB-Interface Watchdog
goto done

:no_task
echo  No watchdog task found.
goto done

:task_failed
echo  ERROR: could not delete the watchdog task.
echo         Remove it by hand from Task Scheduler.

:done
echo.
echo  LAB-Interface will no longer start by itself.
echo  Re-register both with LAB-Interface.bat
echo.
pause
exit /b 0
