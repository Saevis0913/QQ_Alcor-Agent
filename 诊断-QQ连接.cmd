@echo off
chcp 65001 >nul
title Alcor Agent - QQ 连接排查
echo 正在读取 Alcor 核心与 QQ 进程状态，请稍候...
echo.
"%~dp0runtime\node.exe" "%~dp0resources\app\tools\qq-doctor.mjs" %*
echo.
pause
