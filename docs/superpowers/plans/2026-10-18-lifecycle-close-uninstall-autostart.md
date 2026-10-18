# 关闭 / 卸载 / 开机自启动（生命周期管理）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给"信息整合台"加上关闭（优雅停掉本项目所有进程）、卸载（删数据+删应用本身）与开机自启动（登录后静默预热服务）三项能力，并把开关收口到设置页。

**Architecture:** 后端新增 `system-service` 作为生命周期编排唯一入口，暴露 `/api/system/*`；它通过 spawn PowerShell 脚本完成系统集成（自启 .lnk、卸载清理器）。关闭走 `/api/system/shutdown` 优雅 `app.close()`（补上 Windows 下 SIGTERM 不触发的缺口）。前端设置页新增"系统"区，通过 `useSystem` hook 调接口。

**Tech Stack:** Fastify（Node ≥22.5）、React 19 + Vite、node:test（服务端单测）、vitest + testing-library（前端）、PowerShell 5.1 + VBScript（系统集成）、pnpm workspace。

**Spec:** [docs/superpowers/specs/2026-10-18-lifecycle-close-uninstall-autostart-design.md](../specs/2026-10-18-lifecycle-close-uninstall-autostart-design.md)

## Global Constraints

- 服务只绑 `127.0.0.1`，端口默认 5178；不改现有数据流。
- 免管理员、便携：自启走启动文件夹 `.lnk`，不写注册表；不引入编译产物或原生模块。
- 关闭/卸载**绝不动**其他 node / 浏览器进程；停止脚本不强杀浏览器窗口。
- 卸载删除**整个项目目录（含 `.git`、`.runtime`、`node_modules`、`dist`、`data/`）**。
- `.ps1` 含中文必须带 UTF-8 BOM；`.vbs` / `.bat` 全 ASCII（见 verify-launcher.ps1 编码守卫）。
- 前端接口文案（逐字使用）：
  - 自启标题 `开机自启`，说明 `登录后静默启动本机服务（不弹窗口），让第一次打开更快。`
  - 自启提示 `登录时在后台预热服务；随时可在设置里关掉，或到系统「启动」文件夹手动删除。`
  - 退出按钮 `退出应用`；卸载按钮 `卸载应用`。
  - 卸载警告 `卸载将删除本应用全部数据，包括所有信息卡和 API 设置，且无法恢复。`
  - 卸载补充提示 `浏览器自行安装的应用图标需到 edge://apps 或 chrome://apps 里手动移除。`
- 每步改动独立 commit（Conventional Commits，中文描述）。

## Review Focus

1. **启动文件夹不存在时开自启**：`set-autostart.ps1` 必须先建目录再建 `.lnk`。→ Task 1 功能测试断言在临时目录里 `.lnk` 真实生成。
2. **`enabled` 传非布尔值**：`POST /api/system/autostart` 必须回 400 而非 500。→ Task 4 接口测试。
3. **外部删掉自启 .lnk 后状态不撒谎**：`GET /api/system` 按文件系统事实返回，不用内存缓存。→ Task 3 单测（建/删文件断言 autostart 翻转）。
4. **服务未运行时停止脚本仍正常退出**：优雅关失败后回退到"未运行/已停止"，退出码 0。→ Task 5（verify-launcher 已含"重复停止不报错"，本次补"优雅关路径"断言）。
5. **卸载清理器幂等 + 不在 node 占用时删目录**：目标已删/进程未退时不能报错、不能提前删。→ Task 2（静态断言脚本含端口等待循环 + 功能测试对已删目标重跑退出 0）。

---

### Task 1: 自启脚本 set-autostart.ps1 + autostart.vbs

**Files:**
- Create: `scripts/set-autostart.ps1`
- Create: `scripts/autostart.vbs`
- Modify: `scripts/verify-launcher.ps1`（新增 3a 之后的自启校验段）

