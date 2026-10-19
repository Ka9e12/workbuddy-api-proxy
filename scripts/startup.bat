@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

if "%1"=="" (
    echo Usage: startup.bat [enable^|disable^|status]
    echo.
    echo   enable  - enable auto-start on boot
    echo   disable - disable auto-start on boot
    echo   status  - show current status
    echo.
    set /p choice="Select (enable/disable/status): "
) else (
    set choice=%1
)

powershell -ExecutionPolicy Bypass -File "%~dp0startup.ps1" %choice%
pause
