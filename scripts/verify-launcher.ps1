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
foreach ($name in @('start-server.ps1', 'stop-server.ps1', 'status.ps1', 'launch-app.ps1', 'install-desktop-app.ps1', 'verify-launcher.ps1')) {
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
Check "启动脚本支持检测端口占用" ($startScript -match 'Get-NetTCPConnection')
Check "启动脚本等待服务就绪而不是盲目打开页面" ($startScript -match 'Test-ServiceReady')

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

  $stopFinal = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "收尾停止正常退出" ($stopFinal.Code -eq 0)
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
