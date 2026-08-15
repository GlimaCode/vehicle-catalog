@echo off
setlocal
cd /d "%~dp0"
echo Importing the latest catalog files (prefers *_v2.csv)...
call npm run catalog:import
pause
