<#
  信息整合台 —— 服务启动脚本

  做三件事：
    1. 已在运行就直接打开浏览器，不重复启动
    2. 未运行则后台拉起服务端进程，等它就绪
    3. 打开浏览器

  由 启动信息整合台.bat 调用，也可以在本目录直接运行。

  -NoBrowser  只启动服务，不打开浏览器（供自动化验证使用）
#>
[CmdletBinding()]
param(
  [int]$Port = 5178,
  # 不能写成 (Split-Path -Parent $PSScriptRoot)：参数默认值在 $PSScriptRoot
  # 赋值之前求值，那时它是空串，会直接抛错。留空后在脚本体内推导。
  [string]$RepoRoot = '',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}

$serverDir = Join-Path $RepoRoot 'apps\server'
$entry = Join-Path $serverDir 'dist\index.js'
$webIndex = Join-Path $RepoRoot 'apps\web\dist\index.html'
$logFile = Join-Path $env:TEMP 'notification-hub-server.log'
$errFile = Join-Path $env:TEMP 'notification-hub-server.err.log'
$appUrl = "http://127.0.0.1:$Port/"

function Set-WindowTitle {
  try { $Host.UI.RawUI.WindowTitle = '信息整合台' } catch { }
}
function Write-Step([string]$Message) { Write-Host "  $Message" }
function Write-Ok([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  [!] $Message" -ForegroundColor Yellow }
function Write-Err2([string]$Message) { Write-Host "  [X] $Message" -ForegroundColor Red }

function Test-ServiceReady {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

function Get-ServiceProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }
}

function Open-App {
  if ($NoBrowser) {
    Write-Step "已跳过打开浏览器（-NoBrowser）"
    return
  }
  Write-Step "正在打开 $appUrl"
  Start-Process $appUrl
}

Set-WindowTitle
Write-Host ""
Write-Host "  信息整合台" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# 1. 已经在跑就直接开页面
if (Test-ServiceReady) {
  $running = Get-ServiceProcess
  if ($running) {
    Write-Ok "服务已在运行（PID $($running[0].ProcessId)）"
  } else {
    Write-Ok "服务已在运行"
  }
  Write-Host ""
  Open-App
  exit 0
}

# 2. 端口被别的程序占用时要说清楚，否则用户会以为是本应用的问题
$occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
  $owner = Get-Process -Id $occupied[0].OwningProcess -ErrorAction SilentlyContinue
  Write-Err2 "端口 $Port 已被其他程序占用：$($owner.ProcessName) (PID $($occupied[0].OwningProcess))"
  Write-Step "请关闭该程序，或改用其他端口："
  Write-Step "  启动信息整合台.bat -Port 5179"
  exit 1
}

# 3. 缺少构建产物时先构建
if (-not (Test-Path $entry) -or -not (Test-Path $webIndex)) {
  Write-Warn2 "缺少构建产物，正在构建（首次启动会慢一些）"
  Push-Location $RepoRoot
  try {
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
      Write-Err2 "构建失败，请查看上方输出"
      exit 1
    }
  } finally {
    Pop-Location
  }
  Write-Ok "构建完成"
}

if (-not (Test-Path $entry)) {
  Write-Err2 "找不到服务端入口：$entry"
  exit 1
}

# 4. 后台拉起服务端。用独立进程，窗口关闭后依然存活。
Write-Step "正在启动服务…"
$process = Start-Process -FilePath 'node' `
  -ArgumentList '--env-file-if-exists=../../.env', 'dist/index.js' `
  -WorkingDirectory $serverDir `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile

# 5. 轮询等待就绪，最多 30 秒
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  if (Test-ServiceReady) { $ready = $true; break }
}

if (-not $ready) {
  Write-Err2 "服务启动失败"
  if ($process.HasExited) {
    Write-Step "进程已退出，退出码 $($process.ExitCode)"
  }
  if (Test-Path $errFile) {
    $errors = Get-Content $errFile -ErrorAction SilentlyContinue |
      Where-Object { $_ -and $_ -notmatch 'env-file-if-exists' }
    if ($errors) {
      Write-Host ""
      Write-Host "  错误输出：" -ForegroundColor Red
      $errors | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
    }
  }
  Write-Host ""
  Write-Step "完整日志：$logFile"
  exit 1
}

Write-Ok "服务已启动（PID $($process.Id)，监听 127.0.0.1:$Port）"

# 只在 .env 存在且真的匹配到 Key 时才取值。
# 直接写 (...).Matches.Groups[1].Value 会在没有 .env 时抛
# "Cannot index into a null array"，让整个脚本以失败告终 ——
# 用户双击时只会看到窗口一闪而过。
$apiKey = $env:DEEPSEEK_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  $envFile = Join-Path $RepoRoot '.env'
  if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) { $apiKey = $match.Matches[0].Groups[1].Value }
  }
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  Write-Warn2 "未配置 DEEPSEEK_API_KEY，当前为本地启发式摘要（卡片会标注为非 AI）"
} else {
  Write-Ok "已配置 DEEPSEEK_API_KEY，使用 DeepSeek 真实总结"
}

Write-Host ""
Open-App
Write-Host ""
Write-Host "  服务在后台运行，关闭本窗口不影响使用。" -ForegroundColor DarkGray
Write-Host "  需要停止时运行：停止信息整合台.bat" -ForegroundColor DarkGray
Write-Host "  运行日志：$logFile" -ForegroundColor DarkGray
Write-Host ""
exit 0
