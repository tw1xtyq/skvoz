@echo off
setlocal
cd /d "%~dp0\.."

net session >nul 2>&1
if %errorLevel% equ 0 goto :run

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '%~f0' -WorkingDirectory '%CD%' -Verb RunAs"
exit /b

:run
call npm run build
if errorlevel 1 exit /b 1
call node scripts\run-dev.js
exit /b %errorlevel%
