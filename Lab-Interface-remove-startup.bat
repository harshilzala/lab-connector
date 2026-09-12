@echo off
rem ===========================================================================
rem  Removes both auto-start mechanisms created by Lab-Interface.bat:
rem  the logon shortcut and the 5-minute watchdog task.
rem
rem  This does NOT stop a running connector - it only stops it coming back.
rem  Use Lab-Interface-stop.bat to stop it now.
rem ===========================================================================
setlocal
title Lab-Interface - remove from startup

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Lab-Interface.lnk"

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

rem The watchdog is registered per account - "Lab-Interface Watchdog - <user>" -
rem because a task runs only in its owner's session, and rewriting another
rem operator's task needs elevation. Remove this account's task, and the old
rem shared-name task from before that change if it is still around and ours.
:watchdog
set "REMOVED="
call :drop_task "Lab-Interface Watchdog - %USERNAME%"
call :drop_task "Lab-Interface Watchdog"
if not defined REMOVED echo  No watchdog task found for %USERNAME%.

:done
echo.
echo  Lab-Interface will no longer start by itself for %USERNAME%.
echo  Other accounts keep their own logon entry and watchdog.
echo  Re-register both with Lab-Interface.bat
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
rem Delete one scheduled task by name. Absent is not an error, and neither is
rem "belongs to somebody else" - say which and carry on, so removing your own
rem entries never turns into an administrator prompt.
rem ---------------------------------------------------------------------------
:drop_task
schtasks /Query /TN %1 >nul 2>&1
if errorlevel 1 exit /b 0
schtasks /Delete /TN %1 /F >nul 2>&1
if errorlevel 1 goto drop_failed
set "REMOVED=1"
echo  Removed watchdog task: %~1
exit /b 0

:drop_failed
echo  NOTE: could not delete the task "%~1".
echo        It belongs to another operator - that account can remove it with
echo        this script, or an administrator can delete it in Task Scheduler.
exit /b 0
