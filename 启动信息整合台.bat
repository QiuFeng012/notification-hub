@echo off
chcp 65001 >nul
cd /d "%~dp0."
rem Double-click = start service + open app window.
rem First run auto-installs deps and builds (scripts\prepare.ps1); afterwards it is instant.
rem Optional port: start this bat with a number, e.g. "start.bat 5179".
set "PORT_ARG="
if not "%~1"=="" set "PORT_ARG=-Port %~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { & '.\scripts\launch-app.ps1' %PORT_ARG% } catch { Write-Host $_.Exception.Message -ForegroundColor Red } finally { if (-not $env:NOTIFICATION_HUB_NO_PAUSE) { Write-Host '' ; Write-Host 'Press any key to close...' -ForegroundColor DarkGray; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } }"
