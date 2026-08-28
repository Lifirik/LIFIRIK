@echo off
rem DEPLOY.bat - ship this tree to the live site, and bring the live data back.
rem
rem   LIVE GETS CODE, DEV GETS DATA.
rem
rem Double-click it, or run it from a prompt. Everything expensive (the 1331
rem gates, the dist build) happens BEFORE anything is stopped, so a failure
rem leaves the live site untouched and still running.
rem
rem   DEPLOY.bat                 the whole thing
rem   DEPLOY.bat -SkipTests      emergencies only - ships without the gates
rem   DEPLOY.bat -NoPull         ship code, leave the dev database alone
rem
rem GOLIVE.bat is the other door: it starts the live site from cold and does not
rem deploy anything.
rem
rem ASCII only, deliberately - cmd.exe reads this as ANSI, and scripts\deploy.ps1
rem says at more length why that matters on this box.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1" %*
set CODE=%ERRORLEVEL%
echo.
if not "%CODE%"=="0" echo Deploy FAILED with code %CODE%.
pause
exit /b %CODE%
