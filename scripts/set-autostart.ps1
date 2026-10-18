<#
  信息整合台 —— 开机自启动开关

  在「启动」文件夹创建/移除一个快捷方式，指向 scripts\autostart.vbs
  （wscript 无窗口），由它调 launch-app.ps1 -NoLaunch 静默预热服务。

  为什么还是 wscript 包装：和桌面入口同理，隐藏窗口直接启动 powershell
  会卡在控制台句柄继承上，服务起不来。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-autostart.ps1 -Enable
    powershell -File scripts/set-autostart.ps1 -Disable
    powershell -File scripts/set-autostart.ps1 -Enable -StartupDir <目录>   # 供验证

  退出码：0 成功；1 失败
#>
[CmdletBinding()]
param(
  [switch]$Enable,
  [switch]$Disable,
  # 同其它脚本：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = '',
  # 快捷方式落地目录。默认用「启动」文件夹；传别的目录只影响快捷方式本身（供验证）
  [string]$StartupDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}

$appName = '信息整合台'
$launchWrapper = Join-Path $RepoRoot 'scripts\autostart.vbs'
$iconFile = Join-Path $RepoRoot 'apps\web\public\icon.ico'
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'

if ([string]::IsNullOrWhiteSpace($StartupDir)) {
  $StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
}
$target = Join-Path $StartupDir "$appName.lnk"

Write-Host ""
Write-Host "  信息整合台 —— 开机自启动" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

if (-not (Test-Path $launchWrapper)) {
  Write-Host "  [X] 找不到无窗口包装器：$launchWrapper" -ForegroundColor Red
  exit 1
}

# 图标不存在就退回 PowerShell 自带图标，而不是让 Windows 显示空白方块
$iconLocation = "$env:SystemRoot\System32\shell32.dll,13"
if (Test-Path $iconFile) {
  $iconLocation = "$iconFile,0"
}

if ($Disable -and -not $Enable) {
  if (Test-Path $target) {
    Remove-Item $target -Force -Confirm:$false
    Write-Host "  [OK] 已移除开机自启动入口 $target" -ForegroundColor Green
  } else {
    Write-Host "  [i] 没有找到开机自启动入口，无需移除。" -ForegroundColor DarkGray
  }
  Write-Host ""
  exit 0
}

# -Enable（或两者都给时 -Enable 优先）
try {
  if (-not (Test-Path $StartupDir)) { New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $wscriptExe
  $shortcut.Arguments = "`"$launchWrapper`""
  $shortcut.WorkingDirectory = $RepoRoot
  $shortcut.IconLocation = $iconLocation
  $shortcut.Description = '信息整合台：登录后静默预热本机服务'
  $shortcut.Save()
  Write-Host "  [OK] 已创建开机自启动入口 $target" -ForegroundColor Green
} catch {
  Write-Host "  [X] 创建失败 $target：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
Write-Host ""
exit 0
