@echo off
REM Local launcher for the static export.
REM Double-click this file to serve the current folder over http and
REM open it in the default browser.  Requires Node.js on PATH.

setlocal
set "ROOT=%~dp0"
set "PORT=8080"

REM Resolve serve.js — prefer a copy next to start.cmd, otherwise fall back
REM to the workspace-level serve.js one directory up.
if exist "%ROOT%serve.js" (
  set "SERVE=%ROOT%serve.js"
) else if exist "%ROOT%..\serve.js" (
  set "SERVE=%ROOT%..\serve.js"
) else (
  echo serve.js not found.
  echo Expected at "%ROOT%serve.js" or "%ROOT%..\serve.js".
  pause
  exit /b 1
)

REM Pick a free port if 8080 is in use.
:checkport
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  set /a PORT=PORT+1
  goto checkport
)

start "" "http://localhost:%PORT%/"
node "%SERVE%" "%ROOT%." %PORT%