**Interfaces:**
- Produces: `set-autostart.ps1` 参数 `-Enable` / `-Disable` / `-RepoRoot <dir>` / `-StartupDir <dir>`（`-StartupDir` 供验证注入临时目录）；`autostart.vbs` 由 wscript 执行、调用 `launch-app.ps1 -NoLaunch`。

- [ ] **Step 1: 写 `set-autostart.ps1`**

参数与行为：`param([switch]$Enable, [switch]$Disable, [string]$RepoRoot='', [string]$StartupDir='')`。
- `$RepoRoot` 为空时 = `Split-Path -Parent $PSScriptRoot`（不得写在参数默认值里，见 launch-app.ps1 教训）。
- `$StartupDir` 为空时 = `Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'`。
- `.lnk` 目标 `wscript.exe`，参数指向 `scripts\autostart.vbs`，工作目录 `$RepoRoot`，图标复用 `apps\web\public\icon.ico`（不存在退 `shell32.dll,13`）。
- `-Enable`：目录不存在先 `New-Item`；`-Disable`：`.lnk` 存在才 `Remove-Item -Force`；两者互斥时 `-Enable` 优先。退出码 0 成功 / 1 失败。

- [ ] **Step 2: 写 `autostart.vbs`（全 ASCII）**

仿照 `scripts/launch-app.vbs`：`CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""...launch-app.ps1"" -NoLaunch", 0, False`。

- [ ] **Step 3: 扩展 `verify-launcher.ps1` 的自启校验**

在"3a 便携启动"段后新增：存在性 + 语法解析 + 含中文带 BOM 检查（现有编码守卫自动覆盖），并加功能测试（放在 `-Functional` 分支）：
- `Invoke-Capture set-autostart.ps1 @('-Enable','-StartupDir', $tempStartup)`（`$tempStartup` 为临时目录）→ 退出 0，`$tempStartup\信息整合台.lnk` 存在，读回断言 `TargetPath` 匹配 `wscript.exe`、`Arguments` 指向存在的 `autostart.vbs`。
- `Invoke-Capture set-autostart.ps1 @('-Disable','-StartupDir', $tempStartup)` → 退出 0，`.lnk` 被删。

- [ ] **Step 4: 运行校验**

Run: `pnpm verify:launcher`（先语法）；再 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-launcher.ps1 -Functional`
Expected: 自启新增断言 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/set-autostart.ps1 scripts/autostart.vbs scripts/verify-launcher.ps1
git commit -m "feat(scripts): 新增开机自启动开关脚本与静默包装器"
```

---

### Task 2: 卸载清理器 uninstall-cleaner.ps1

**Files:**
- Create: `scripts/uninstall-cleaner.ps1`
- Modify: `scripts/verify-launcher.ps1`（新增卸载清理器校验段）

**Interfaces:**
- Produces: `uninstall-cleaner.ps1 -RepoRoot <dir> -Port <int>`，幂等、退出码 0 成功 / 1 失败；由 system-service 复制到 `%TEMP%` 后 detach 运行。

- [ ] **Step 1: 写 `uninstall-cleaner.ps1`（含中文，需 UTF-8 BOM）**

`param([string]$RepoRoot='', [int]$Port=5178)`。顺序（每步幂等）：
1. 兜底 `Stop-Process` 残留的 `dist/index.js` node 进程（`Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' }`）。
2. 轮询等待端口 `$Port` 释放或目标进程消失（上限 30 秒，`Get-NetTCPConnection`）。
3. `& "$RepoRoot\scripts\install-desktop-app.ps1" -Uninstall`（清桌面/开始菜单 .lnk；脚本不存在则跳过）。
4. `& "$RepoRoot\scripts\set-autostart.ps1" -Disable -RepoRoot $RepoRoot`（清自启 .lnk；同上跳过）。
5. `Remove-Item $RepoRoot -Recurse -Force`（目标已不存在则跳过）。
6. 清 `%LOCALAPPDATA%\NotificationHub` 与 `%TEMP%\notification-hub-server*.log`（存在才删）。
7. `Remove-Item $PSCommandPath -Force`（删自身副本）。

