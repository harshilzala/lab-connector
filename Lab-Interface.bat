@echo off
rem ===========================================================================
rem  Lab-Interface - start / redeploy  (double-click this)
rem
rem  Builds the TypeScript, starts (or restarts) the connector under PM2, saves
rem  the PM2 process list, and registers the two things that keep it alive
rem  without anyone watching:
rem
rem    1. a logon entry   - Windows boots or the user logs on  -> started
rem    2. a watchdog task - checked every 5 minutes            -> restarted if
rem                                                               it is not up
rem
rem  Crashes and hand-killed processes are handled by PM2 itself (autorestart in
rem  ecosystem.config.cjs), usually within a second or two - the watchdog is the
rem  backstop for the cases PM2 cannot cover, such as the PM2 daemon itself
rem  being killed.
rem
rem  Safe to run repeatedly: every step is idempotent. Re-running it after a
rem  code or config change is the normal way to redeploy.
rem
rem  RUNS UNELEVATED, FOR ANY ACCOUNT. Nothing here needs "Run as
rem  administrator" - see the PM2 home and shared-access blocks below for the
rem  two things that used to force it.
rem ===========================================================================
setlocal
title Lab-Interface - start

rem Always work from the folder this script lives in, however it was launched.
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  PM2 home - deliberately NOT the machine-wide C:\ProgramData\pm2\home.
rem
rem  That folder belongs to the LocalSystem "PM2" service: its files grant
rem  BUILTIN\Users read only, so an unelevated pm2 cannot write pm2.pid. Every
rem  call then died with
rem
rem      PM2 error: EPERM: operation not permitted, open
rem                 'C:\ProgramData\pm2\home\pm2.pid'
rem
rem  and leaked a half-started daemon - 177 of them had piled up before this
rem  was found. Running the script elevated was the only way round it, which is
rem  exactly what we do not want.
rem
rem  Keeping the home beside the connector, writable by Users (see
rem  :grant_shared_access), is what lets ANY account drive PM2 here without
rem  elevation. It is shared rather than per-user on purpose: Windows PM2 uses
rem  the fixed pipes \\.\pipe\rpc.sock and \\.\pipe\pub.sock, so only one
rem  daemon can ever exist on this machine anyway - it should read one home.
rem ---------------------------------------------------------------------------
set "PM2_HOME=%~dp0.pm2"
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%" >nul 2>&1

echo.
echo  ==========================================================
echo   Lab-Interface   (HMIS lab connector)
echo   folder: %CD%
echo  ==========================================================
echo.

rem ---- prerequisites --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto no_node
where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2

if not exist "config.json" goto no_config

rem ---- shared access + a warning about the machine-wide PM2 service ---------
call :grant_shared_access
call :warn_foreign_pm2

rem Clear the maintenance flag: starting by hand means "I want this running",
rem so the watchdog is allowed to keep it running from here on.
if exist "%~dp0.lab-maintenance" del "%~dp0.lab-maintenance" >nul 2>&1

rem ---- dependencies ---------------------------------------------------------
if exist "node_modules\typescript\package.json" goto have_deps
echo  [1/6] installing dependencies (first run - this takes a minute)...
call npm install
if errorlevel 1 goto failed
goto build

:have_deps
echo  [1/6] dependencies OK

:build
echo  [2/6] building...
call npm run build
if errorlevel 1 goto failed
if not exist "logs" mkdir "logs"

rem ---- retire the old PM2 name ---------------------------------------------
rem  This app used to run under the name "lab-connector". If that entry is
rem  still registered it would bind the same analyzer ports and fight this one,
rem  so remove it before starting.
call pm2 describe lab-connector >nul 2>&1
if errorlevel 1 goto start_app
echo  [3/6] removing the old "lab-connector" PM2 entry...
call pm2 delete lab-connector >nul 2>&1

:start_app
echo  [3/6] starting under PM2 as Lab-Interface...
call pm2 describe Lab-Interface >nul 2>&1
if errorlevel 1 goto fresh_start
call pm2 restart ecosystem.config.cjs --update-env
if errorlevel 1 goto failed
goto save

:fresh_start
call pm2 start ecosystem.config.cjs
if errorlevel 1 goto failed

:save
rem `pm2 save` writes the dump that `pm2 resurrect` reads at logon. Without
rem this, the startup entry would find nothing to bring back.
echo  [4/6] saving the PM2 process list...
call pm2 save
if errorlevel 1 goto failed

echo  [5/6] registering the logon entry...
call :install_startup

echo  [6/6] registering the 5-minute watchdog...
call :install_watchdog

