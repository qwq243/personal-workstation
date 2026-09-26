@echo off
REM ASCII-only on purpose: cmd.exe reads .bat/.cmd using the OEM code page, so
REM non-ASCII text here gets mangled (and can break parsing) on non-UTF-8 locales.
REM Chinese messages are printed by the Node script instead.
title Workstation
cd /d "%~dp0"

echo.
echo   Starting Workstation...
echo.

node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo   [FAILED] Make sure Node.js is installed ^(run: node -v^)
  echo.
  pause
)
