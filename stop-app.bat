@echo off
echo Stopping US Vehicle Catalog server (port 4310)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :4310 ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>nul
)
echo Done.
pause
