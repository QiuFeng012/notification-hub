<#
  信息整合台 —— 桌面入口

  这个脚本是桌面/开始菜单快捷方式的目标。它做两件事，顺序不能反：

    1. 确保服务在跑（没跑就后台拉起，已在跑就直接用）
    2. 用 Chromium 的 --app 模式打开一个独立窗口（没有地址栏、没有标签页）

  为什么需要它：浏览器里安装出来的那个 PWA 图标**无法拉起本机服务进程**——
  浏览器沙箱不允许网页或已安装应用执行本地程序。所以"点桌面图标就有内容"
  只能靠一个真正的本地启动器来做，也就是这个脚本。

  为什么要独立窗口而不是普通标签页：PWA 图标的观感就是"没有地址栏的应用"，
  换成启动器不应该让这件事退步。Edge / Chrome 的 --app 模式能达到同样效果，
  而且用的是同一个浏览器配置，所以 localStorage 里的排序偏好、
  以及 PWA 的 service worker 注册都是同一份，不会出现"两套设置"。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-app.ps1
    powershell -File scripts/launch-app.ps1 -NoLaunch     # 只确保服务在跑，不开窗口（供验证使用）

  退出码：0 成功；1 服务没能起来；2 连不上服务
#>
[CmdletBinding()]
param(
  [int]$Port = 5178,
  # 同 start-server.ps1：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = '',
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}

$appUrl = "http://127.0.0.1:$Port/"
$startScript = Join-Path $RepoRoot 'scripts\start-server.ps1'
$logDir = Join-Path $env:LOCALAPPDATA 'NotificationHub'
$logFile = Join-Path $logDir 'launch.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

function Test-ServiceReady {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

function Set-WindowTitle {
  try { $Host.UI.RawUI.WindowTitle = '信息整合台' } catch { }
}

Write-Log "启动请求（NoLaunch=$NoLaunch）"

Set-WindowTitle
Write-Host ""
Write-Host "  信息整合台" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# ---------- 1. 服务 ----------
# 已经在跑就绝不再拉一个：端口会撞车，用户会看到两条错误却不知道该信哪条。
if (Test-ServiceReady) {
  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' })
  if ($running.Count -gt 0) {
    Write-Host "  [OK] 服务已在运行（PID $(($running | ForEach-Object { $_.ProcessId }) -join ', ')）" -ForegroundColor Green
  } else {
    Write-Host "  [OK] 服务已在运行" -ForegroundColor Green
  }
} else {
  if (-not (Test-Path $startScript)) {
    Write-Host "  [X] 找不到启动脚本：$startScript" -ForegroundColor Red
    Write-Log "启动失败：找不到 $startScript"
    exit 1
  }
  Write-Host "  服务没在跑，正在后台启动…" -ForegroundColor Yellow
  # 输出交给启动脚本自己写日志（它重定向到 %TEMP%）；这里只关心它跑完
  $started = $false
  try {
    & $startScript -Port $Port -NoBrowser
    $started = $true
  } catch {
    Write-Log "启动脚本报错：$($_.Exception.Message)"
  }

  if (-not (Test-ServiceReady)) {
    Write-Host "  [X] 服务启动失败。运行 scripts\status.ps1 可以看当前状态。" -ForegroundColor Red
    Write-Log "启动失败：启动脚本退出后健康检查仍不通过（started=$started）"
    exit 1
  }
  Write-Host "  [OK] 服务已就绪" -ForegroundColor Green
}

if ($NoLaunch) {
  Write-Host "  [i] 已指定 -NoLaunch，不打开窗口" -ForegroundColor DarkGray
  Write-Log "按 -NoLaunch 结束"
  exit 0
}

# ---------- 2. 为什么先找浏览器再开窗口 ----------
# 找不到浏览器时仍然要把服务留着（它已经在跑了），但必须说清退回到了什么，
# 而不是弹出一个和预期不一样的普通标签页却不解释。
$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
)
$browser = $null
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path $candidate)) { $browser = $candidate; break }
}

if (-not $browser) {
  # 兜底：查注册表里浏览器自己登记的安装路径，覆盖装在非默认目录的情况
  foreach ($exe in @('msedge.exe', 'chrome.exe')) {
    $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    if (Test-Path $key) {
      $found = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
      if ($found -and (Test-Path $found)) { $browser = $found; break }
    }
  }
}

if ($browser) {
  # 不用 -ArgumentList 的数组形式：--app=<url> 是一个参数，
  # 拆成两个会被浏览器当成"打开两个东西"。
  $argumentText = "--app=$appUrl --no-first-run --no-default-browser-check"
  Write-Host "  正在打开应用窗口（$([System.IO.Path]::GetFileName($browser))）" -ForegroundColor DarkGray
  Write-Log "打开应用窗口：$browser $argumentText"
  Start-Process -FilePath $browser -ArgumentList $argumentText | Out-Null
} else {
  Write-Host "  [!] 没找到 Edge 或 Chrome，改用默认浏览器标签页打开。" -ForegroundColor Yellow
  Write-Host "      想要无地址栏的独立窗口，请安装 Edge 或 Chrome 后重试。" -ForegroundColor DarkGray
  Write-Log "没找到 Edge/Chrome，回退到默认浏览器"
  Start-Process $appUrl
}

# 说明一处做不到的事：--app 窗口在任务栏里仍然归在浏览器名下（图标也是浏览器的）。
# 要让 Windows 把它单独识别成一个应用，需要给进程设 AppUserModelID，
# 而在 PowerShell 里只能用 Add-Type 调 Shell API——那会让启动器依赖一段
# 编译期代码，一旦被安全策略挡住就连服务都起不来。宁可任务栏图标不好看。
Write-Log "完成"
exit 0