- [ ] **Step 2: 扩展 `verify-launcher.ps1` 的卸载清理器校验**

- 静态断言：`uninstall-cleaner.ps1` 含端口等待循环（`-match 'Get-NetTCPConnection|Start-Sleep'`）与 `install-desktop-app.ps1`、`set-autostart.ps1` 引用。
- 功能测试（`-Functional` 分支，**只对临时假仓库运行，绝不以真实 `$repoRoot` 为 `-RepoRoot`**）：建临时目录结构（含空的 `scripts\`、`data\`、`node_modules\`、`.git\`），`Invoke-Capture uninstall-cleaner.ps1 @('-RepoRoot',$tempRepo)` → 退出 0 且 `Test-Path $tempRepo` 为 False；再对同一（已不存在）目录重跑 → 退出 0。

- [ ] **Step 3: 运行校验**

Run: `pnpm verify:launcher`；再 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-launcher.ps1 -Functional`
Expected: 卸载清理器断言 PASS。

- [ ] **Step 4: Commit**

```bash
git add scripts/uninstall-cleaner.ps1 scripts/verify-launcher.ps1
git commit -m "feat(scripts): 新增幂等卸载清理器，删数据与应用本身"
```

---

### Task 3: 共享类型 + system-service

**Files:**
- Modify: `packages/shared/src/index.ts`（新增类型）
- Create: `apps/server/src/services/system-service.ts`
- Test: `apps/server/test/system-service.test.ts`

**Interfaces:**
- Consumes: `set-autostart.ps1`、`uninstall-cleaner.ps1`（按路径 spawn，不读内容）。
- Produces:
  - `SystemError`（`code: string`）。
  - `interface SystemService { getStatus(): SystemView; setAutostart(enabled: boolean): Promise<SystemView>; scheduleUninstall(): Promise<string> }`
  - `createSystemService(options: SystemServiceOptions): SystemService`，`SystemServiceOptions = { repoRoot: string; port: number; dataDir: string; spawnImpl?: typeof spawn; appDataDir?: string; tmpDir?: string }`。

- [ ] **Step 1: 写失败测试 `system-service.test.ts`**

用 `node:test`。断言（写实现前先跑，FAIL 于 `createSystemService` 未导出）：
1. `getStatus` 在 `appDataDir` 下无 `.lnk` 时返回 `{ autostart: false, port: 5178, dataDir: '...' }`；手动创建 `...\Startup\信息整合台.lnk` 后返回 `autostart: true`，删除后回到 `false`（覆盖 Review Focus 3）。
2. `setAutostart(true)` 用假 `spawnImpl` 记录 `powershell.exe` 参数含 `set-autostart.ps1` 与 `-Enable`、`-RepoRoot`，close 码 0 时 resolve 且返回 `getStatus()`。
3. `setAutostart(false)` 参数含 `-Disable`。
4. `spawnImpl` close 码非 0 时 `setAutostart` reject `SystemError` 且 `code === 'AUTOSTART_FAILED'`。
5. `scheduleUninstall()` 把 `uninstall-cleaner.ps1` 复制到注入的 `tmpDir` 并 spawn（参数含 `-RepoRoot`、`detached: true`），resolve 临时脚本路径。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @notification-hub/server test`
Expected: 新增 describe FAIL（找不到 `createSystemService`）。

- [ ] **Step 3: 新增共享类型 + 实现 `system-service.ts`**

`packages/shared/src/index.ts` 追加：
```ts
export interface SystemView { autostart: boolean; port: number; dataDir: string; }
```
`system-service.ts` 实现上述接口；`scheduleUninstall` 用 `fs.copyFileSync(scriptsDir 下 uninstall-cleaner.ps1, tmpDir 下副本)` 后 spawn `powershell.exe ... -File <副本> -RepoRoot <repoRoot>`（`detached:true, stdio:'ignore', windowsHide:true`），`child.unref()`。`getStatus` 用 `fs.existsSync` 判 `.lnk`。`spawnImpl`/`appDataDir`/`tmpDir` 缺省用真实值。

- [ ] **Step 4: 运行确认通过 + 重建 shared dist**

Run: `pnpm --filter @notification-hub/shared build && pnpm --filter @notification-hub/server test`
Expected: 全部 PASS（shared 重建让下游能读到新类型）。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/dist apps/server/src/services/system-service.ts apps/server/test/system-service.test.ts
git commit -m "feat(server): 新增生命周期 system-service 与共享系统类型"
```

