@echo off
REM ASCII-only on purpose (same reason as the launcher .cmd).
title Workstation (dev)
cd /d "%~dp0"

echo.
echo   Dev mode: Vite HMR + sidecar
echo   Frontend URL is in the Vite output below (default http://127.0.0.1:5273)
echo.

node scripts\dev-all.mjs
pause
