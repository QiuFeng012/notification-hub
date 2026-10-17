<#
  runtime.ps1 —— Node 与 pnpm 的解析（含自动下载）

  这个脚本是整个"便携启动"的地基：它回答一个唯一的问题——
  "跑这个仓库该用哪个 node、哪个 pnpm"，并且在都没有的时候自动备好，
  而不是让新用户在启动时报出一堆看不懂的 pnpm 错误。

  用法：dot-source（`.`）本脚本，之后 `$NodeExe` / `$PnpmCmd` 就是可用的路径。

    . (Join-Path $PSScriptRoot 'runtime.ps1')
    & $NodeExe --version
    & $PnpmCmd install

  解析顺序（谁先满足就用谁，绝不重复下载）：
    1. 仓库里 `.runtime\node\node.exe`（锁死版本，之前下好的）
    2. 系统 PATH 里的 node（版本 ≥ 最低要求；这是开发机最常见的情况）
    3. 都没有 → 下载**锁死版本**的 Node 便携 zip 到 `.runtime\node`，
       再用它的 npm 把 pnpm 装到 `.runtime\pnpm`

  为什么锁死版本：`node:sqlite` 这类内置模块会随版本变化，低版本甚至没有。
  写死一个版本，保证"每个人跑起来的是同一个环境"；以后要升级只改下面这一处。
  最低要求与锁死版本分开：开发机用更高版本没关系，只有**下载**才按锁死版本走。
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 避免 Invoke-WebRequest 在 5.1 下画进度条卡住

# ---------- 版本（升级只改这里） ----------
$script:LockedNodeVersion = '24.21.0'
$script:MinNodeVersion = '22.5.0'      # node:sqlite 从此版本起内置
$script:PnpmVersion = '12.4.1'

# ---------- 路径 ----------
if (-not $PSScriptRoot) { throw "runtime.ps1 必须以脚本方式执行（PSScriptRoot 为空）" }
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeRoot = Join-Path $RepoRoot '.runtime'
$script:NodeDir = Join-Path $RuntimeRoot 'node'
$script:NodeExe = Join-Path $NodeDir 'node.exe'

function Get-Version([string]$VersionText) {
  if ([string]::IsNullOrWhiteSpace($VersionText)) { return $null }
  $clean = $VersionText.Trim().TrimStart('v')
  try { return [version]$clean } catch { return $null }
}

function Test-VersionAtLeast([string]$VersionText, [string]$Minimum) {
  $v = Get-Version $VersionText
  $m = Get-Version $Minimum
  if ($null -eq $v -or $null -eq $m) { return $false }
  return $v -ge $m
}

function Get-NodeArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  return 'x64'
}

function Write-Step([string]$Message) { Write-Host "  $Message" -ForegroundColor DarkGray }
function Write-Ok([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Err2([string]$Message) { Write-Host "  [X] $Message" -ForegroundColor Red }

# 系统 PATH 里的 node，满足最低版本才认
function Resolve-SystemNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = (& $cmd.Source --version 2>$null)
    if (Test-VersionAtLeast $ver $MinNodeVersion) { return $cmd.Source }
  }
  return $null
}

# 下载锁死版本的 Node 便携 zip，校验 SHA256，解压到 .runtime\node
function Install-LocalNode {
  $arch = Get-NodeArch
  $version = $LockedNodeVersion
  $zipName = "node-v$version-win-$arch.zip"
  $baseUrl = "https://nodejs.org/dist/v$version"
  $zipUrl = "$baseUrl/$zipName"
  $sumUrl = "$baseUrl/SHASUMS256.txt"
  $tmpZip = Join-Path $env:TEMP $zipName

  Write-Step "正在下载 Node.js v$version（$arch，约 30MB）…"
  Write-Step $zipUrl
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
  } catch {
    throw "下载 Node 失败：$($_.Exception.Message)"
  }

  # 校验 SHA256，防下载被篡改或截断
  Write-Step "正在校验下载完整性…"
  $expected = $null
  try {
    $sums = (Invoke-WebRequest -Uri $sumUrl -UseBasicParsing).Content -split "`r?`n"
    foreach ($line in $sums) {
      if ($line -match [regex]::Escape($zipName)) {
        $expected = ($line -split '\s+')[0].Trim().ToLower()
        break
      }
    }
  } catch {
    Write-Step "拿不到校验文件，跳过 SHA256 校验（不推荐）"
  }
  if ($expected) {
    $actual = (Get-FileHash -Path $tmpZip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
      Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
      throw "下载的 Node 校验失败：期望 $expected，实际 $actual"
    }
    Write-Ok "校验通过"
  }

  # 解压到临时目录再改名，避免半途失败留下半个运行时
  $tmpExtract = Join-Path $env:TEMP ("node-$version-" + [guid]::NewGuid().ToString('N'))
  $inner = Join-Path $tmpExtract "node-v$version-win-$arch"
  New-Item -ItemType Directory -Path $tmpExtract -Force | Out-Null
  try {
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    Move-Item -Path $inner -Destination $NodeDir
  } finally {
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Ok "Node.js 已备好（.runtime\node）"
}

