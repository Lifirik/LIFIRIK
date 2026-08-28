@echo off
rem SetupForLocalPlayServer.bat - one-time (or again) local play on this PC.
rem Double-click it. When it is done, open http://localhost:3000
rem ASCII only - cmd.exe reads this as ANSI.
setlocal
cd /d "%~dp0"
title LIFIRIK local play
echo.
echo LIFIRIK - local play
echo Opens http://localhost:3000  (this PC only)
echo Close this window to stop.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on PATH.
  echo Install Node 22 or newer from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

echo Installing packages...
call npm install
if errorlevel 1 goto :fail

if not exist data\db.sqlite (
  echo Seeding the campaign...
  call npm run seed
  if errorlevel 1 goto :fail
)

echo.
echo Sign in as LIFIRIK / changeme!  (change that password)
echo Starting...
set HOST=127.0.0.1
set PORT=3000
set TRUST_PROXY=
call npm start
echo.
pause
exit /b %ERRORLEVEL%

:fail
echo.
echo That step failed. Fix the message above, then run this again.
pause
exit /b 1
