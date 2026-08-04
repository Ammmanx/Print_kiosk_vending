@echo off
title InstaPrint Kiosk Launcher
color 1F

echo.
echo  ================================================
echo   InstaPrint Self-Service Kiosk System Launcher
echo  ================================================
echo.

REM Clean up any old tunnel log files
del /q "d:\print vending\tunnel_*.log" > nul 2>&1

REM Run start_kiosk.js orchestrator
node "d:\print vending\start_kiosk.js"

pause
