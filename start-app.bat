@echo off
setlocal
cd /d "%~dp0"
echo Starting US Vehicle Catalog on http://localhost:4310 ...
start "US Vehicle Catalog server" cmd /c "npm start"
rem wait for the server to come up, then open the browser
set tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:4310/api/summary -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto up
if %tries% geq 30 goto up
timeout /t 1 /nobreak >nul
goto waitloop
:up
start "" http://localhost:4310
echo Application opened in the default browser. Close the server window (or run stop-app.bat) to stop.
