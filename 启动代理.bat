@echo off
chcp 65001 >nul 2>&1
title WorkBuddy API Proxy
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies, this may take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Check your network and run npm install manually.
        pause
        exit /b 1
    )
    echo.
)

REM Start with --watch by default: saving a file under src/ restarts the server
REM automatically, so you don't have to close and reopen this window.
REM
REM Why it is needed: Node caches ES module imports for the lifetime of the
REM process. Editing backend .js files has no effect until the process restarts.
REM HTML templates under src/templates/ are re-read on every request, so editing
REM only a template just needs a browser refresh - but .js changes need a restart.
REM
REM To disable auto-reload (e.g. while debugging), set WB_NO_WATCH=1 first.
if "%WB_NO_WATCH%"=="1" (
    echo [watch disabled] starting without auto-reload
    node src/index.js
) else (
    echo [watch enabled] code changes reload automatically
    node --watch src/index.js
)
pause
