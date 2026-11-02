@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is missing from PATH.
  pause
  exit /b 1
)
where codex.cmd >nul 2>nul
if errorlevel 1 (
  echo Codex CLI is missing. Install it with: npm install -g @openai/codex
  pause
  exit /b 1
)
set "BRIDGE_PROJECT=%~1"
if not defined BRIDGE_PROJECT set "BRIDGE_PROJECT=%~dp0..\test"
set "BRIDGE_PROJECT=%BRIDGE_PROJECT:"=%"
node "%~dp0bridge\server.cjs" "%BRIDGE_PROJECT%\."
if errorlevel 1 pause