---

### Task 4: /api/system 路由 + index 接线

**Files:**
- Modify: `apps/server/src/app.ts`（BuildAppOptions + 路由 + SystemError 映射）
- Modify: `apps/server/src/index.ts`（创建 systemService、传 onShutdown/onUninstall）
- Test: `apps/server/test/api.test.ts`（新增 `/api/system` 用例）

**Interfaces:**
- Consumes: `SystemService`、`SystemError`（Task 3）。
- Produces: `BuildAppOptions` 增 `systemService?: SystemService; onShutdown?: () => void; onUninstall?: () => void`。路由仅在 `systemService` 存在时注册。

- [ ] **Step 1: 写失败测试（api.test.ts 新增 describe）**

在 `makeApp` 里支持注入假 `systemService`（实现 `getStatus/setAutostart/scheduleUninstall`，用计数函数）与 `onShutdown/onUninstall`。断言：
1. `GET /api/system` 返回假 status（200）。
2. `POST /api/system/autostart` body `{enabled:true}` → 200 `{autostart:...}` 且 `setAutostart` 收到 `true`。
3. `POST /api/system/autostart` body `{enabled:"yes"}` → 400 `INVALID_BODY`（覆盖 Review Focus 2）。
4. `POST /api/system/shutdown` → 202 `{shuttingDown:true}` 且 `onShutdown` 被调。
5. `POST /api/system/uninstall` → 202 `{uninstalling:true}`、`scheduleUninstall` 被调、`onUninstall` 被调。
6. 假 `setAutostart` reject `SystemError('AUTOSTART_FAILED',...)` → 500 且 `error.code === 'AUTOSTART_FAILED'`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @notification-hub/server test`
Expected: 新增 `/api/system` describe FAIL。

- [ ] **Step 3: 实现路由 + 错误映射 + index 接线**

`app.ts`：`BuildAppOptions` 增三字段；`setErrorHandler` 增 `if (error instanceof SystemError) return reply.code(500).send({ error: { code: error.code, message: error.message } })`。路由：
- `GET /api/system` → `systemService.getStatus()`
- `POST /api/system/autostart`：body 校验 `typeof enabled === 'boolean'`，否则 `throw new ValidationError('INVALID_BODY', ...)`；成功返回 `{ autostart: (await setAutostart(enabled)).autostart }`。
- `POST /api/system/shutdown`：`await reply.code(202).send({ shuttingDown: true }); onShutdown?.()`。
- `POST /api/system/uninstall`：`await systemService.scheduleUninstall(); await reply.code(202).send({ uninstalling: true }); onUninstall?.()`。

`index.ts`：`let app`（改用 `let` 供闭包引用）；`const systemService = createSystemService({ repoRoot: config.repoRoot, port: config.port, dataDir: path.dirname(config.dbPath) })`；`buildApp` 传 `systemService`、`onShutdown`/`onUninstall` 均 = `() => setTimeout(() => { void app.close().then(() => process.exit(0)); }, 50)`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @notification-hub/server typecheck && pnpm --filter @notification-hub/server test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/index.ts apps/server/test/api.test.ts
git commit -m "feat(server): 新增 /api/system 关闭/卸载/自启路由"
```

---

### Task 5: stop-server.ps1 优雅关闭

**Files:**
- Modify: `scripts/stop-server.ps1`
- Modify: `scripts/verify-launcher.ps1`（新增优雅关路径断言）

**Interfaces:**
- Consumes: `/api/system/shutdown`（HTTP）。
- Produces: 停止脚本保持"只停本项目 node 进程"语义，新增"先优雅关、失败硬杀"。

