<#
  信息整合台 —— 卸载清理器

  服务端收到卸载请求后，把这个脚本复制到 %TEMP% 再独立启动：
  等服务进程彻底退出，由它删掉数据、运行时、构建产物与整个项目目录，
  最后删掉自己。

  为什么必须是独立进程：node.exe 就在 .runtime\node\ 下，属于要被删的目录。
  Windows 不允许删除正在运行的 exe，所以必须等服务彻底退出后再删；
  而删目录的脚本自己不能住在项目目录里，否则删到最后会把自己删掉。

  顺序（每步幂等、失败可重跑）：
    1. 兜底结束残留的服务进程
    2. 等待端口释放
    3. 移除桌面/开始菜单入口（脚本还在才做）
    4. 移除开机自启动入口（脚本还在才做）
    5. 删除整个项目目录
    6. 清理日志（存在才删，被占用则跳过）
    7. 删除自身副本（只在项目目录之外时删，防止误删源脚本）

  用法（由服务端调用，不手动双击）：
    powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-cleaner.ps1 -RepoRoot <目录>

  退出码：0 成功；1 失败
#>
[CmdletBinding()]
param(
  # 同其它脚本：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = '',
  [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请传入 -RepoRoot"
}

Write-Host ""
Write-Host "  信息整合台 —— 卸载清理" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# 关键：清理器可能被以「项目目录之内」的 CWD 拉起（服务由 apps\server 启动），
# 而 Windows 不允许删除任何进程的当前目录。注意 PowerShell 5.1 的 Set-Location
# 只改 PowerShell 位置、不改 OS 层 CWD（实测 GetCurrentDirectory 仍是旧目录），
# 所以必须显式调用 .NET 的 SetCurrentDirectory 才能真的离开项目目录。
[System.IO.Directory]::SetCurrentDirectory($env:TEMP)
Set-Location $env:TEMP

# 1. 兜底结束残留的服务进程（只杀本项目 dist/index.js 的 node）
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' })
foreach ($item in $targets) {
  try {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "  [OK] 已结束残留进程 PID $($item.ProcessId)" -ForegroundColor Green
  } catch { }
}

# 2. 等待端口释放，避免服务还没退完就开始删目录
$released = $false
for ($i = 0; $i -lt 60; $i++) {
  $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $occupied) { $released = $true; break }
  Start-Sleep -Milliseconds 500
}
if ($released) {
  Write-Host "  [OK] 端口 $Port 已释放" -ForegroundColor Green
} else {
  Write-Host "  [!] 端口 $Port 仍被占用，继续删除（残留进程可能需要手动处理）" -ForegroundColor Yellow
}

# 3. 移除桌面/开始菜单入口（复用现成的路径解析）
$desktopUninstall = Join-Path $RepoRoot 'scripts\install-desktop-app.ps1'
if (Test-Path $desktopUninstall) {
  try {
    & $desktopUninstall -Uninstall | Out-Null
    Write-Host "  [OK] 已清理桌面/开始菜单入口" -ForegroundColor Green
  } catch {
    Write-Host "  [!] 清理桌面/开始菜单入口失败：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# 4. 移除开机自启动入口
$autostartUninstall = Join-Path $RepoRoot 'scripts\set-autostart.ps1'
if (Test-Path $autostartUninstall) {
  try {
    & $autostartUninstall -Disable -RepoRoot $RepoRoot | Out-Null
    Write-Host "  [OK] 已清理开机自启动入口" -ForegroundColor Green
  } catch {
    Write-Host "  [!] 清理开机自启动入口失败：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# 5. 删除整个项目目录
if (Test-Path $RepoRoot) {
  # 不可逆递归删除，先确认目标确实像本项目，避免调用方传错路径时误删
  $fullRoot = [System.IO.Path]::GetFullPath($RepoRoot)
  $isDriveRoot = ($fullRoot -match '^[A-Za-z]:\\?$')
  $looksLikeRepo = (Test-Path (Join-Path $RepoRoot 'package.json')) -or (Test-Path (Join-Path $RepoRoot 'pnpm-workspace.yaml'))
  if ($isDriveRoot -or -not $looksLikeRepo) {
    Write-Host "  [X] 目标目录不像本项目：$RepoRoot，拒绝删除" -ForegroundColor Red
    exit 1
  }
  try {
    Remove-Item $RepoRoot -Recurse -Force -ErrorAction Stop
    Write-Host "  [OK] 已删除项目目录 $RepoRoot" -ForegroundColor Green
  } catch {
    Write-Host "  [X] 删除项目目录失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "  [i] 项目目录已不存在，跳过。" -ForegroundColor DarkGray
}

# 6. 清理日志（存在才删；文件被占用时跳过，不阻断卸载）
$logRoot = Join-Path $env:LOCALAPPDATA 'NotificationHub'
if (Test-Path $logRoot) {
  Remove-Item $logRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -Path $env:TEMP -Filter 'notification-hub-server*.log' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# 7. 删除自身副本。只在"项目目录之外"时删：
#    生产环境跑的是 %TEMP% 里的副本，删它正确；若有人直接跑源脚本，别把源文件删了。
$selfPath = $PSCommandPath
$inRepo = $selfPath -and $selfPath.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)
if (-not $inRepo) {
  try { Remove-Item $selfPath -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Host ""
Write-Host "  卸载完成。" -ForegroundColor Green
exit 0
