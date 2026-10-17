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

# 解析要用的 node / pnpm（新用户机器上没有 Node 时，runtime.ps1 会下载锁死版本）。
# 正常情况下 launch-app.ps1 已经先跑过 prepare.ps1，这里只是几十毫秒地再确认一次。
. (Join-Path $PSScriptRoot 'runtime.ps1')
Initialize-Runtime

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
    & $PnpmCmd build
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
#
# 为什么不用 Start-Process + -RedirectStandardOutput：从"没有控制台"的父进程里
# （双击桌面快捷方式时正是这种）那套重定向会阻塞，服务起不来。
# 这里直接创建进程，并把日志重定向交给 cmd —— 我们不需要读子进程的输出管道，
# 所以三个流一个都不设 Redirect*，不留下任何需要我们去读的管道。
Write-Step "正在启动服务…"
# 用 runtime.ps1 解析出的 node（可能是 .runtime\node\node.exe），而不是 PATH 里的：
# 新用户机器上 PATH 里根本没有 node。路径加引号，因为它可能含空格。
$cmdLine = '"' + $NodeExe + '" --env-file-if-exists=../../.env dist\index.js >> "' + $logFile + '" 2>> "' + $errFile + '"'
$process = New-Object System.Diagnostics.Process
$process.StartInfo.FileName = 'cmd.exe'
# cmd /c 的引号规则很怪：命令里已有引号（node 路径带空格、>> 的文件名）时，
# 必须整条命令再包一对外层引号，cmd 才会剥掉外层、把内层原样执行。
# 不包的话 "C:\Program Files\nodejs\node.exe" 会被拆成 C:\Program 两个词，
# 实测报 "'C:\Program' is not recognized"。
$process.StartInfo.Arguments = '/c "' + $cmdLine + '"'
$process.StartInfo.WorkingDirectory = $serverDir
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.CreateNoWindow = $true
# 服务端从环境变量 PORT 读端口（见 apps/server/src/config.ts）。
# 不设这个变量的话，-Port 只改健康检查的地址，服务器永远绑 5178——
# 实测过一次：传 -Port 5180 起出来的服务仍监听 5178，换端口等于没换。
# 用 ProcessStartInfo.EnvironmentVariables 注入（已单独验证能传给子进程）。
$process.StartInfo.EnvironmentVariables['PORT'] = [string]$Port

$ready = $false
try {
  [void]$process.Start()
} catch {
  Write-Err2 "无法启动服务进程：$($_.Exception.Message)"
  Write-Step "完整日志：$logFile"
  exit 1
}

# 5. 轮询等待就绪，最多 30 秒
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-ServiceReady) { $ready = $true; break }
}

if (-not $ready) {
  Write-Err2 "服务启动失败"
  if (Test-Path $errFile) {
    $errors = Get-Content $errFile -ErrorAction SilentlyContinue |
      Where-Object { $_ -and $_ -notmatch 'env-file-if-exists' }
    if ($errors) {
      Write-Host ""
      Write-Host "  错误输出：" -ForegroundColor Red
      $errors | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
    }
  }
  # 端口被占用是最常见的一种，单独点出来：错误原文是 EADDRINUSE，
  # 用户看到它并不会想到"是不是已经开着一个了"。
  if ((Test-Path $errFile) -and (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) -match 'EADDRINUSE') {
    Write-Host ""
    Write-Warn2 "端口 $Port 已被占用：可能已经有一个服务在跑，或者被别的程序占了。"
    Write-Step "先双击「查看状态.bat」确认，或双击「停止信息整合台.bat」停掉旧的再试。"
  }
  Write-Host ""
  Write-Step "完整日志：$logFile"
  exit 1
}

Write-Ok "服务已启动（PID $($process.Id)，监听 127.0.0.1:$Port）"

# 摘要模式直接问服务端，而不是自己猜。
# 用户可能在界面上保存过 Key，那只存在于 data/settings.json 里，
# 只读环境变量会误报"未配置"。
$settings = $null
try {
  $settings = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/settings" -TimeoutSec 3
} catch {
  $settings = $null
}

if (-not $settings) {
  Write-Warn2 "无法读取当前设置，请在界面上的「API 设置」里确认"
} elseif ($settings.configured -eq $true) {
  $origin = if ($settings.source -eq 'user') { '界面保存' } else { '环境变量' }
  Write-Ok "已配置 API Key（$origin），模型 $($settings.model)，使用 DeepSeek 真实总结"
} else {
  Write-Warn2 "未配置 API Key，当前为本地启发式摘要（卡片会标注为非 AI）"
  Write-Host "       在页面左上的「API 设置」里填入 DeepSeek API Key 即可启用真实 AI 总结。" -ForegroundColor DarkGray
}

Write-Host ""
Open-App
Write-Host ""
Write-Host "  服务在后台运行，关闭本窗口不影响使用。" -ForegroundColor DarkGray
Write-Host "  需要停止时运行：停止信息整合台.bat" -ForegroundColor DarkGray
Write-Host "  运行日志：$logFile" -ForegroundColor DarkGray
Write-Host ""
exit 0
