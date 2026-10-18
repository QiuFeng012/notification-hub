# 设计：关闭 / 卸载 / 开机自启动（生命周期管理）

- 日期：2026-10-18
- 状态：待评审（spec 阶段，尚未进入实现）
- 范围：在现有「React 前端（浏览器 `--app` 窗口）→ Fastify 服务 → PowerShell 脚本」架构上，
  新增应用的关闭、卸载、开机自启动三项能力，并把开关收口到设置页。

## 1. 背景与目标

当前项目已具备：桌面/开始菜单入口（`install-desktop-app.ps1`）、一键启动
（`launch-app.ps1` + `launch-app.vbs`）、停止服务（`stop-server.ps1`）、状态查看
（`status.ps1`）、便携运行时（`runtime.ps1` + `prepare.ps1`）。缺失的是：

1. **关闭**：现在只能"关浏览器窗口"（服务仍在后台）或双击停止脚本硬杀进程；没有一个
   从应用内一键"停掉本项目所有占用"的入口，也没有优雅关闭路径。
2. **卸载**：现在只有 `install-desktop-app.ps1 -Uninstall`，只删两个快捷方式；
   没有"删数据 + 删应用本身"的完整卸载。
3. **开机自启动**：完全没有；首次打开要等 prepare/构建/健康检查，体验偏慢。

目标（用户已确认）：

- 关闭 = 只停本项目占用：后台 node 服务 +（应用内触发时）自己的 `--app` 窗口，
  绝不动其他 node / 浏览器进程。
- 卸载 = 类似正常 App 卸载：**删除数据 + 删除应用本身**（整个项目目录，含 `.git`）。
- 自启 = 登录后静默预热服务（不弹窗口），让首次打开秒开。
- 自启开关与卸载入口放在设置页；卸载删除前给出"数据也将删除"的警告。

## 2. 非目标（本轮不做）

- **托盘图标**：已与用户确认本轮不做真托盘；关闭走"应用内退出 + 优化停止脚本"，
  托盘作为后续独立迭代。
- 不改变现有数据流、端口（默认 5178）、`127.0.0.1` 仅本机绑定、便携免管理员原则。
- 不处理浏览器自行安装的 PWA 图标（它由浏览器管理，卸载器无法可靠移除；
  在卸载说明里提示用户如需一并移除可到 `edge://apps`/`chrome://apps` 手动处理）。

## 3. 架构

新增一个后端 `system-service` 模块作为生命周期编排的**唯一入口**。浏览器页面无法直接
运行 PowerShell / 写快捷方式，所以设置页对系统的所有操作都经 `/api/system/*` 落到该模块，
再由它去调用 PowerShell 脚本完成真正的系统集成。前端仍是薄客户端。

```
设置页(SystemSettings) ──HTTP──> Fastify /api/system/* ──> system-service
                                        │
                                        ├─ spawn set-autostart.ps1   (开/关自启 .lnk)
                                        ├─ app.close() + exit        (关闭)
                                        └─ 复制 uninstall-cleaner.ps1 到 %TEMP% 并 detach 运行 (卸载)
```

## 4. 组件与接口

### 4.1 后端

新增文件：

- `apps/server/src/services/system-service.ts`：纯逻辑。负责判断自启状态（启动文件夹里
  是否存在 `信息整合台.lnk`）、构造并执行 spawn（自启开关、卸载清理器）。把
  `close`/`exit` 与 `spawn` 做成可注入，便于单测不真正退出进程。
- `apps/server/src/system/system-routes.ts`：注册下列路由（或在 `app.ts` 内注册）。

