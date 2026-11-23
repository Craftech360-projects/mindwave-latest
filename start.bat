@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo    MindWave Project - Install and Run
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

rem serialport v12 ships its Windows driver in @serialport/bindings-cpp. If an
rem older install (serialport v7, no compiled driver) is present, reinstall.
if exist "node_modules\express\package.json" if exist "node_modules\@serialport\bindings-cpp\package.json" goto depsok

echo Installing dependencies. This may take a minute...
echo.
call npm install --ignore-scripts
if errorlevel 1 goto installfail
echo.
echo Dependencies installed.
echo.
goto run

:depsok
echo Dependencies already present - skipping install.
echo.

:run
echo Starting server at http://localhost:3000 ...
echo Press Ctrl+C to stop.
echo.
node app.js
echo.
echo Server stopped.
pause
exit /b 0

:nonode
echo [ERROR] Node.js was not found.
echo         Install it from https://nodejs.org and try again.
echo.
pause
exit /b 1

:installfail
echo.
echo [ERROR] Dependency install failed.
pause
exit /b 1
