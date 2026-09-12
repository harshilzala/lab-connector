@echo off
rem ===========================================================================
rem  Starts the retired Old Interface by hand. Nothing else starts it.
rem
rem  STOP Lab-Interface FIRST (Lab-Interface-stop.bat). Both systems drive
rem  the same three analyzers and post to the same HMIS; running them together
rem  means a fight over the serial links and duplicate results.
rem
rem  Starting the services needs admin, so this re-launches itself elevated.
rem  Nothing here is made permanent - after a reboot the Old Interface is down
rem  again.
rem ===========================================================================
setlocal
title Old Interface - start
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
echo   Old Interface - starting
echo  ==========================================================
echo.

echo  [1/2] services...
for %%S in (Results Orders_Prod_CBC Filter_Data_CBC) do (
  sc start %%S >nul 2>&1
  sc query %%S | find "STATE"
)

echo.
echo  [2/2] device programs...
if exist "E:\API_Integration\Devices\250\Vitros250.exe"          start "" /d "E:\API_Integration\Devices\250"   "E:\API_Integration\Devices\250\Vitros250.exe"
if exist "E:\API_Integration\Devices\ECiQ\Vitros_ECiQ.exe"       start "" /d "E:\API_Integration\Devices\ECiQ"  "E:\API_Integration\Devices\ECiQ\Vitros_ECiQ.exe"
if exist "E:\API_Integration\Devices\H360\Lab Integration.exe"   start "" /d "E:\API_Integration\Devices\H360"  "E:\API_Integration\Devices\H360\Lab Integration.exe"

echo.
echo  ==========================================================
echo   Old Interface started. It will NOT come back after a
echo   reboot - run this again if you need it.
echo  ==========================================================
echo.
pause
exit /b 0
