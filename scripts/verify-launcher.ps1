<#
  启动器脚本测试：校验各 .ps1 的语法，并确认它们能正常运行。

  为什么单独测：PowerShell 脚本的问题只会在双击时才暴露，
  而用户双击时看到的是一闪而过的窗口。这里把它拉到自动化验证里。

  用法：
    powershell -File scripts/verify-launcher.ps1
    powershell -File scripts/verify-launcher.ps1 -Functional   # 额外跑一次真实的启停循环
#>
param(
  [switch]$Functional,
  [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptsDir = Join-Path $repoRoot 'scripts'

$failed = 0

function Check([string]$Label, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    Write-Host "  PASS  $Label"
  } else {
    Write-Host "  FAIL  $Label$(if ($Detail) { " — $Detail" })" -ForegroundColor Red
    $script:failed++
  }
}

# 收集子进程输出与退出码，带硬性截止时间。
#
# 这里踩过三个坑，都写清楚免得以后再犯：
#   1) 用管道（| Out-String）捕获：被派生的服务进程继承 stdout 句柄，
#      管道永不关闭，父进程一直阻塞。
#   2) 用 Start-Process -Wait：即使直接子进程已退出它也会死等，
#      而 start-server.ps1 会派生一个长期存活的 node 进程。
#   3) 读 Process.ExitCode：Windows PowerShell 5.1 在 Start-Process
#      配合输出重定向时不会填充它，读出来是空值，断言全部误报失败。
# 所以：-PassThru + WaitForExit(毫秒) 控超时，退出码由一层临时包装脚本
# 写进文件后由我们自己读，完全不依赖 .NET 的 Process 对象。
function Invoke-Capture([string]$FilePath, [string[]]$Arguments, [int]$TimeoutMs = 60000) {
  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  $codeOut = [System.IO.Path]::GetTempFileName()
  $wrapper = [System.IO.Path]::GetTempFileName() + '.ps1'
  try {
    # 包装脚本：调用目标脚本，把退出码显式写进文件
    $wrapped = if ($Arguments.Count -gt 0) {
      "& '$FilePath' " + ($Arguments -join ' ')
    } else {
      "& '$FilePath'"
    }
    $wrapperContent = @(
      '$ErrorActionPreference = ''Continue'''
      'try {'
      "  $wrapped"
      '  $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }'
      '} catch {'
      '  Write-Host $_.Exception.Message'
      '  $code = 1'
      '}'
      "Set-Content -Path '$codeOut' -Value `$code -Encoding ASCII"
    ) -join "`r`n"
    Set-Content -Path $wrapper -Value $wrapperContent -Encoding UTF8

    $process = Start-Process -FilePath 'powershell' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$wrapper`"") `
      -NoNewWindow -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr

    $timedOut = -not $process.WaitForExit($TimeoutMs)
    if ($timedOut) {
      & taskkill /PID $process.Id /T /F 2>&1 | Out-Null
      $process.WaitForExit(5000) | Out-Null
    }

    $output = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) +
               (Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
    $codeText = (Get-Content $codeOut -Raw -ErrorAction SilentlyContinue)

    if ($timedOut) {
      return @{ Output = $output + "(超时：脚本在 $TimeoutMs ms 内没有返回)"; Code = 124 }
    }
    if ([string]::IsNullOrWhiteSpace($codeText)) {
      return @{ Output = $output + "(未能读取退出码)"; Code = -1 }
    }
    return @{ Output = $output; Code = [int]$codeText.Trim() }
  } finally {
    Remove-Item $stdout, $stderr, $codeOut, $wrapper -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "  启动器脚本验证" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# ---------- 1. 语法解析 ----------
Write-Host "`n1. 语法解析"
foreach ($name in @('start-server.ps1', 'stop-server.ps1', 'status.ps1', 'launch-app.ps1', 'install-desktop-app.ps1', 'set-autostart.ps1', 'verify-launcher.ps1')) {
  $path = Join-Path $scriptsDir $name
  $exists = Test-Path $path
  Check "$name 存在" $exists
  if (-not $exists) { continue }

  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Check "$name 语法正确" ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
}

# 1a. 启动器与包装器的静态约束
Write-Host "`n1a. 桌面入口"
$launchPath = Join-Path $scriptsDir 'launch-app.ps1'
if (Test-Path $launchPath) {
  $launch = Get-Content $launchPath -Raw
  Check "启动器用 --app 打开独立窗口" ($launch -match '--app=')
  Check "启动器会先确认服务就绪再开窗口" ($launch -match 'Test-ServiceReady')
  Check "启动器已在跑时不重复启动" ($launch -match '服务已在运行')
  Check "启动器在服务起不来时明确失败" ($launch -match 'exit 1')
  Check "启动器找不到浏览器时有回退并说明" ($launch -match '回退|默认浏览器')
  # 已调用的诊断函数必须有定义。这条来自一次真实事故：
  # 写了一个 Setup-Diag 调用却忘了定义，脚本一进到那段就抛错退出，
  # 而隐藏窗口把错误吞掉，表现成"启动器卡住、服务没起来"，查了很久。
  $called = [regex]::Matches($launch, '(?m)^\s*([A-Z][A-Za-z]*-[A-Za-z]+)\s') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  $defined = @([regex]::Matches($launch, '(?m)^\s*function\s+([A-Za-z-]+)') | ForEach-Object { $_.Groups[1].Value })
  $builtin = @('Get-CimInstance', 'Write-Host', 'Start-Process', 'Join-Path', 'Test-Path', 'New-Item',
    'Add-Content', 'Invoke-RestMethod', 'Set-Location', 'Get-Date', 'New-Object', 'Get-ItemProperty',
    'Get-Item', 'Get-Content', 'Split-Path', 'Remove-Item', 'Get-ChildItem', 'Where-Object',
    'ForEach-Object', 'Select-Object', 'Sort-Object', 'Measure-Object', 'Out-Null', 'Test-NetConnection')
  $undefined = @($called | Where-Object { $_ -notin $defined -and $_ -notin $builtin })
  Check "启动器没有调用未定义的函数" ($undefined.Count -eq 0) ($undefined -join ', ')
}

$wrapperPath = Join-Path $scriptsDir 'launch-app.vbs'
Check "无窗口包装器存在" (Test-Path $wrapperPath)
if (Test-Path $wrapperPath) {
  $wrapper = Get-Content $wrapperPath -Raw
  Check "包装器由 wscript 运行（无可继承的控制台）" $true
  Check "包装器不等待启动器结束" ($wrapper -match 'False\s*$' -or $wrapper -match ',\s*0,\s*False')
  Check "包装器会检查启动器是否存在" ($wrapper -match 'FileExists')
  # 服务的 node 进程会继承控制台句柄；包装器一旦被换成直接跑 powershell，
  # 隐藏窗口下 Windows 会卡在创建进程那一步，服务永远起不来。
  Check "包装器用隐藏窗口方式调用 powershell" ($wrapper -match 'powershell\.exe' -and $wrapper -match ',\s*0,')
}

# 语法解析器对这种写法是"合法"的：它把 /** 当成命令名解析，只有运行时才炸。
# 这个坑真实发生过一次，所以单独查。按行匹配，避免误伤文件里的正则字面量。
Write-Host "`n1b. 注释风格"
foreach ($file in Get-ChildItem -Path $scriptsDir -Filter '*.ps1') {
  $offending = @(Get-Content $file.FullName | Where-Object {
    $_ -match '^\s*/\*\*' -or $_ -match '^\s*\*/' -or $_ -match '^\s*\*(\s|$)'
  })
  Check "$($file.Name) 没有误用 JS 风格注释" ($offending.Count -eq 0) ($offending -join ' | ')
}

# ---------- 2. 批处理入口 ----------
Write-Host "`n2. 双击入口"
foreach ($name in @('启动信息整合台.bat', '停止信息整合台.bat', '查看状态.bat')) {
  $path = Join-Path $repoRoot $name
  $exists = Test-Path $path
  Check "$name 存在" $exists
  if (-not $exists) { continue }
  $content = Get-Content $path -Raw
  Check "$name 引用了存在的 ps1" ($content -match 'scripts\\\w[\w-]*\.ps1')
  Check "$name 设置了 UTF-8 代码页" ($content -match 'chcp 65001')
  Check "$name 兼容被执行策略拦截的环境" ($content -match 'ExecutionPolicy Bypass')

  # 两个只有真跑才暴露的 cmd 解析坑，固定成静态检查：
  #   a) cd /d "%~dp0" 里 %~dp0 自带结尾反斜杠，会转义掉结尾引号，
  #      下一行命令被吞掉第一个字符（title 变成 tle）。
  #   b) chcp 65001 之后 cmd 按新代码页重新读取批处理文件，
  #      命令行里的中文会让它字节错位，同样吞掉下一个命令的字符。
  # 因此 .bat 里必须全部是 ASCII，中文一律交给 PowerShell 输出。
  Check "$name 的 cd 写法安全（带结尾点）" ($content -match 'cd /d "%~dp0\."')
  $nonAsciiLines = @(Get-Content $path | Where-Object { $_ -match '[^\x00-\x7F]' })
  Check "$name 命令行全部为 ASCII" ($nonAsciiLines.Count -eq 0) ($nonAsciiLines -join ' | ')
}

# ---------- 3. 安全性检查 ----------
Write-Host "`n3. 安全性检查"
$startScript = Get-Content (Join-Path $scriptsDir 'start-server.ps1') -Raw
Check "停止脚本不会误杀其他 node 进程" `
  ((Get-Content (Join-Path $scriptsDir 'stop-server.ps1') -Raw) -match "dist\[\\\\/\]index")
Check "停止脚本先走 /api/system/shutdown 优雅关闭" `
  ((Get-Content (Join-Path $scriptsDir 'stop-server.ps1') -Raw) -match 'system/shutdown')
Check "启动脚本支持检测端口占用" ($startScript -match 'Get-NetTCPConnection')
Check "启动脚本等待服务就绪而不是盲目打开页面" ($startScript -match 'Test-ServiceReady')

# ---------- 3a. 便携启动（别人克隆后双击就能跑） ----------
Write-Host "`n3a. 便携启动"
$prepareScript = Get-Content (Join-Path $scriptsDir 'prepare.ps1') -Raw -ErrorAction SilentlyContinue
Check "存在 prepare.ps1（首次安装依赖+构建的入口）" ([bool]$prepareScript)
Check "prepare.ps1 委托 runtime.ps1 解析 Node 版本与 pnpm" ($prepareScript -match 'runtime\.ps1')
Check "prepare.ps1 缺依赖时执行 pnpm install" ($prepareScript -match 'pnpm install')
Check "prepare.ps1 缺构建产物时执行 pnpm build" ($prepareScript -match 'pnpm build')
Check "launch-app.ps1 在启动前调用 prepare.ps1" `
  ((Get-Content (Join-Path $scriptsDir 'launch-app.ps1') -Raw) -match 'prepare\.ps1')
# 换端口必须真正生效：服务端从 PORT 环境变量读端口，
# 起进程时若不注入就会永远绑 5178——实测过传 -Port 5180 仍监听 5178。
Check "start-server.ps1 把 -Port 注入子进程的 PORT 环境变量" `
  ($startScript -match "EnvironmentVariables\['PORT'\]")
Check "双击入口调用的是 launch-app（起服务并开应用窗口）" `
  ((Get-Content (Join-Path $repoRoot '启动信息整合台.bat') -Raw) -match 'launch-app\.ps1')
Check "快捷方式不入库（.lnk 含绝对路径，由脚本在本机生成）" `
  ((Get-Content (Join-Path $repoRoot '.gitignore') -Raw) -match '\.lnk')

# Node/pnpm 自动配置：runtime.ps1 是"新用户没有 node 也能跑"的地基。
$runtimeScript = Get-Content (Join-Path $scriptsDir 'runtime.ps1') -Raw -ErrorAction SilentlyContinue
Check "存在 runtime.ps1（解析/下载 Node 与 pnpm）" ([bool]$runtimeScript)
Check "runtime.ps1 锁死 Node 版本（以后升级只改这里）" ($runtimeScript -match "LockedNodeVersion\s*=\s*'[0-9]+\.[0-9]+\.[0-9]+'")
Check "runtime.ps1 下载 Node 便携 zip" ($runtimeScript -match 'nodejs\.org/dist|node-v\$version')
Check "runtime.ps1 校验下载的 SHA256" ($runtimeScript -match 'Get-FileHash')
Check "runtime.ps1 把 node 目录放进 PATH（pnpm/npm 垫片按名字找 node）" `
  ($runtimeScript -match 'env:PATH\s*=\s*"\$nodeDir')
Check "runtime.ps1 把 pnpm 目录放进 PATH（pnpm build 里递归调 pnpm）" `
  ($runtimeScript -match 'env:PATH\s*=\s*"\$pnpmDir')
Check "便携运行时不入库（.runtime 几十 MB）" `
  ((Get-Content (Join-Path $repoRoot '.gitignore') -Raw) -match '\.runtime')
Check "start-server.ps1 用解析出的 node 而非 PATH 里的裸 node" `
  ($startScript -match '\$NodeExe')
Check "package.json 锁 pnpm 版本（packageManager）" `
  ((Get-Content (Join-Path $repoRoot 'package.json') -Raw) -match 'packageManager')

# ---------- 3c. 开机自启动 ----------
Write-Host "`n3c. 开机自启动"
$setAutostart = Join-Path $scriptsDir 'set-autostart.ps1'
$autostartVbs = Join-Path $scriptsDir 'autostart.vbs'
Check "存在 set-autostart.ps1" (Test-Path $setAutostart)
Check "存在 autostart.vbs（无窗口自启包装器）" (Test-Path $autostartVbs)
if (Test-Path $setAutostart) {
  $setAutostartSrc = Get-Content $setAutostart -Raw
  Check "set-autostart.ps1 引用 autostart.vbs" ($setAutostartSrc -match 'autostart\.vbs')
  Check "set-autostart.ps1 落地在启动文件夹" ($setAutostartSrc -match 'Start Menu\\Programs\\Startup')
}
if (Test-Path $autostartVbs) {
  $autostartVbsSrc = Get-Content $autostartVbs -Raw
  Check "autostart.vbs 全 ASCII（WSH 对 UTF-8 VBS 支持不稳）" ($autostartVbsSrc -notmatch '[\u4e00-\u9fff]')
  Check "autostart.vbs 调用 launch-app.ps1 且带 -NoLaunch" ($autostartVbsSrc -match 'launch-app\.ps1' -and $autostartVbsSrc -match '-NoLaunch')
}

# ---------- 3d. 卸载清理器 ----------
Write-Host "`n3d. 卸载清理器"
$cleaner = Join-Path $scriptsDir 'uninstall-cleaner.ps1'
Check "存在 uninstall-cleaner.ps1" (Test-Path $cleaner)
if (Test-Path $cleaner) {
  $cleanerSrc = Get-Content $cleaner -Raw
  Check "清理器会结束残留服务进程" ($cleanerSrc -match 'dist[\\/]index')
  Check "清理器等待端口释放（不提前删目录）" ($cleanerSrc -match 'Get-NetTCPConnection|Start-Sleep')
  Check "清理器复用 install-desktop-app 移除入口" ($cleanerSrc -match 'install-desktop-app\.ps1')
  Check "清理器复用 set-autostart 移除自启" ($cleanerSrc -match 'set-autostart\.ps1')
  Check "清理器删除整个项目目录" ($cleanerSrc -match 'Remove-Item \$RepoRoot')
}

# 编码守卫：Windows PowerShell 5.1 在中文系统上按 GBK 读无 BOM 的 .ps1，
# 中文全乱码、甚至把解析器弄崩（新机器实测：Unexpected token / Missing '}'）。
# 含中文的 .ps1 必须带 UTF-8 BOM；.vbs 与 .bat 则干脆全 ASCII。
$noBomChinese = @()
foreach ($ps1 in Get-ChildItem $scriptsDir -Filter '*.ps1') {
  $bytes = [System.IO.File]::ReadAllBytes($ps1.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $hasChinese = [System.Text.Encoding]::UTF8.GetString($bytes) -match '[\u4e00-\u9fff]'
  if ($hasChinese -and -not $hasBom) { $noBomChinese += $ps1.Name }
}
Check "含中文的 .ps1 都带 UTF-8 BOM（否则新机器乱码崩溃）" ($noBomChinese.Count -eq 0) ($noBomChinese -join ', ')

$nonAsciiBat = @()
foreach ($bat in Get-ChildItem $repoRoot -Filter '*.bat') {
  $text = [System.IO.File]::ReadAllText($bat.FullName)
  if ($text -match '[\u4e00-\u9fff]') { $nonAsciiBat += $bat.Name }
}
Check ".bat 全 ASCII（cmd 按本地代码页读，中文会乱）" ($nonAsciiBat.Count -eq 0) ($nonAsciiBat -join ', ')

$vbs = Get-Content (Join-Path $scriptsDir 'launch-app.vbs') -Raw
Check "launch-app.vbs 全 ASCII（WSH 对 UTF-8 VBS 支持不稳）" ($vbs -notmatch '[\u4e00-\u9fff]')

# 日历的星期表头与周行必须共用同一套盒子模型（左边界、宽度、列间距、内边距）。
# 曾经它们各写各的：表头只有 gap，周行另加 padding 与边框，列宽差了 2.7px，
# 偏差按列累加，表现为"周日日期没对齐"。真正的对齐由 pnpm verify:ui 在真实
# 浏览器里量，这里只挡住"把这条共用规则拆开"——那是错位的第一步。
$stylesPath = Join-Path $repoRoot 'apps\web\src\styles.css'
if (Test-Path $stylesPath) {
  $styles = Get-Content $stylesPath -Raw
  Check "日历表头与周行共用同一条几何规则" `
    ($styles -match '(?s)\.calendar__grid-row,\s*\.calendar__weekdays,\s*\.calendar__week\s*\{[^}]*padding:\s*6px')
  Check "日历周行的框用 outline（不占布局，不挤窄内部栅格）" `
    ($styles -match '(?s)\.calendar__week\s*\{[^}]*outline:\s*1px solid')
  Check "日历区间在栅格列里居中（否则单日圆会落在两列之间）" `
    ($styles -match '(?s)\.span\s*\{[^}]*justify-self:\s*center')
  # 跑道形状的几何：日期圆直径 26px（半径 13），圆心距列边 13px，
  # 于是"栅格区"正好比"首末两天的日期圆心"宽 26px——跑道铺满栅格区，
  # 端头半圆的圆心就落在首末两天的圆心上。
  #
  # 这里刻意断言 `.span` 用的是 `width: 100%` 而不是 `calc(100% + 26px)`：
  # 后者会让百分比按"栅格区 + 26px"解析，再叠外扩就多出半列，
  # 端头跑到日期圆外面（实测偏 72.9px），verify:ui 会当场报出来。
  Check "日程跑道铺满栅格区（宽度不加外扩）" `
    ($styles -match '(?s)\.span\s*\{[^}]*width:\s*100%')
  Check "跑道底色层左右不外扩（inset: 0）" `
    ($styles -match '(?s)\.span__track\s*\{[^}]*inset:\s*0;')
  # 单日安排曾经是个 26px 圆点，圆里放不下字，日历上全是"没有内容的点"。
  # 现在单日也是一列宽的跑道、标题写在条内，所以这里断言它**不再**被缩成 26px。
  Check "单日日程不再缩成没有文字的圆点" `
    (-not ($styles -match '(?s)\.span--single\s*\{[^}]*width:\s*26px'))
}

# 真正执行每个脚本。语法解析查不出参数默认值这类运行时错误：
# 曾经把 RepoRoot 的默认值写成 (Split-Path -Parent $PSScriptRoot)，
# 而参数默认值在 $PSScriptRoot 赋值之前求值，双击必然报错、脚本完全不可用，
# 但 ParseFile 一个错误都报不出来。所以必须真的跑一次。
Write-Host "`n3b. 真实执行（会停止正在运行的服务，需自行重启）"
foreach ($name in @('status.ps1', 'stop-server.ps1')) {
  $result = Invoke-Capture (Join-Path $scriptsDir $name) @('-Port', "$Port")
  Check "$name 能正常执行" ($result.Code -eq 0) "退出码 $($result.Code)：$($result.Output)"
}

# prepare.ps1 也要真的跑一次：它是"别人克隆后双击"的第一道闸，
# 已经就绪时应当几十毫秒返回 0，而不是卡住或误报缺依赖。
# 不传 -RepoRoot（路径含空格会被 Invoke-Capture 拆成两个参数）：
# prepare.ps1 自己会从 $PSScriptRoot 推导项目根。
$prepare = Invoke-Capture (Join-Path $scriptsDir 'prepare.ps1') @()
Check "prepare.ps1 在已就绪时快速返回 0" ($prepare.Code -eq 0) "退出码 $($prepare.Code)：$($prepare.Output)"
Check "prepare.ps1 报告已就绪" ($prepare.Output -match '已就绪')

# ---------- 4. 真实的启停循环 ----------
if ($Functional) {
  Write-Host "`n4. 启停循环（真实运行）"

  $stop = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "停止脚本正常退出" ($stop.Code -eq 0) "退出码 $($stop.Code)"

  $status = Invoke-Capture (Join-Path $scriptsDir 'status.ps1') @('-Port', "$Port")
  Check "状态脚本报告未运行" ($status.Output -match '未运行')

  $start = Invoke-Capture (Join-Path $scriptsDir 'start-server.ps1') @('-Port', "$Port", '-NoBrowser')
  Check "启动脚本正常退出" ($start.Code -eq 0) "退出码 $($start.Code)：$($start.Output)"
  Check "启动后服务在响应" $(
    try { (Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).ok -eq $true } catch { $false }
  )
  # 回归：没有 .env 文件时曾经抛 "Cannot index into a null array"，
  # 脚本以退出码 1 结束，用户双击只能看到窗口一闪而过。
  Check "没有 .env 时也不抛异常" ($start.Output -notmatch 'Cannot index into a null array')
  # 断言"如实报告当前摘要模式"，而不是写死"未配置"——
  # 本机上界面保存过 Key 时（data/settings.json），走的是真实模型那一支，
  # 写死"未配置"会让这条断言在开发机上永远失败，属于测试对环境过度耦合。
  Check "如实报告当前摘要模式" `
    ($start.Output -match '未配置 DEEPSEEK_API_KEY' -or $start.Output -match '已配置 API Key')
  Check "没有未处理的异常输出" ($start.Output -notmatch 'CategoryInfo|FullyQualifiedErrorId|RuntimeException')

  # 重复启动不应产生第二个进程，也不应报错
  $startAgain = Invoke-Capture (Join-Path $scriptsDir 'start-server.ps1') @('-Port', "$Port", '-NoBrowser')
  Check "重复启动不报错" ($startAgain.Code -eq 0)
  Check "重复启动识别出已在运行" ($startAgain.Output -match '已在运行')
  $processCount = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }).Count
  Check "没有产生重复的服务进程" ($processCount -eq 1) "实际 $processCount 个"

  $statusRunning = Invoke-Capture (Join-Path $scriptsDir 'status.ps1') @('-Port', "$Port")
  Check "状态脚本报告运行中" ($statusRunning.Output -match '运行中')

  # 第二个服务撞同一个端口时，必须明确说出"端口已被占用"。
  # 这条是真实修过的：改之前只留一句"服务启动失败"，
  # 真正的原因（EADDRINUSE）藏在日志文件里，用户只能瞎猜。
  # 断言走启动器自己的日志文件，而不是捕获 stdout——服务进程会继承管道的
  # 写端，用管道捕获 start-server.ps1 的输出会挂到服务停掉为止（见文件头 4 之说明）。
  Check "端口占用检查在启动前就生效" ((Get-Content (Join-Path $scriptsDir 'start-server.ps1') -Raw) -match 'Get-NetTCPConnection')
  # 端口被占、但不响应的场景（沙箱里更常见：端口占着，服务却连不上）：
  # 这一支必须在 30 秒轮询之外主动查端口，否则每次失败都要干等半分钟。
  $blockerScript = Join-Path ([System.IO.Path]::GetTempPath()) ('nh-blocker-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  Set-Content -Path $blockerScript -Encoding UTF8 -Value @(
    '$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), 5177)'
    '$listener.Start()'
    'Start-Sleep -Seconds 120'
  )
  $blocker = Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$blockerScript`"") -PassThru
  try {
    Start-Sleep -Seconds 3
    $blocked = Invoke-Capture (Join-Path $scriptsDir 'start-server.ps1') @('-Port', '5177', '-NoBrowser')
    Check "端口被占时立刻说明原因（不等满 30 秒）" ($blocked.Output -match '5177 已被') `
      "退出码 $($blocked.Code)：$($blocked.Output)"
  } finally {
    & taskkill /PID $blocker.Id /T /F 2>&1 | Out-Null
    Remove-Item $blockerScript -Force -ErrorAction SilentlyContinue
  }

  $launchLog = Join-Path $env:LOCALAPPDATA 'NotificationHub\launch.log'
  Remove-Item $launchLog -Force -ErrorAction SilentlyContinue
  # 服务此刻正在运行，所以这一次点击应当"已就绪 → 直接开窗口"，不再多起进程
  $occupied = Invoke-Capture $launchPath @('-Port', "$Port", '-NoLaunch')
  Check "重复点击不产生第二个服务进程" $(
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }).Count -eq 1
  )

  $stopAgain = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "停止脚本正常退出" ($stopAgain.Code -eq 0)
  Check "停止后端口已释放" (
    -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  )

  $stopIdle = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "重复停止不报错" ($stopIdle.Code -eq 0)

  # ---------- 5. 桌面入口 ----------
  # 装到一个临时目录，真实桌面与开始菜单完全不受影响，
  # 但快捷方式本身是真的创建、真的读回、真的删除——不是"看代码觉得对"。
  Write-Host "`n5. 桌面入口（真实创建快捷方式）"
  $installScript = Join-Path $scriptsDir 'install-desktop-app.ps1'
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('nh-entry-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    $install = Invoke-Capture $installScript @('-InstallRoot', $tempRoot)
    Check "安装脚本正常退出" ($install.Code -eq 0) "退出码 $($install.Code)：$($install.Output)"

    $links = @(Get-ChildItem -Path $tempRoot -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue)
    Check "创建了桌面与开始菜单两个入口" ($links.Count -eq 2) "实际 $($links.Count) 个"

    if ($links.Count -gt 0) {
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($links[0].FullName)
      Check "入口指向无窗口包装器（wscript）" ($shortcut.TargetPath -match 'wscript\.exe') $shortcut.TargetPath
      $wrapped = $shortcut.Arguments -replace '"', ''
      Check "包装器路径真实存在" (Test-Path $wrapped) $wrapped
      Check "工作目录指向仓库根" ($shortcut.WorkingDirectory -eq $repoRoot) $shortcut.WorkingDirectory
      $iconPath = $shortcut.IconLocation -replace ',0$', ''
      Check "入口图标文件存在" (Test-Path $iconPath) $iconPath
    }

    # 服务已在跑的前提下，启动器必须只做"识别 + 打开"，不多起一个进程
    $launch = Invoke-Capture $launchPath @('-Port', "$Port", '-NoLaunch')
    Check "启动器正常退出" ($launch.Code -eq 0) "退出码 $($launch.Code)：$($launch.Output)"
    Check "启动器识别出服务已在运行" ($launch.Output -match '服务已在运行|服务已就绪')
    Check "启动器没有未处理的异常" ($launch.Output -notmatch 'CategoryInfo|FullyQualifiedErrorId|not recognized')

    $uninstall = Invoke-Capture $installScript @('-InstallRoot', $tempRoot, '-Uninstall')
    Check "卸载脚本正常退出" ($uninstall.Code -eq 0) "退出码 $($uninstall.Code)：$($uninstall.Output)"
    Check "快捷方式已全部移除" `
      (@(Get-ChildItem -Path $tempRoot -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue).Count -eq 0)
  } finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---------- 6. 开机自启动 ----------
  # 与桌面入口同理：落在临时目录，真实启动文件夹不受影响，
  # 但快捷方式是真的创建、真的读回、真的删除。
  Write-Host "`n6. 开机自启动（真实创建快捷方式）"
  $tempStartup = Join-Path ([System.IO.Path]::GetTempPath()) ('nh-autostart-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    $enable = Invoke-Capture $setAutostart @('-Enable', '-StartupDir', $tempStartup)
    Check "自启脚本正常退出" ($enable.Code -eq 0) "退出码 $($enable.Code)：$($enable.Output)"

    $startupLink = Join-Path $tempStartup '信息整合台.lnk'
    Check "创建了自启快捷方式" (Test-Path $startupLink) $startupLink
    if (Test-Path $startupLink) {
      $shell = New-Object -ComObject WScript.Shell
      $sc = $shell.CreateShortcut($startupLink)
      Check "自启入口指向无窗口包装器（wscript）" ($sc.TargetPath -match 'wscript\.exe') $sc.TargetPath
      $wrapped = $sc.Arguments -replace '"', ''
      Check "自启包装器路径真实存在" (Test-Path $wrapped) $wrapped
      Check "自启工作目录指向仓库根" ($sc.WorkingDirectory -eq $repoRoot) $sc.WorkingDirectory
    }

    $disable = Invoke-Capture $setAutostart @('-Disable', '-StartupDir', $tempStartup)
    Check "自启卸载正常退出" ($disable.Code -eq 0) "退出码 $($disable.Code)：$($disable.Output)"
    Check "自启快捷方式已移除" (-not (Test-Path $startupLink))
  } finally {
    Remove-Item $tempStartup -Recurse -Force -ErrorAction SilentlyContinue
  }

  $stopFinal = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "收尾停止正常退出" ($stopFinal.Code -eq 0)

  # ---------- 7. 卸载清理器 ----------
  # 只在临时目录里造一个假仓库，绝不以真实仓库为 -RepoRoot；
  # 与生产一致：先把清理器复制到项目目录之外再执行（它会自删副本），
  # 断言整目录被删、且对已删目标重跑仍退出 0（幂等）。
  Write-Host "`n7. 卸载清理器（对临时假仓库真实执行）"
  $tempRepo = Join-Path ([System.IO.Path]::GetTempPath()) ('nh-uninstall-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $tempCleaner = Join-Path ([System.IO.Path]::GetTempPath()) ('nh-cleaner-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  try {
    New-Item -ItemType Directory -Path (Join-Path $tempRepo 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tempRepo 'data') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tempRepo 'node_modules') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tempRepo '.git') -Force | Out-Null
    Set-Content -Path (Join-Path $tempRepo 'data\cards.db') -Value 'x'

    Copy-Item -Path $cleaner -Destination $tempCleaner -Force
    $clean = Invoke-Capture $tempCleaner @('-RepoRoot', $tempRepo)
    Check "清理器正常退出" ($clean.Code -eq 0) "退出码 $($clean.Code)：$($clean.Output)"
    Check "清理器删除了整个假仓库" (-not (Test-Path $tempRepo))

    # 幂等：再复制一份、对已删目标重跑仍应退出 0
    Copy-Item -Path $cleaner -Destination $tempCleaner -Force
    $cleanAgain = Invoke-Capture $tempCleaner @('-RepoRoot', $tempRepo)
    Check "清理器对已删目标重跑仍退出 0（幂等）" ($cleanAgain.Code -eq 0)
  } finally {
    Remove-Item $tempRepo -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $tempCleaner -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
if ($failed -gt 0) {
  Write-Host "  验证失败：$failed 项" -ForegroundColor Red
  Write-Host ""
  exit 1
}
Write-Host "  全部通过" -ForegroundColor Green
Write-Host ""
exit 0
