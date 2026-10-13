@echo off
title Dota 2 ADHD Coach (demo)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node "%~dp0server.js" --open --demo
pause
