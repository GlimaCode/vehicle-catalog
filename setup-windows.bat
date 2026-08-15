@echo off
setlocal
cd /d "%~dp0"
echo === US Vehicle Catalog - Windows setup ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and re-run.
  pause
  exit /b 1
)
echo Installing dependencies (this may take a few minutes)...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
echo Initializing database and applying migrations...
call npm run db:init
if errorlevel 1 ( echo Database initialization failed. & pause & exit /b 1 )
echo Checking for catalog files (the release ships a populated database)...
call npm run catalog:import-if-present
if errorlevel 1 ( echo Catalog check failed - see output above. & pause & exit /b 1 )
echo Building the application...
call npm run build
if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
echo.
echo Setup complete. Run start-app.bat to launch the application.
echo It will listen on http://127.0.0.1:4310 (local machine only).
pause
