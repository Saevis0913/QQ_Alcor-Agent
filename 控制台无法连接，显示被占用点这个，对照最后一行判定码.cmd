@echo off
chcp 65001 >nul
setlocal enableextensions enabledelayedexpansion
title Alcor Agent - QQ 连接排查
set "NEED_RUNTIME=runtime\node.exe"
set "NEED_SCRIPT=resources\app\tools\qq-doctor.mjs"
set "ROOT="
call :try "%~dp0"
if not defined ROOT call :try "%CD%\"
for %%D in ("D:\Alcor" "C:\Alcor" "%LOCALAPPDATA%\Programs\Alcor" "%ProgramFiles%\Alcor" "%ProgramFiles(x86)%\Alcor") do if not defined ROOT call :try "%%~D\"
if not defined ROOT call :from_registry
if not defined ROOT goto :missing
echo 正在读取 Alcor 核心与 QQ 进程状态，请稍候...
echo.
"%ROOT%%NEED_RUNTIME%" "%ROOT%%NEED_SCRIPT%" %*
set "CODE=%ERRORLEVEL%"
echo.
echo 上面的报告最后一行就是判定码。
pause
exit /b %CODE%

:try
if defined ROOT exit /b
if not exist "%~1%NEED_RUNTIME%" exit /b
if not exist "%~1%NEED_SCRIPT%" exit /b
set "ROOT=%~1"
exit /b

:from_registry
for %%K in ("HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") do (
  for /f "tokens=2,*" %%A in ('reg query %%K /s /v InstallLocation 2^>nul ^| findstr /i "REG_SZ"') do (
    if not defined ROOT call :try "%%~B\"
  )
)
exit /b

:missing
echo [没找到 Alcor 安装目录]
echo.
echo 这个排查程序要和 Alcor Agent.exe 放在同一个安装目录里运行。
echo 当前所在目录：%~dp0
echo 需要这两个文件：%NEED_RUNTIME%  和  %NEED_SCRIPT%
echo.
echo 已尝试：本文件所在目录、当前目录、D:\Alcor、C:\Alcor、
echo          %%LOCALAPPDATA%%\Programs\Alcor、%%ProgramFiles%%\Alcor、注册表里的安装位置。
echo.
echo 处理办法：打开 Alcor 的安装目录（能看到 Alcor Agent.exe 那一层），
echo           在那里双击同名文件，不要把它复制到别处运行。
echo.
pause
exit /b 4
