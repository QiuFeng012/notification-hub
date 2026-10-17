<#
  信息整合台 —— 环境自检与首次准备

  为什么需要它：仓库里不含 node_modules 与 dist（两者都在 .gitignore 里），
  所以别人刚克隆下来时双击启动，会在"构建"那一步崩掉，而且错误信息是
  pnpm 的语法错误，看不出真正原因是"还没装依赖"。

  这个脚本把"能不能跑"这件事一次说清，并且**幂等**：
    · 已经准备好时只做几次检查，几十毫秒就返回；
    · 缺什么补什么（Node / pnpm / 依赖 / 构建），补齐之后再返回。

  Node 与 pnpm 的解析、下载交给 runtime.ps1（锁死版本，见那里的说明）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare.ps1
    powershell -File scripts/prepare.ps1 -CheckOnly    # 只检查，不下载不安装不构建

  退出码：0 已就绪；1 环境不满足（会打印具体原因与修复办法）
#>
[CmdletBinding()]
param(
  # 同其它脚本：参数默认值里不能用 $PSScriptRoot，那时它还是空串
  [string]$RepoRoot = '',
  # 只检查环境与产物，不做任何下载/安装/构建（供 CI 或"我想看看缺什么"的场景）
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

# ---------- 0. 解析 Node / pnpm（可能下载锁死版本） ----------
. (Join-Path $PSScriptRoot 'runtime.ps1')
Initialize-Runtime -CheckOnly:$CheckOnly
Write-Ok "Node.js $(& $NodeExe --version)"
Write-Ok "pnpm $(& $PnpmCmd --version)"

# ---------- 1. 依赖 ----------
$modulesDir = Join-Path $RepoRoot 'node_modules'
$modulesMarker = Join-Path $modulesDir '.modules.yaml'
if (-not (Test-Path $modulesMarker)) {
  if ($CheckOnly) {
    Write-Warn2 "依赖未安装（缺少 node_modules\.modules.yaml）。"
    Write-Step "运行不带 -CheckOnly 的 prepare.ps1，或执行：pnpm install"
    exit 1
  }
  Write-Warn2 "首次准备：正在安装依赖（几分钟，取决于网速）…"
  Push-Location $RepoRoot
  try {
    & $PnpmCmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  [X] 依赖安装失败，请查看上方 pnpm 的输出。" -ForegroundColor Red
      exit 1
    }
  } finally {
    Pop-Location
  }
  Write-Ok "依赖已安装"
} else {
  Write-Ok "依赖已安装"
}

# ---------- 2. 构建产物 ----------
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
    & $PnpmCmd build
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  [X] 构建失败，请查看上方输出。" -ForegroundColor Red
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
