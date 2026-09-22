@echo off
chcp 65001 >nul
cd /d "%~dp0."
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { & '.\scripts\start-server.ps1' } catch { Write-Host $_.Exception.Message -ForegroundColor Red } finally { if (-not $env:NOTIFICATION_HUB_NO_PAUSE) { Write-Host 'Press any key to close...' -ForegroundColor DarkGray; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } }"