- [ ] **Step 1: 改 `stop-server.ps1`**

在 `$targets` 非空分支前，先尝试 `Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/system/shutdown" -Method Post -TimeoutSec 3`（异常忽略）；随后仍按现有逻辑 `Stop-Process -Force` 兜底并等待端口释放。服务未运行时（无进程且健康检查失败）维持现有"无需停止"退出 0。

- [ ] **Step 2: 扩展 `verify-launcher.ps1` 断言**

静态断言：`stop-server.ps1` 含 `/api/system/shutdown`（`-match 'system/shutdown'`）。功能测试沿用现有 `-Functional` 的"重复停止不报错"（覆盖 Review Focus 4）。

- [ ] **Step 3: 运行校验**

Run: `pnpm verify:launcher`；再 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-launcher.ps1 -Functional`
Expected: 停止脚本断言 PASS。

- [ ] **Step 4: Commit**

```bash
git add scripts/stop-server.ps1 scripts/verify-launcher.ps1
git commit -m "feat(scripts): 停止脚本先走优雅关闭，失败再硬杀兜底"
```

---

### Task 6: 前端 system api + useSystem hook

**Files:**
- Modify: `apps/web/src/lib/api.ts`（新增 `SystemApi`、`toSystemView`、`createSystemApi`）
- Create: `apps/web/src/hooks/useSystem.ts`
- Test: `apps/web/test/api.test.ts`（新增 system 用例）

**Interfaces:**
- Produces:
  - `interface SystemApi { getSystem(): Promise<SystemView>; setAutostart(enabled: boolean): Promise<SystemView>; shutdown(): Promise<void>; uninstall(): Promise<void> }`
  - `createSystemApi(): SystemApi`
  - `toSystemView(input: unknown): SystemView`（`autostart` 非布尔按 `false`，`port` 非数字按 `5178`，`dataDir` 非字符串按 `''`）
  - `useSystem(api: SystemApi)` 返回 `{ system, loading, busy, error, toggleAutostart, shutdown, uninstall }`。

- [ ] **Step 1: 写失败测试（api.test.ts 新增 describe）**

断言：
1. `getSystem` 请求 `/api/system`，`toSystemView` 归一化缺字段（`{ autostart:'yes', port:'x', dataDir:1 }` → `{ autostart:false, port:5178, dataDir:'' }`）。
2. `setAutostart(true)` POST `/api/system/autostart`，body `{"enabled":true}` 且带 `Content-Type: application/json`，返回归一化结果。
3. `shutdown` POST `/api/system/shutdown`（无 body、无 Content-Type），`uninstall` POST `/api/system/uninstall`。
4. 服务端错误信封转 `ApiError`（`setAutostart` 遇 `{error:{code:'AUTOSTART_FAILED',...}}` → code 正确）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @notification-hub/web test`
Expected: 新增 describe FAIL。

- [ ] **Step 3: 实现 `api.ts` 与 `useSystem.ts`**

