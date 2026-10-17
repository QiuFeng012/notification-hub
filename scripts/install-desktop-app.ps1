<#
  信息整合台 —— 创建/移除桌面入口

  创建两个快捷方式（桌面 + 开始菜单），目标都是 launch-app.ps1：
  点它时服务没在跑就后台拉起，然后以独立窗口打开界面。
  这样就不再需要"先回项目目录双击启动脚本"。

  为什么是快捷方式而不是指望那个 PWA 图标：浏览器安装出来的应用
  无法启动本机进程，这件事在浏览器沙箱内没有变通办法。

  ★ 装完之后，**原来从浏览器装出来的那个 PWA 图标不会跟着变**。
    它仍然只会在服务已经跑起来时打开，服务没跑时显示离线说明页。
    有两种处理方式，留给你选：

      1. 不用卸载它，改用这个新图标点开即可（推荐，最省事）；
      2. 想彻底不留两套入口，就在 Edge/Chrome 里打开 edge://apps
         （或 chrome://apps），在「信息整合台」上右键 → 卸载。
         数据都在 data\ 目录里，不受影响。

  另外，从浏览器装出来的那个应用窗口在 Edge 里会一直留在任务栏
  （关闭窗口后浏览器进程还活着），--app 窗口没有这个问题。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-app.ps1
    powershell -File scripts/install-desktop-app.ps1 -Uninstall
    powershell -File scripts/install-desktop-app.ps1 -InstallRoot <目录>   # 供验证使用

  退出码：0 成功；1 失败
#>
[CmdletBinding()]
param(
  # 移除已创建的快捷方式
  [switch]$Uninstall,
  # 快捷方式的落地目录。默认只写家目录下的桌面与开始菜单；
  # 传别的目录只影响快捷方式本身（供自动化验证用临时目录，不污染真实桌面）。
  [string]$InstallRoot = '',
  # 只创建桌面快捷方式，不碰开始菜单
  [switch]$DesktopOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}

$appName = '信息整合台'
$launchScript = Join-Path $repoRoot 'scripts\launch-app.ps1'
$launchWrapper = Join-Path $repoRoot 'scripts\launch-app.vbs'
$iconFile = Join-Path $repoRoot 'apps\web\public\icon.ico'
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'

Write-Host ""
Write-Host "  信息整合台 —— 桌面入口" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

if (-not (Test-Path $launchScript)) {
  Write-Host "  [X] 找不到启动脚本：$launchScript" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $launchWrapper)) {
  Write-Host "  [X] 找不到无窗口包装器：$launchWrapper" -ForegroundColor Red
  exit 1
}

# 快捷方式指向 VBS 包装器，而不是直接指 powershell -WindowStyle Hidden。
# 原因见 launch-app.vbs 头部：服务的 node 进程会继承控制台句柄，
# 用隐藏窗口直接启动启动器会被 Windows 卡在创建进程那一步，服务起不来。
# 包装器由 wscript 执行，没有控制台可继承，这条链才是通的。
$targetPath = $wscriptExe
$arguments = "`"$launchWrapper`""

# 快捷方式的图标。图标文件不在就退回 PowerShell 自带图标，
# 而不是让 Windows 显示一个空白方块——同时明确告诉用户怎么补上。
$iconLocation = "$env:SystemRoot\System32\shell32.dll,13"
if (Test-Path $iconFile) {
  $iconLocation = "$iconFile,0"
}

# 快捷方式落地位置
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  # 桌面用 shell 自己的说法取，能正确处理 OneDrive 重定向过的情况；
  # 取不到再退回 %USERPROFILE%\Desktop。
  $desktopDir = ''
  try { $desktopDir = [Environment]::GetFolderPath('Desktop') } catch { }
  if ([string]::IsNullOrWhiteSpace($desktopDir)) {
    $desktopDir = Join-Path $env:USERPROFILE 'Desktop'
  }
  $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
} else {
  # 验证模式：桌面与开始菜单都落到这个目录下，真实桌面完全不受影响
  $desktopDir = $InstallRoot
  $startMenuDir = Join-Path $InstallRoot 'StartMenu'
}

$targets = @()
if ($desktopDir) { $targets += (Join-Path $desktopDir "$appName.lnk") }
if (-not $DesktopOnly) { $targets += (Join-Path $startMenuDir "$appName.lnk") }

# ---------- 移除 ----------
if ($Uninstall) {
  $removed = 0
  foreach ($target in $targets) {
    if (Test-Path $target) {
      # -Confirm:$false：脚本多次运行时（自动化验证会真的跑卸载），
      # 不能停在"是否确认删除"上等输入
      Remove-Item $target -Force -Confirm:$false
      Write-Host "  [OK] 已移除 $target" -ForegroundColor Green
      $removed++
    }
  }
  if ($removed -eq 0) {
    Write-Host "  [i] 没有找到已创建的快捷方式，无需移除。" -ForegroundColor DarkGray
  } else {
    Write-Host ""
    Write-Host "  说明：只移除了快捷方式，服务与数据都没动。" -ForegroundColor DarkGray
    Write-Host "        需要停掉正在运行的服务请双击「停止信息整合台.bat」。" -ForegroundColor DarkGray
  }
  Write-Host ""
  exit 0
}

# ---------- 创建 ----------
if (-not (Test-Path $iconFile)) {
  Write-Host "  [!] 找不到图标 $iconFile" -ForegroundColor Yellow
  Write-Host "      快捷方式会退回 PowerShell 默认图标。" -ForegroundColor DarkGray
  Write-Host "      补上它：npx tsx scripts/build-icons.mts" -ForegroundColor DarkGray
}

$created = 0
$failed = 0
foreach ($target in $targets) {
  try {
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($target)
    $shortcut.TargetPath = $targetPath
    $shortcut.Arguments = $arguments
    # 工作目录必须写死成仓库根：启动器自己不依赖 cwd，但出问题时
    # "双击后行为异常"的第一嫌疑就是工作目录，写死它省一轮排查。
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.IconLocation = $iconLocation
    $shortcut.Description = '信息整合台：自动确保服务在跑，并以独立窗口打开'
    $shortcut.Save()
    Write-Host "  [OK] 已创建 $target" -ForegroundColor Green
    $created++
  } catch {
    Write-Host "  [X] 创建失败 $target：$($_.Exception.Message)" -ForegroundColor Red
    $failed++
  }
}

Write-Host ""
if ($failed -gt 0) {
  Write-Host "  有 $failed 个快捷方式创建失败。" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host "  已创建 $created 个入口。现在点桌面（或开始菜单）的「$appName」即可：" -ForegroundColor Cyan
Write-Host "    服务没在跑 → 自动在后台拉起；已在跑 → 直接打开" -ForegroundColor DarkGray
Write-Host "    窗口是独立应用窗口，没有地址栏" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  想撤掉这些入口：-Uninstall（见本脚本头部说明）" -ForegroundColor DarkGray
Write-Host "  想停掉服务：双击「停止信息整合台.bat」" -ForegroundColor DarkGray
Write-Host ""
exit 0
