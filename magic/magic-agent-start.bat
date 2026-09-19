@echo off
rem ===========================================================================
rem  magic-agent-start  -  start the 48-hour Lab-Watch-Agent.  (double-click)
rem
rem  An AI watch over the VITROS ECiQ and the VITROS 250: every 15 minutes it
rem  takes a snapshot (link, orders, results, spool, HMIS), reasons over it
rem  with Claude Code, corrects what it is allowed to (re-queue a parked
rem  patient result whose HMIS rows exist; restart the connector when a link
rem  stays down), and writes a report to  logs\agent-watch-<date>.log.
rem  Anything a person must handle lands in  logs\agent-alerts.log.
rem
rem  What it can and cannot do is in  scripts\agent\PROMPT.md.
rem  Runs hidden under PM2 as "Lab-Watch-Agent"; stops itself after 48 hours.
rem  Stop it earlier with magic-agent-stop.bat.  No administrator needed.
rem
rem  Needs the Claude Code CLI signed in as this operator:
rem      npm install -g @anthropic-ai/claude-code      (once)
rem      claude                                        (sign in once, then exit)
rem
rem  Options:   magic-agent-start.bat /hours 24     (default 48)
rem             magic-agent-start.bat /every 10     (minutes, default 15)
rem ===========================================================================
setlocal
title magic-agent-start
cd /d "%~dp0.." || goto no_root
set "ROOT=%CD%"
set "PM2_HOME=%ROOT%\.pm2"

set "AGENT_HOURS=48"
set "AGENT_INTERVAL_MIN=15"
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="/hours" set "AGENT_HOURS=%~2" & shift & shift & goto parse
if /i "%~1"=="/every" set "AGENT_INTERVAL_MIN=%~2" & shift & shift & goto parse
shift
goto parse
:parsed

echo.
echo  ==========================================================
echo   Lab-Watch-Agent  -  ECiQ + VITROS 250, %AGENT_HOURS% h, every %AGENT_INTERVAL_MIN% min
echo  ==========================================================
echo.

where pm2 >nul 2>&1
if errorlevel 1 goto no_pm2
where claude >nul 2>&1
if errorlevel 1 goto no_claude

rem A fresh start is a fresh 48 hours: forget a finished run.
if exist "scripts\agent\state\run.json" del /q "scripts\agent\state\run.json"

call pm2 describe Lab-Watch-Agent >nul 2>&1
if not errorlevel 1 call pm2 delete Lab-Watch-Agent >nul 2>&1

call pm2 start "scripts\agent\run-agent.mjs" --name Lab-Watch-Agent --no-autorestart --time --log "logs\agent-runner.log" --merge-logs
if errorlevel 1 goto pm2_failed

rem Deliberately NO "pm2 save": the watch must not come back at the next logon.
echo.
call pm2 list
echo.
echo  ==========================================================
echo   Lab-Watch-Agent is running (hidden). It stops itself after %AGENT_HOURS% h.
echo   Reports : logs\agent-watch-YYYY-MM-DD.log
echo   Alerts  : logs\agent-alerts.log          (things a person must do)
echo   Status  : magic-agent-status.bat
echo   Stop    : magic-agent-stop.bat
echo  ==========================================================
echo.
pause
exit /b 0

:no_claude
echo  ERROR: the Claude Code CLI ("claude") is not on PATH for this account.
echo         Install once:   npm install -g @anthropic-ai/claude-code
echo         then sign in:   claude      (and exit)
echo.
pause
exit /b 1
:no_pm2
echo  ERROR: PM2 was not found on PATH.  Install once:  npm install -g pm2
echo.
pause
exit /b 1
:pm2_failed
echo  ERROR: PM2 could not start the agent. See logs\agent-runner.log
echo.
pause
exit /b 1
:no_root
echo  ERROR: could not find the connector folder above this one.
pause
exit /b 1