`api.ts` 追加 `SystemApi`/`toSystemView`/`createSystemApi`（复用 `requestJson`）。`useSystem.ts` 仿照 `useSettings`：挂载时 `getSystem`，`toggleAutostart` 调 `setAutostart(!system.autostart)` 后更新本地状态，`shutdown`/`uninstall` 调后把 `busy` 置 true（成功后界面进入"已退出/正在卸载"态，不再发后续请求）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @notification-hub/web typecheck && pnpm --filter @notification-hub/web test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/hooks/useSystem.ts apps/web/test/api.test.ts
git commit -m "feat(web): 新增 system api 与 useSystem hook"
```

---

### Task 7: SystemSettings 组件 + 设置页集成

**Files:**
- Create: `apps/web/src/components/SystemSettings.tsx`
- Modify: `apps/web/src/components/SettingsView.tsx`（移除 `PlannedSetting`，接入 `SystemSettings`）
- Modify: `apps/web/src/App.tsx`（`systemApi` prop + `useSystem` + 传参）
- Test: `apps/web/test/SystemSettings.test.tsx`（新建）
- Test: `apps/web/test/App.test.tsx`（改"开机自启待实现"用例）

**Interfaces:**
- Consumes: `useSystem`、`SystemApi`（Task 6）。
- Produces: `SystemSettings({ system, loading, busy, onToggleAutostart, onShutdown, onUninstall })`；`AppProps` 增 `systemApi?: ReturnType<typeof createSystemApi>`。

- [ ] **Step 1: 写失败测试 `SystemSettings.test.tsx`**

渲染 `SystemSettings`，注入假 props。断言：
1. 显示标题 `开机自启`、说明（含"静默"）、`port` 与 `dataDir`。
2. 自启开关 `autostart:true` 时 `aria-checked=true`；点击触发 `onToggleAutostart`。
3. 「退出应用」点击触发 `onShutdown`。
4. 「卸载应用」点击 → 第一次确认弹窗出现，文案含"无法恢复"；确认后第二次确认出现（双重确认）；两次都确认才触发 `onUninstall`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @notification-hub/web test`
Expected: 新增 `SystemSettings.test.tsx` FAIL。

- [ ] **Step 3: 实现组件并接线**

`SystemSettings.tsx`：自启开关（`role="switch"` + `aria-checked`）+ 说明与提示（用 Global Constraints 逐字文案）；「退出应用」「卸载应用」按钮，卸载用两段确认（`window.confirm` 或组件内两步确认态，二选一，测试按所选形态断言），第二段文案含"无法恢复"，卸载区显示 PWA 补充提示（逐字文案）。
`SettingsView.tsx`：删 `PlannedSetting` 与"开机自启"占位，改渲染 `<SystemSettings ... />`（从 props 透传）。
`App.tsx`：`AppProps` 增 `systemApi`；`const systemClient = useMemo(() => systemApi ?? createSystemApi(), [systemApi])`；`const system = useSystem(systemClient)`；settings 页把 `system` 各字段传给 `SettingsView`。

- [ ] **Step 4: 更新 `App.test.tsx` 旧用例并跑通**

把 `「外观风格」已经能用了，「开机自启」仍然明确标注没做` 用例改为：settings 页显示真实「开机自启」标题与说明，且 `queryByTestId('planned-badge')` 为 null（占位已移除）；`createFakeSystemApi` 提供 `getSystem→{autostart:false,port:5178,dataDir:'/data'}`。

Run: `pnpm --filter @notification-hub/web typecheck && pnpm --filter @notification-hub/web test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SystemSettings.tsx apps/web/src/components/SettingsView.tsx apps/web/src/App.tsx apps/web/test/SystemSettings.test.tsx apps/web/test/App.test.tsx
git commit -m "feat(web): 设置页新增关闭/卸载/开机自启动系统区"
```

---

### Task 8: 全链路验证与收尾

**Files:**
- 无新增（发现缺陷则回补到对应任务的测试与实现）。

- [ ] **Step 1: 类型检查 + 全部单测**

Run: `pnpm verify`
Expected: 全绿。

- [ ] **Step 2: 构建 + 真实 API 冒烟**

Run: `pnpm build`，随后启动应用并 `pnpm smoke`
Expected: 增/查/删全流程通过（确认新路由不影响既有接口）。

- [ ] **Step 3: 界面真实渲染**

Run: `pnpm verify:ui`，或亲眼看一眼设置页渲染（`#/settings` 出现"系统"区，自启开关与卸载按钮可点、文案正确）。
Expected: 通过 / 无渲染异常。

- [ ] **Step 4: 启动器 + 桌面入口 + 自启/卸载校验**

Run: `pnpm verify:launcher`，再 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-launcher.ps1 -Functional`
Expected: 含新增自启与卸载清理器断言，全部 PASS；临时目录不被真实桌面/开始菜单/启动文件夹污染。

- [ ] **Step 5: 提交收尾（如有修复）**

```bash
git add -A
git commit -m "test: 生命周期功能全链路验证收尾"
```
（无修复则跳过。）
