# 信息整合台 (notification-hub)

一个**仅供个人本地使用**的信息整合工具：把收到的通知原文粘贴进来，AI 提炼要点，生成一张结构化**信息卡**，并保存在本机数据库里随时回看。

## 它做什么

```
粘贴通知原文 → AI 提炼要点 → 生成信息卡 → 存入本地 SQLite
```

信息卡字段固定为：**标题 / 时间 / 来源 / 要点列表**，另存原始通知全文以便核对。

## 它明确不做什么

用户系统、手机端、闹钟提醒、分类标签、自动抓取系统通知、批量粘贴。
这一版只做「手动粘贴 → 总结 → 信息卡」这一条主链路。

## 快速开始

```bash
pnpm install
pnpm build          # 构建前端（服务端与前端同端口托管）
pnpm start          # 打开 http://127.0.0.1:5178
```

首次使用建议：

```bash
cp .env.example .env    # 可选：填入 DEEPSEEK_API_KEY
```

**没有 API Key 也能直接跑通全流程**：此时会使用内置的本地启发式摘要器（关键词 + 日期规则挑句子），产出的卡片会明确标注为「启发式摘要」而不是「AI 摘要」。配置 Key 后自动切换为 DeepSeek 真实总结，标注变为「AI 摘要」。

## 配置 API Key

Key 有两种给法，**优先级：界面配置 > 环境变量**。

**方式一：在界面上填（推荐）**

打开 <http://127.0.0.1:5178>，点左上角的 **「API 设置」**，粘贴 Key，点「保存并验证」。
保存前会真实调用一次模型接口验证，Key 不对会直接拒绝保存，不用等到下次用才发现。

- 保存在 `data/settings.json`，只存在本机，不会被上传
- 该文件已被 `.gitignore` 覆盖；写入时会尽量收紧文件权限到仅当前用户可读写
- 界面与接口**只回显掩码**（如 `sk-1234…cdef`），完整 Key 不会回到浏览器
- 只有点「清除」才会删除已保存的 Key；留空保存表示保持原样
- 高级选项里可以改**接口地址**与**模型名**，用来接自建代理或换模型

**方式二：环境变量 / `.env`**

```bash
cp .env.example .env    # 填入 DEEPSEEK_API_KEY
```

适合不想在界面里出现 Key 的场景。两种都配了时以界面为准。

## 开发模式

```bash
pnpm dev:server     # 终端 1：后端 http://127.0.0.1:5178（tsx watch 热重载）
pnpm dev            # 终端 2：前端 http://127.0.0.1:5173（Vite HMR，/api 已代理到后端）
```

## 验证

```bash
pnpm verify           # 类型检查 + 全部单元/组件测试
pnpm smoke            # 真实链路冒烟：真客户端打真服务端（需先启动服务）
pnpm verify:ui        # 真实界面验证：无头浏览器点击删除按钮（需先启动服务）
pnpm verify:launcher  # 启动器脚本验证：语法 + 真实启停循环
```

`pnpm smoke` 与 `pnpm verify:ui` 存在的意义：单元测试里的 `fetch` 是 mock，不校验请求头与
协议细节。曾经因此漏掉一个让删除功能完全崩溃的缺陷——前端给没有 body 的 `DELETE` 请求加了
`Content-Type: application/json`，Fastify 的 JSON 解析器直接以 `FST_ERR_CTP_EMPTY_JSON_BODY`
拒绝。这两个脚本跑的是真实浏览器 / 真实客户端 / 真实服务端，专门拦这一类问题。

`pnpm verify:launcher` 用于验证双击启动链路。PowerShell 脚本有两类只有真跑才会暴露的问题：
语法解析器查不出参数默认值错误（`$PSScriptRoot` 在参数默认值求值时还是空串），
以及 `.env` 不存在时索引 null 导致脚本以失败退出——双击时用户只会看到窗口一闪而过。

