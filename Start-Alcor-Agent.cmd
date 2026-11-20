@echo off
setlocal
cd /d "%~dp0"
set "ALCOR_AGENT_DATA_DIR=%~dp0data"
set "TEMP=%~dp0data\temp"
set "TMP=%TEMP%"
set "APPDATA=%~dp0data\appdata"
set "LOCALAPPDATA=%~dp0data\localappdata"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%APPDATA%" mkdir "%APPDATA%"
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%"
rem 全局设了 ELECTRON_RUN_AS_NODE 时双击会以纯 Node 模式启动，界面根本不出现
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "SAFE="
:launch
if defined SAFE (
  echo 正在以安全模式启动（已关闭显卡加速与沙箱）...
  start "" "%~dp0Alcor Agent.exe" --disable-gpu --disable-gpu-sandbox --no-sandbox
) else (
  start "" "%~dp0Alcor Agent.exe"
)
call :waitup
if not errorlevel 1 exit /b 0
if defined SAFE goto failed
set "SAFE=1"
echo 第一次启动没有成功，正在改用安全模式重试...
goto launch
:waitup
for /l %%i in (1,1,25) do (
  curl -s -m 1 http://127.0.0.1:5320/api/version >nul 2>&1 && exit /b 0
  timeout /t 1 >nul
)
exit /b 1
:failed
echo.
echo ============================================================
echo  两次启动都没有成功（普通模式 + 安全模式）。
echo  启动诊断日志 data\boot-diag.log 的最后几行：
echo ============================================================
if exist "%~dp0data\boot-diag.log" (
  powershell -NoProfile -Command "Get-Content '%~dp0data\boot-diag.log' -Tail 20"
) else (
  echo 没有生成 data\boot-diag.log：程序在写日志之前就退出了。
  echo 通常是安全软件拦截或系统缺少运行库，请运行同目录的「收集崩溃信息.cmd」。
)
echo.
echo 也可以直接运行「收集崩溃信息.cmd」，把生成的报告发给作者。
echo.
pause
exit /b 1
