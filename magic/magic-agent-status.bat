@echo off
rem ===========================================================================
rem  magic-agent-status  -  is the Lab-Watch-Agent running, and what did it
rem  last say?  (double-click)
rem ===========================================================================
setlocal enabledelayedexpansion
title magic-agent-status
cd /d "%~dp0.." || exit /b 1
set "PM2_HOME=%CD%\.pm2"

echo.
echo  ---- PM2 ------------------------------------------------------------
call pm2 list 2>nul | findstr /i "Lab-Watch-Agent Lab-Interface"
echo.
echo  ---- run ------------------------------------------------------------
if exist "scripts\agent\state\run.json" (type "scripts\agent\state\run.json") else (echo  no run recorded yet)
echo.
echo  ---- alerts for a person (logs\agent-alerts.log) --------------------
if exist "logs\agent-alerts.log" (powershell -NoProfile -Command "Get-Content 'logs\agent-alerts.log' -Tail 10") else (echo  none)
echo.
echo  ---- last report (logs\agent-watch-*.log) ---------------------------
for /f "delims=" %%f in ('dir /b /o-d "logs\agent-watch-*.log" 2^>nul') do (set "LAST=logs\%%f" & goto show)
echo  no report yet
goto done
:show
powershell -NoProfile -Command "Get-Content '%LAST%' -Tail 30"
:done
echo.
pause
