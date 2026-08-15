@echo off
setlocal
cd /d "%~dp0"
echo Generating the Version 2 Excel workbook...
call npm run export:excel-v2
echo Workbook is in the exports folder.
pause
