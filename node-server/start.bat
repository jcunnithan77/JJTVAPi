@echo off
echo Starting JJtv Node.js Server...
cd /d "%~dp0"
npm install && node src/index.js
pause
