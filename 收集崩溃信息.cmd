@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "ALCOR_AGENT_DATA_DIR=%~dp0data"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0resources\app\tools\crash-collect.mjs"
) else (
  node "%~dp0resources\app\tools\crash-collect.mjs"
)
echo.
echo 上面这份内容已同时保存到 data\crash-report-*.txt，把那个文件发给作者即可。
pause