echo.
call pm2 list
echo.
echo  ==========================================================
echo   Lab-Interface is running.
echo.
echo   Comes back automatically after: a crash, a killed process
echo   and a logon - the watchdog checks every 5 minutes.
echo.
echo   After a REBOOT it starts when an operator logs on, unless
echo   the machine-wide PM2 service is installed to start it
echo   earlier. No account needs to run this as administrator.
echo.
echo   Dashboard : http://127.0.0.1:7071
echo   Live logs : pm2 logs Lab-Interface
echo   Stop      : Lab-Interface-stop.bat
echo  ==========================================================
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------------
rem Let every account on this machine run the connector without elevation.
rem
rem The folder tree gives BUILTIN\Users read-and-execute only, so a second
rem operator - even one in the Administrators group, whose unelevated token
rem carries that membership as deny-only - could not compile into dist\, write
rem logs\ and spool\, or delete the .lab-maintenance flag. Everything looked
rem like "it needs administrator" when what it needed was write access.
rem
rem Granting Modify to Users fixes that once. Done by the folder's OWNER, which
rem needs no elevation. The marker file keeps it to a single pass, because
rem walking the tree costs a few seconds; delete .pm2\.shared-access to force
rem it again after moving or restoring the folder.
rem
rem *S-1-5-32-545 is BUILTIN\Users by SID, so this still works on a machine
rem that is not running English Windows.
rem ---------------------------------------------------------------------------
:grant_shared_access
if exist "%PM2_HOME%\.shared-access" exit /b 0
echo  preparing shared access (one time, so any account can run this)...

rem The access strings live in variables on purpose. cmd counts parentheses
rem while it PARSES a block, before any variable is expanded, so a literal
rem "(OI)(CI)M" written inside a for/if body closes the block early and kills
rem the script outright. Expanded at run time it is just text.
set "SHARE_TREE=*S-1-5-32-545:(OI)(CI)M"
set "SHARE_ONE=*S-1-5-32-545:M"

rem Inheritable, so anything created here later is writable by every operator.
icacls "%~dp0." /grant "%SHARE_TREE%" /C /Q >nul 2>&1
if errorlevel 1 goto shared_failed

rem Existing files already on disk do not pick up a new inheritable entry, so
rem name them: everything loose in the root, then the trees that get written.
icacls "%~dp0*" /grant "%SHARE_ONE%" /C /Q >nul 2>&1
for %%D in (dist logs spool captures .pm2) do call :grant_tree "%%D"

echo shared> "%PM2_HOME%\.shared-access" 2>nul
echo        every account can now build, log and spool here.
exit /b 0

:grant_tree
if exist "%~dp0%~1" icacls "%~dp0%~1" /grant "%SHARE_TREE%" /T /C /Q >nul 2>&1
exit /b 0

:shared_failed
echo        WARNING: could not grant shared access to this folder.
echo        Lab-Interface still runs for %USERNAME%, but another operator may
echo        not be able to start it. Whoever owns the folder can fix it with:
echo          icacls "%~dp0." /grant "*S-1-5-32-545:(OI)(CI)M" /T
exit /b 0

rem ---------------------------------------------------------------------------
rem The machine-wide "PM2" service is the one thing here that elevation cannot
rem be avoided for, so say so plainly rather than failing later in a way that
rem reads like a bug.
rem
rem It runs the PM2 daemon as LocalSystem, and on Windows PM2's daemon sockets
rem are the FIXED pipes \\.\pipe\rpc.sock and \\.\pipe\pub.sock - not derived
rem from PM2_HOME. A pipe created by LocalSystem is readable only by SYSTEM and
rem by elevated administrators, so while that service runs, an ordinary session
rem can neither talk to its daemon nor start one of its own. That is the whole
rem reason these scripts used to want "Run as administrator".
rem ---------------------------------------------------------------------------
:warn_foreign_pm2
sc query pm2.exe 2>nul | find "RUNNING" >nul 2>&1
if errorlevel 1 exit /b 0
echo.
echo  NOTE: the machine-wide "PM2" service (LocalSystem) is running.
echo        It owns \\.\pipe\rpc.sock, so PM2 here still needs elevation and
echo        this script may not be able to reach the daemon.
echo        To finish making Lab-Interface an ordinary, unelevated app, remove
echo        that service ONCE from an elevated prompt:
echo            sc.exe stop pm2.exe
echo            sc.exe delete pm2.exe
echo        Then run this script again as yourself. Trade-off: the service is
echo        what starts the connector at BOOT with nobody logged on; without it
echo        the logon entry and watchdog below start it when an operator logs
echo        in. Keep the service instead if unattended boot matters more.
echo.
exit /b 0

