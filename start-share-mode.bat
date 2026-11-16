@echo off
cd /d "%~dp0"
echo Starting Harles Studio in SHARE-SAFE BYOK MODE...
echo (Teman/pengunjung memakai API Key di browser masing-masing; .env kamu terkunci aman!)
echo.
echo Untuk membuat link publik HTTPS ke teman (via Cloudflare Quick Tunnel),
echo buka terminal lain dan jalankan:
echo   cloudflared tunnel --url http://127.0.0.1:3456
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -ShareMode
pause
