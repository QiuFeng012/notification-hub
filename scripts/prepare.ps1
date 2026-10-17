<#
  信息整合台 —— 环境自检与首次准备

  为什么需要它：仓库里不含 node_modules 与 dist（两者都在 .gitignore 里），
  所以别人刚克隆下来时双击启动，会在"构建"那一步崩掉，而且错误信息是
  pnpm 的语法错误，看不出真正原因是"还没装依赖"。

  这个脚本把"能不能跑"这件事一次说清，并且**幂等**：
    · 已经准备好时只做几次版本检查，几十毫秒就返回；
    · 缺什么补什么（装依赖、构建），补齐之后再返回。

  检查顺序按依赖关系来，前一步不通过就没必要往后走：
    1. Node 版本 ≥ 22.5（服务端用了 node:sqlite，低版本直接没有这个模块）
    2. pnpm 可用（本仓库是 pnpm workspace，npm/yarn 装出来的依赖结构不对）
    3. node_modules 存在（缺了就 pnpm install）
    4. 构建产物存在（缺了就 pnpm build）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare.ps1
    powershell -File scripts/prepare.ps1 -CheckOnly    # 只检查，不安装不构建

  退出码：0 已就绪；1 环境不满足（会打印具体原因与修复办法）
#>
[CmdletBinding()]
param(
  # 同其它脚本：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = '',
  # 只检查环境与产物，不做任何安装/构建（供 CI 或"我想看看缺什么"的场景）
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  throw "无法确定项目根目录（PSScriptRoot 为空），请从 scripts 目录内运行本脚本"
}

function Write-Step([string]$Message) { Write-Host "  $Message" -ForegroundColor DarkGray }
function Write-Ok([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "  [!] $Message" -ForegroundColor Yellow }
function Write-Err2([string]$Message) { Write-Host "  [X] $Message" -ForegroundColor Red }

# ---------- 1. Node ----------
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Err2 "没有找到 node。"
  Write-Step "请先安装 Node.js 22.5 或更高版本：https://nodejs.org/"
  exit 1
}

$nodeVersionText = (& node --version 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText)) {
  Write-Err2 "node --version 执行失败，Node.js 可能装坏了。"
  exit 1
}

# 只取主次版本：v22.5.0 → 22.5
$nodeVersion = [version](($nodeVersionText.Trim() -replace '^v', '') -replace '-.*$', '')
$required = [version]'22.5.0'
if ($nodeVersion -lt $required) {
  Write-Err2 "Node.js 版本过低：当前 $nodeVersionText，需要 22.5 或更高。"
  Write-Step "服务端用 node:sqlite 存数据，低于 22.5 的版本里没有这个模块。"
  Write-Step "升级后重新启动即可：https://nodejs.org/"
  exit 1
}
Write-Ok "Node.js $nodeVersionText"

# ---------- 2. pnpm ----------
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
  Write-Err2 "没有找到 pnpm。"
  Write-Step "本仓库是 pnpm workspace，用 npm / yarn 装出来的依赖结构不对。"
  Write-Step "任选一种方式安装后重试："
  Write-Step "  corepack enable            （Node 自带的包管理器开关）"
  Write-Step "  npm install -g pnpm"
  exit 1
}
$pnpmVersionText = (& pnpm --version 2>$null)
Write-Ok "pnpm $($pnpmVersionText.Trim())"

# ---------- 3. 依赖 ----------
$modulesDir = Join-Path $RepoRoot 'node_modules'
$modulesMarker = Join-Path $modulesDir '.modules.yaml'
$hasModules = (Test-Path $modulesMarker)
if (-not $hasModules) {
  if ($CheckOnly) {
    Write-Warn2 "依赖未安装（缺少 node_modules\.modules.yaml）。"
    Write-Step "运行不带 -CheckOnly 的 prepare.ps1，或执行：pnpm install"
    exit 1
  }
  Write-Warn2 "首次准备：正在安装依赖（几分钟，取决于网速）…"
  Push-Location $RepoRoot
  try {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      Write-Err2 "依赖安装失败，请查看上方 pnpm 的输出。"
      exit 1
    }
  } finally {
    Pop-Location
  }
  Write-Ok "依赖已安装"
} else {
  Write-Ok "依赖已安装"
}

# ---------- 4. 构建产物 ----------
# 服务端入口与前端入口都要在：少了任何一个，起起来的服务要么 404 要么直接退出
$serverEntry = Join-Path $RepoRoot 'apps\server\dist\index.js'
$webEntry = Join-Path $RepoRoot 'apps\web\dist\index.html'
$hasBuild = (Test-Path $serverEntry) -and (Test-Path $webEntry)
if (-not $hasBuild) {
  if ($CheckOnly) {
    Write-Warn2 "尚未构建（缺少 apps\server\dist 或 apps\web\dist）。"
    Write-Step "运行不带 -CheckOnly 的 prepare.ps1，或执行：pnpm build"
    exit 1
  }
  Write-Warn2 "首次准备：正在构建（约 1-2 分钟）…"
  Push-Location $RepoRoot
  try {
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
      Write-Err2 "构建失败，请查看上方输出。"
      exit 1
    }
  } finally {
    Pop-Location
  }
  Write-Ok "构建完成"
} else {
  Write-Ok "构建产物齐全"
}

Write-Ok "已就绪"
exit 0
