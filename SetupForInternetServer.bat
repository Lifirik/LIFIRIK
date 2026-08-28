@echo off
rem SetupForInternetServer.bat - first-time public site on this Windows PC.
rem Needs: Node 22+, Caddy on PATH, a domain pointing here, router 80 and 443.
rem Edit Caddyfile first: replace lifirik.example with your domain.
rem Later updates: DEPLOY.bat   Later restarts: Production\GOLIVE.bat
rem ASCII only - cmd.exe reads this as ANSI.
setlocal
cd /d "%~dp0"
title LIFIRIK internet server
echo.
echo LIFIRIK - internet server
echo Builds Production\ and starts it behind Caddy on https
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on PATH.
  echo Install Node 22 or newer from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

where caddy >nul 2>nul
if errorlevel 1 (
  echo Caddy is not installed, or not on PATH.
  echo Install it from https://caddyserver.com/docs/install#windows then run this again.
  pause
  exit /b 1
)

findstr /c:"lifirik.example" Caddyfile >nul
if not errorlevel 1 (
  echo Caddyfile still says lifirik.example
  echo Notepad will open. Change that to your domain, save, close Notepad.
  echo DNS A record must point at this PC. Router must forward ports 80 and 443 here.
  echo.
  notepad Caddyfile
  echo Press a key when the Caddyfile is saved.
  pause
)

echo Installing packages...
call npm install
if errorlevel 1 goto :fail

if not exist data\db.sqlite (
  echo Seeding the campaign...
  call npm run seed
  if errorlevel 1 goto :fail
)

echo Building Production files...
call npm run build
if errorlevel 1 goto :fail

if not exist Production mkdir Production
robocopy dist Production /E /NFL /NDL /NJH /NJS /nc /ns /np >nul
if errorlevel 8 goto :fail
copy /y Caddyfile Production\ >nul
copy /y GOLIVE.bat Production\ >nul

if not exist Production\data\db.sqlite (
  if exist data\db.sqlite (
    echo Copying the database into Production...
    xcopy /e /i /y data Production\data >nul
  )
)

echo Installing Production packages...
pushd Production
call npm ci --omit=dev
if errorlevel 1 (
  popd
  goto :fail
)
popd

echo.
echo Sign in as LIFIRIK / changeme!  Change that password on a public site.
echo Starting the public site from Production\
echo Close the node window to stop. Caddy has its own window.
echo.
call Production\GOLIVE.bat
exit /b %ERRORLEVEL%

:fail
echo.
echo That step failed. Fix the message above, then run this again.
pause
exit /b 1
