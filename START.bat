@echo off
title Dota 2 Coach - keep open
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -LaunchDota
rem the small always-on-top window over the game (waits for the server below)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0overlay.ps1"
node "%~dp0server.js"
pause
