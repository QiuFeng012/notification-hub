<#
  信息整合台 —— 服务状态查询

  用于确认服务是否在跑、数据在哪、当前用哪种摘要模式。
#>
[CmdletBinding()]
param(
  [int]$Port = 5178,
  # 同 start-server.ps1：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}
$dbPath = Join-Path $RepoRoot 'data\cards.db'

function Set-WindowTitle {
  try { $Host.UI.RawUI.WindowTitle = '信息整合台状态' } catch { }
}

Set-WindowTitle
Write-Host ""
Write-Host "  信息整合台 —— 状态" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

$health = $null
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
} catch {
  $health = $null
}

$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' })

if ($health -and $health.ok -eq $true) {
  Write-Host "  状态：运行中" -ForegroundColor Green
  Write-Host "  地址：http://127.0.0.1:$Port/"
  if ($processes.Count -gt 0) {
    Write-Host "  进程：PID $(($processes | ForEach-Object { $_.ProcessId }) -join ', ')"
  } else {
    Write-Host "  进程：未找到本项目的 node 进程（可能是其他方式启动的）" -ForegroundColor Yellow
  }

  try {
    $cards = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/cards" -TimeoutSec 3
    Write-Host "  信息卡：$($cards.total) 张"
  } catch {
    Write-Host "  信息卡：读取失败" -ForegroundColor Yellow
  }

  if (Test-Path $dbPath) {
    $size = [math]::Round((Get-Item $dbPath).Length / 1KB, 1)
    Write-Host "  数据库：$dbPath ($size KB)"
  }
} else {
  Write-Host "  状态：未运行" -ForegroundColor Yellow
  Write-Host "  双击「启动信息整合台.bat」即可启动。"
  if (Test-Path $dbPath) {
    $size = [math]::Round((Get-Item $dbPath).Length / 1KB, 1)
    Write-Host "  数据仍在：$dbPath ($size KB)" -ForegroundColor DarkGray
  } else {
    Write-Host "  还没有数据库文件（首次生成信息卡时会自动创建）" -ForegroundColor DarkGray
  }
}

Write-Host ""
exit 0
