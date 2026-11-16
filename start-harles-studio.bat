@echo off
cd /d "%~dp0"
echo Starting Harles Studio local server...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
