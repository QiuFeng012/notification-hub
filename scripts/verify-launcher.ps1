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
foreach ($name in @('start-server.ps1', 'stop-server.ps1', 'status.ps1', 'verify-launcher.ps1')) {
  $path = Join-Path $scriptsDir $name
  $exists = Test-Path $path
  Check "$name 存在" $exists
  if (-not $exists) { continue }

  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Check "$name 语法正确" ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
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

# 真正执行每个脚本。语法解析查不出参数默认值这类运行时错误：
# 曾经把 RepoRoot 的默认值写成 (Split-Path -Parent $PSScriptRoot)，
# 而参数默认值在 $PSScriptRoot 赋值之前求值，双击必然报错、脚本完全不可用，
# 但 ParseFile 一个错误都报不出来。所以必须真的跑一次。
Write-Host "`n3b. 真实执行（不改变服务状态）"
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
  Check "未配置 Key 时给出提示而不是报错" ($start.Output -match '未配置 DEEPSEEK_API_KEY')
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

  $stopAgain = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "停止脚本正常退出" ($stopAgain.Code -eq 0)
  Check "停止后端口已释放" (
    -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  )

  $stopIdle = Invoke-Capture (Join-Path $scriptsDir 'stop-server.ps1') @('-Port', "$Port")
  Check "重复停止不报错" ($stopIdle.Code -eq 0)
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
