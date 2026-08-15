@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: restore-database.bat backups\catalog-YYYY-MM-DD....db
  echo Available backups:
  dir /b backups\*.db 2>nul
  pause
  exit /b 1
)
call npm run db:restore -- "%~1"
pause
