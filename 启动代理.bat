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

node src/index.js
pause
