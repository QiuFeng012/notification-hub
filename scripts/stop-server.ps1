<#
  信息整合台 —— 服务停止脚本

  只结束由本项目 dist/index.js 启动的 node 进程，
  不会误杀其他 node 程序。
#>
[CmdletBinding()]
param(
  [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'

function Set-WindowTitle {
  try { $Host.UI.RawUI.WindowTitle = '停止信息整合台' } catch { }
}

function Test-ServiceReady {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

Set-WindowTitle
Write-Host ""
Write-Host "  信息整合台 —— 停止服务" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' })

if ($targets.Count -eq 0) {
  if (Test-ServiceReady) {
    Write-Host "  [!] 服务在响应，但没找到本项目的 node 进程。" -ForegroundColor Yellow
    Write-Host "      它可能是用其他方式启动的（例如 pnpm start），请在对应窗口按 Ctrl+C 停止。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  [i] 服务当前没有运行，无需停止。" -ForegroundColor DarkGray
  exit 0
}

foreach ($item in $targets) {
  try {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
    Write-Host "  [OK] 已停止进程 PID $($item.ProcessId)" -ForegroundColor Green
  } catch {
    Write-Host "  [X] 无法停止 PID $($item.ProcessId)：$($_.Exception.Message)" -ForegroundColor Red
  }
}

# 等端口真正释放，避免"刚停就又启动"时撞端口
$released = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $occupied) { $released = $true; break }
}

if ($released) {
  Write-Host "  [OK] 端口 $Port 已释放" -ForegroundColor Green
} else {
  Write-Host "  [!] 端口 $Port 仍被占用，可能还有残留进程" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  数据仍在 data\cards.db，未丢失。" -ForegroundColor DarkGray
Write-Host ""
exit 0
