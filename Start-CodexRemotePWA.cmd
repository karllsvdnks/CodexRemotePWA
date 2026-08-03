@echo off
setlocal
if not exist "%~dp0.env" goto setup
findstr /b /c:"REMOTE_PASSWORD=replace-with-a-long-random-password" "%~dp0.env" >nul
if not errorlevel 1 goto setup
if exist "%~dp0CodexRemoteConsole.exe" (
  start "Codex Remote" "%~dp0CodexRemoteConsole.exe"
  exit /b 0
)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\codex-remote-client.ps1"
exit /b 0

:setup
if exist "%~dp0CodexRemoteSetup.exe" (
  start "Codex Remote Setup" "%~dp0CodexRemoteSetup.exe"
  exit /b 0
)
echo CodexRemoteSetup.exe is missing. Configure REMOTE_PASSWORD in .env before starting.
exit /b 1