## 目录结构

```
apps/server/          后端：Fastify + node:sqlite
  src/ai/             摘要器：DeepSeek 客户端 / mock 回退 / 输出解析
  src/db/             信息卡仓储（SQLite 实现 + 测试用内存实现）
  src/services/       业务规则：参数校验、卡片装配、设置保存与验证
  src/settings/       设置持久化（data/settings.json）
  src/app.ts          HTTP 路由与统一错误出口
  test/               接口、仓储、摘要器、设置、配置的测试
apps/web/             前端：React + Vite
  src/components/     输入栏、信息卡、信息卡列表、API 设置面板
  src/hooks/          useCards：加载 / 提交 / 删除；useSettings：读取 / 保存 / 清除
  src/lib/            API 客户端、卡片视图归一化
  test/               组件与工具函数的测试
packages/shared/      前后端共享的信息卡与设置类型定义
scripts/              启动器与验证脚本
  启动信息整合台.bat / 停止信息整合台.bat / 查看状态.bat   （在仓库根目录）
  start-server.ps1    启动服务并打开浏览器
  stop-server.ps1     停止本项目服务
  status.ps1          查询服务状态
  smoke.mts           真实链路冒烟
  ui-delete-check.mts 无头浏览器点击验证
  screenshot.mts      无头浏览器截图（改动界面后肉眼核对用）
  verify-launcher.ps1 启动器脚本验证
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/cards` | 信息卡列表（按创建时间倒序） |
| `POST` | `/api/cards` | 提交 `{ rawText }`，生成并保存信息卡 |
| `DELETE` | `/api/cards/:id` | 删除一张信息卡 |
| `GET` | `/api/settings` | 当前 API 设置（**只返回 Key 掩码**） |
| `PUT` | `/api/settings` | 保存 `{ apiKey?, baseUrl?, model? }`，保存前会真实验证 Key |
| `DELETE` | `/api/settings` | 清除已保存的设置，回落到环境变量或本地启发式摘要 |

错误统一返回 `{ "error": { "code": "...", "message": "..." } }`，常见错误码：
`EMPTY_TEXT`、`INVALID_BODY`、`TEXT_TOO_LONG`(413)、`INVALID_ID`、`CARD_NOT_FOUND`、`SUMMARY_FAILED`、
`INVALID_API_KEY`、`VALUE_TOO_LONG`。

## 配置项

全部通过环境变量（或仓库根目录的 `.env`）配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | 留空则使用本地启发式摘要器 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 也可指向任何 OpenAI 兼容代理 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `PORT` | `5178` | 监听端口 |
| `DB_PATH` | `./data/cards.db` | SQLite 文件路径，相对仓库根 |
| `SETTINGS_PATH` | 与数据库同目录的 `settings.json` | 界面保存的设置文件路径 |

## 安全与隐私说明

- **只监听 `127.0.0.1`**：本应用没有登录系统，绑定局域网地址等于把个人通知数据暴露给同网段所有人。此行为在代码中写死，不通过环境变量开放。
- **API Key** 有两种来源：界面保存（`data/settings.json`）优先于环境变量（`.env`）。
  - 两者都在 `.gitignore` 覆盖范围内，不会进入版本库。
  - 界面与 `/api/settings` 接口**只返回掩码**，完整 Key 不出服务端。
  - `settings.json` 明文存储（本机个人应用），写入时尽力收紧到仅当前用户可读写；
    它保护的是"别人拿到你的仓库"，不是"别人拿到你的磁盘"。
- **通知原文与数据库文件都不入库**：`data/` 目录整体被忽略。
- **模型返回的内容一律当作不可信输入**处理：解析层做类型收敛、长度裁剪与要点数量上限，解析失败时退化成可读的占位要点，不会让界面崩掉。

## 约定

见 `AGENTS.md`：每次改动必须对应一次 git commit，且必须附带通过全部测试与类型检查。