新增接口（均仅本机可达，与现有 `/api/*` 同信任模型）：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/system` | - | `{ autostart: boolean, port: number, dataDir: string }` |
| POST | `/api/system/autostart` | `{ enabled: boolean }` | `{ autostart: boolean }`；失败 500 + 原因 |
| POST | `/api/system/shutdown` | - | `202 { shuttingDown: true }`，随后关闭 |
| POST | `/api/system/uninstall` | - | `202 { uninstalling: true }`；清理器派发失败 500 |

- `GET /api/system` 的 `autostart` 来自文件系统事实（启动文件夹 `.lnk` 是否存在），
  而非内存状态，保证"别处手动删了启动项"时界面不会误报。
- `shutdown`：返回 202 后延迟几十毫秒执行 `app.close()`（`index.ts` 已有
  `onClose` → `repo.close()`），关闭完成后 `process.exit(0)`。
- `uninstall`：见 6 节，服务只负责把清理脚本复制到 `%TEMP%` 并 detach 启动，
  然后 `app.close()` 退出。

### 4.2 PowerShell / VBS（新增）

- `scripts/set-autostart.ps1`：`-Enable` / `-Disable`，在启动文件夹
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 创建 / 移除
  `信息整合台.lnk`。快捷方式指向 `wscript.exe` + `autostart.vbs`（与桌面入口同构，
  因为隐藏窗口直接启动 powershell 会卡在控制台句柄继承上）。
- `scripts/autostart.vbs`：wscript 无窗口包装器，调用
  `launch-app.ps1 -NoLaunch`（该参数已实现"确保服务在跑、不开窗口"）。
- `scripts/uninstall-cleaner.ps1`：自包含清理器，参数 `-RepoRoot`，见 6 节。

### 4.3 前端

- `apps/web/src/components/SystemSettings.tsx`：设置页新增"系统"区。
  - 开机自启动开关（含说明：静默预热、不弹窗、首次打开更快）。
  - 「退出应用」按钮。
  - 「卸载」按钮（双重确认 + 数据删除警告）。
- `apps/web/src/hooks/useSystem.ts`：封装 `/api/system` 调用。
- `apps/web/src/lib/api.ts`：补充 system 接口类型与调用函数。

## 5. 关闭设计

两个入口、同一语义（只停本项目占用）：

1. **应用内「退出应用」**：`POST /api/system/shutdown` → 服务优雅关闭（释放端口、
   关数据库）→ 前端收到响应后 `window.close()` 关掉自己的 `--app` 窗口。
2. **双击「停止信息整合台.bat」**：升级 `stop-server.ps1` 为"先
   `Invoke-RestMethod` 调 `/api/system/shutdown` 优雅关，失败/超时再按现有方式
   `Stop-Process -Force` 硬杀兜底"。

边界说明（写入设计并保留到实现）：

- 只有应用内路径能干净关闭自己的 `--app` 窗口（页面自关）。
- 外部停止脚本**不强杀浏览器进程**：`--app` 窗口可能与用户正在用的 Edge/Chrome 共用
  进程树，强杀会误伤正常浏览器。停脚本只停服务，窗口变成离线页由用户手动关。
- 优雅关闭之所以必须走显式接口：Windows 上 `Stop-Process -Force` 不会触发 Node 的
  SIGTERM 处理器，`index.ts` 里现有的信号处理实际上不会被走到。

## 6. 卸载设计

删除范围（用户已确认"类似 App 卸载，删数据 + 删应用"）：

> 停服务 → 移除启动/桌面/开始菜单 `.lnk` → 删 `data/`（`cards.db`、`settings.json`
> 含明文 Key）→ 删 `.runtime/`（含下载的 node.exe）→ 删 `node_modules/`、`dist/` →
> 删整个仓库目录（含 `.git`）→ 清 `%LOCALAPPDATA%\NotificationHub\launch.log` 与
> `%TEMP%\notification-hub-server*.log` → 清理脚本自删。

机制难点与解法：

- 运行中的 node.exe 位于 `.runtime\node\`，属于要被删的目录，Windows 不允许删除
  正在运行的 exe。因此清理器必须**在服务进程彻底退出后**才删除目录。
- 服务收到 `uninstall` 后：把 `uninstall-cleaner.ps1` **复制到 `%TEMP%`**（目录外，
  不会被自己删掉）→ 返回 202 → `app.close()` 退出 → 清理器 detach 独立运行。

`uninstall-cleaner.ps1` 执行顺序（每步幂等、失败可重跑）：

1. 兜底结束残留的 `dist/index.js` node 进程（正常此时已退出）。
2. 轮询等待端口 5178 释放 / 目标 node 进程消失（上限若干秒）。
3. 调 `install-desktop-app.ps1 -Uninstall` 移除桌面/开始菜单 `.lnk`（复用路径解析）。
4. 调 `set-autostart.ps1 -Disable` 移除自启 `.lnk`。
5. 删除 `-RepoRoot` 整个目录。
6. 清理 `%LOCALAPPDATA%\NotificationHub` 与 `%TEMP%` 下的本项目日志。
7. 删除自身副本。

设置页卸载流程：点「卸载」→ 第一层确认 → 第二层明确警告"卸载将删除本应用全部数据，
包括所有信息卡与 API 设置，且无法恢复"→ 确认后调 `/api/system/uninstall` →
页面显示"正在卸载…"。

## 7. 错误处理

- 自启开关：spawn 失败或脚本非零退出 → 返回 500 与原因；状态以 `.lnk` 文件事实为准。
- shutdown：始终返回 202；若 `app.close()` 抛错则记日志并强制 `process.exit(1)`。
- uninstall：清理器派发失败返回 500（用户可知"没开始卸"）；清理器自身日志写到
  `%TEMP%`，即使服务端已退出也能事后查看；清理器幂等，中断后可重跑。

## 8. 测试与验证（AGENTS.md）

- 单元测试：
  - `system-service`：自启状态判断（mock 文件存在性）、spawn 参数、卸载清理器路径。
  - 接口测试：`GET /api/system`、`POST /api/system/autostart`（mock spawn）、
    `shutdown`/`uninstall` 行为（通过依赖注入，测试不真正退出进程）。
- `verify-launcher.ps1` 扩展（沿用 `-InstallRoot` 临时目录手法，绝不碰真实系统）：
  - `set-autostart.ps1` 在临时启动目录真实创建 / 读回 / 移除 `.lnk`，断言目标指向
    `wscript.exe` + `autostart.vbs`。
  - `uninstall-cleaner.ps1` 对临时假仓库目录真实执行，断言目录被删、日志被清、
    且从未以真实 `RepoRoot` 运行。
- 交付前完整链路：`pnpm verify`（类型检查 + 全部测试）→ 启动后 `pnpm smoke` →
  `pnpm verify:ui` → `pnpm verify:launcher`。

## 9. 风险与边界

- 卸载不可逆：删除整目录（含数据与 `.git`），由双重确认 + 明确警告兜底。
- 卸载器不负责浏览器安装的 PWA 图标（浏览器管理）；卸载说明里提示可手动移除。
- `/api/system/*` 仅本机回环可达，无鉴权，与现有 `/api/*` 一致；不做额外认证。
- 自启在"用户登录后"触发（per-user，免管理员），不是系统开机前；符合该应用
  单用户、数据在用户目录、仅绑 `127.0.0.1` 的定位。
