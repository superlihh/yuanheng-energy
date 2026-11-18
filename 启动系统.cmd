@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Restart
if errorlevel 1 (
  echo Startup failed. Please check the message above.
  pause
) else (
  start "" "http://127.0.0.1:8080"
)