# 装 pnpm：优先本机已有的，否则用当前 node 的 npm 装到 .runtime\pnpm
function Resolve-Pnpm {
  $localPnpm = Join-Path $RuntimeRoot 'pnpm\pnpm.cmd'
  if (Test-Path $localPnpm) { return $localPnpm }

  $sysPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($sysPnpm) { return $sysPnpm.Source }

  # 都没有：用 node 的 npm 装一个本地 pnpm（不进系统、不要管理员）
  $npmCmd = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
  if (-not (Test-Path $npmCmd)) { throw "找不到 npm（$npmCmd），无法安装 pnpm" }
  $prefix = Join-Path $RuntimeRoot 'pnpm'
  Write-Step "正在安装 pnpm@$PnpmVersion（到 .runtime\pnpm，不影响系统）…"
  # npm 会把「有 install 脚本但没进 allowScripts 白名单」这类**警告**写到 stderr，
  # 而在 $ErrorActionPreference='Stop' 下 PowerShell 会把它们当成致命错误，
  # 结果是 pnpm 明明装好了、脚本却退出了。所以这里放宽到 Continue、只看退出码。
  $previousEA = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $npmCmd install --global "pnpm@$PnpmVersion" --prefix $prefix 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "npm 安装 pnpm 失败（退出码 $LASTEXITCODE）"
    }
  } finally {
    $ErrorActionPreference = $previousEA
  }
  if (-not (Test-Path $localPnpm)) {
    # npm 的 bin 位置随版本略有差异，补一个兜底
    $alt = Join-Path $prefix 'node_modules\.bin\pnpm.cmd'
    if (Test-Path $alt) { return $alt }
    throw "pnpm 安装后仍找不到可执行文件（$localPnpm）"
  }
  return $localPnpm
}

# 主入口：把 $NodeExe / $PnpmCmd 解析好。已就绪时几十毫秒返回。
# -CheckOnly：只检查，绝不下载/安装（供"我想看看缺什么"的场景）。
function Initialize-Runtime([switch]$CheckOnly) {
  $resolved = $null

  # 1. 仓库里的锁死版本 runtime
  if (Test-Path $NodeExe) {
    $ver = (& $NodeExe --version 2>$null)
    if (Test-VersionAtLeast $ver $MinNodeVersion) { $resolved = $NodeExe }
  }
  # 2. 系统 node（开发机）
  if (-not $resolved) { $resolved = Resolve-SystemNode }
  # 3. 都没有
  if (-not $resolved) {
    if ($CheckOnly) {
      Write-Err2 "没有可用的 Node.js（需要 ≥ $MinNodeVersion）。"
      Write-Step "运行不带 -CheckOnly 的 prepare.ps1 会自动下载锁死版本 Node v$LockedNodeVersion。"
      exit 1
    }
    Install-LocalNode
    $resolved = $NodeExe
  }

  $script:NodeExe = $resolved
  # 把 node 所在目录放进 PATH：pnpm / npm 的 .cmd 垫片按名字找 node，
  # 新用户 PATH 里没有 node 时它们会找不到。只影响本次进程与它的子进程。
  $nodeDir = Split-Path -Parent $resolved
  if ($env:PATH -notmatch [regex]::Escape($nodeDir)) {
    $env:PATH = "$nodeDir;$env:PATH"
  }
  $script:PnpmCmd = Resolve-Pnpm
  # pnpm 目录也要进 PATH：pnpm build 里会递归调 `pnpm --filter ...`，
  # 那层是新的 shell 进程，按名字找 pnpm，找不到就报 'pnpm' is not recognized。
  $pnpmDir = Split-Path -Parent $PnpmCmd
  if ($env:PATH -notmatch [regex]::Escape($pnpmDir)) {
    $env:PATH = "$pnpmDir;$env:PATH"
  }
}
