@echo off
setlocal
title DeepSeek Translate Bridge - 127.0.0.1:8765
cd /d "%~dp0"

rem Keep the console in UTF-8 so the Chinese output from server.js renders correctly.
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 goto no_node

echo.
echo Starting the local bridge. KEEP THIS WINDOW OPEN while translating.
echo Default status page: http://127.0.0.1:8765/   (real URL is printed below)
echo.
node server.js
goto finish

:no_node
echo.
echo [ERROR] Node.js was not found.
echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
echo.

:finish
echo.
echo Bridge stopped. Press any key to close this window.
pause