rem ---------------------------------------------------------------------------
rem Put a shortcut in the current user's Startup folder pointing at
rem Lab-Interface-startup.cmd. A .lnk (rather than a .vbs) because Startup
rem always allows shortcuts, while Windows Script Host is often policy-blocked
rem on hospital machines. WindowStyle 7 = minimised, so logon is not
rem interrupted by a console window; the script exits on its own in seconds.
rem
rem The old "HMIS Lab Connector.lnk" entry is deleted first so a machine that
rem was set up under the previous name does not end up with two logon entries.
rem ---------------------------------------------------------------------------
:install_startup
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\Lab-Interface.lnk"
if not exist "%STARTUP%" mkdir "%STARTUP%"
if exist "%STARTUP%\HMIS Lab Connector.lnk" del "%STARTUP%\HMIS Lab Connector.lnk" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$s = $w.CreateShortcut('%LNK%');" ^
  "$s.TargetPath = '%~dp0Lab-Interface-startup.cmd';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Starts Lab-Interface under PM2 at logon';" ^
  "$s.Save()"
if errorlevel 1 goto startup_failed
echo        logon entry: %LNK%
exit /b 0

:startup_failed
echo        WARNING: could not create the logon entry.
echo        The connector is running, but will NOT come back after a reboot.
exit /b 0

rem ---------------------------------------------------------------------------
rem Scheduled task that runs the same startup script every 5 minutes. It only
rem acts when the connector is not online, so the normal case costs nothing.
rem /F replaces an existing task, which makes re-running this script safe.
rem
rem The task runs in the logged-on operator's own session, so pointing it
rem straight at the .cmd gave that session a console window every 5 minutes -
rem a black box flashing on the lab PC's screen all day. It is launched
rem through Lab-Interface-startup-hidden.vbs instead, which runs the same
rem .cmd with window style 0. Same account, same session, same work, no window.
rem
rem Windows Script Host is policy-blocked on some hospital machines. When it
rem is, fall back to registering the .cmd directly: a visible watchdog beats no
rem watchdog on unattended lab equipment.
rem ---------------------------------------------------------------------------
:install_watchdog
set "WDTR=\"%~dp0Lab-Interface-startup.cmd\""
set "WDMODE=visible - WSH unavailable"
if not exist "%~dp0Lab-Interface-startup-hidden.vbs" goto register_watchdog

set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKLM\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto register_watchdog
set "WSHENABLED="
for /f "tokens=3" %%v in ('reg query "HKCU\SOFTWARE\Microsoft\Windows Script Host\Settings" /v Enabled 2^>nul ^| find /i "Enabled"') do set "WSHENABLED=%%v"
if "%WSHENABLED%"=="0x0" goto register_watchdog

set "WDTR=\"%SystemRoot%\System32\wscript.exe\" //nologo \"%~dp0Lab-Interface-startup-hidden.vbs\""
set "WDMODE=hidden"

:register_watchdog
rem The task is named after the account that registered it. It runs in that
rem operator's own session ("interactive only"), so each account needs its own
rem - and, more to the point, /F on someone ELSE's task is refused unless you
rem are elevated, which would put the administrator prompt straight back.
rem Creating a task that runs as yourself needs no elevation.
set "WDNAME=Lab-Interface Watchdog - %USERNAME%"
schtasks /Create /TN "%WDNAME%" /TR "%WDTR%" /SC MINUTE /MO 5 /F >nul 2>&1
if errorlevel 1 goto watchdog_failed
echo        watchdog task: %WDNAME% (every 5 minutes, %WDMODE%)

rem Retire the old shared-name task this script used to create. It did the same
rem job under whichever account happened to register it first; leaving it would
rem run the watchdog twice for that operator. Ignored if it is not ours.
schtasks /Query /TN "Lab-Interface Watchdog" >nul 2>&1
if errorlevel 1 exit /b 0
schtasks /Delete /TN "Lab-Interface Watchdog" /F >nul 2>&1
if not errorlevel 1 echo        retired the old shared watchdog task.
exit /b 0

:watchdog_failed
echo        WARNING: could not create the watchdog task.
echo        PM2 still restarts crashes; only the backstop is missing.
exit /b 0

rem ---- error paths ----------------------------------------------------------
:no_node
echo  ERROR: Node.js was not found on PATH.
echo         Install Node 20 or newer from https://nodejs.org and re-run this.
goto stop

:no_pm2
echo  ERROR: PM2 was not found on PATH.
echo         Install it once with:   npm install -g pm2
goto stop

:no_config
echo  ERROR: config.json is missing from %CD%.
echo         Copy config.example.json to config.json and set the analyzers up
echo         for this site before starting.
goto stop

:failed
echo.
echo  ERROR: a step above failed - Lab-Interface was NOT started.
echo         Scroll up for the first error message.

:stop
echo.
pause
exit /b 1
