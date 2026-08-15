@echo off
setlocal
cd /d "%~dp0"
echo Creating a timestamped database backup in the backups folder...
call npm run db:backup
pause
