@echo off
cd /d "%~dp0"
echo Starting Harles Studio for HP / WiFi LAN (Share-Safe BYOK Mode)...
echo Catatan: Jika muncul Access Denied, jalankan Command Prompt sebagai Administrator lalu ketik:
echo   netsh http add urlacl url=http://+:3456/ user=Everyone
echo dan pastikan port 3456 diizinkan di Windows Firewall.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -ShareMode -Lan
pause
