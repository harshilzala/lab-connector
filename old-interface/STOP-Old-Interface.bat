@echo off
rem ===========================================================================
rem  Stops everything START-Old-Interface.bat starts: the three services and
rem  the three device programs.
rem
rem  Leaves the services on Manual start, so they stay retired.
rem  Needs admin, so this re-launches itself elevated.
rem ===========================================================================
setlocal
title Old Interface - stop
cd /d "%~dp0"

net session >nul 2>&1
if not errorlevel 1 goto elevated
echo  asking for administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 0

:elevated
echo.
echo  ==========================================================
echo   Old Interface - stopping
echo  ==========================================================
echo.

echo  [1/2] device programs...
taskkill /IM "Vitros250.exe" /F >nul 2>&1
taskkill /IM "Vitros_ECiQ.exe" /F >nul 2>&1
taskkill /IM "Lab Integration.exe" /F >nul 2>&1

echo  [2/2] services...
for %%S in (Results Orders_Prod_CBC Filter_Data_CBC) do (
  sc stop %%S >nul 2>&1
  sc config %%S start= demand >nul 2>&1
  sc query %%S | find "STATE"
)

echo.
echo  ==========================================================
echo   Old Interface stopped and still on Manual start.
echo  ==========================================================
echo.
pause
exit /b 0
