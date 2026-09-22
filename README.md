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
cp .env.example .env    # 填入 DEEPSEEK_API_KEY
```

**没有 API Key 也能直接跑通全流程**：此时会使用内置的本地启发式摘要器（关键词 + 日期规则挑句子），产出的卡片会明确标注为「启发式摘要」而不是「AI 摘要」。配置 Key 后自动切换为 DeepSeek 真实总结，标注变为「AI 摘要」。

## 开发模式

```bash
pnpm dev:server     # 终端 1：后端 http://127.0.0.1:5178（tsx watch 热重载）
pnpm dev            # 终端 2：前端 http://127.0.0.1:5173（Vite HMR，/api 已代理到后端）
```

## 验证

```bash
pnpm verify         # 类型检查 + 全部测试
pnpm test           # 仅测试
pnpm typecheck      # 仅类型检查
```

## 目录结构

```
apps/server/          后端：Fastify + node:sqlite
  src/ai/             摘要器：DeepSeek 客户端 / mock 回退 / 输出解析
  src/db/             信息卡仓储（SQLite 实现 + 测试用内存实现）
  src/services/       业务规则：参数校验、卡片装配
  src/app.ts          HTTP 路由与统一错误出口
  test/               接口、仓储、摘要器、配置的测试
apps/web/             前端：React + Vite
  src/components/     输入栏、信息卡、信息卡列表
  src/hooks/          useCards：加载 / 提交 / 删除
  src/lib/            API 客户端、卡片视图归一化
  test/               组件与工具函数的测试
packages/shared/      前后端共享的信息卡类型定义
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/cards` | 信息卡列表（按创建时间倒序） |
| `POST` | `/api/cards` | 提交 `{ rawText }`，生成并保存信息卡 |
| `DELETE` | `/api/cards/:id` | 删除一张信息卡 |

错误统一返回 `{ "error": { "code": "...", "message": "..." } }`，常见错误码：
`EMPTY_TEXT`、`INVALID_BODY`、`TEXT_TOO_LONG`(413)、`INVALID_ID`、`CARD_NOT_FOUND`、`SUMMARY_FAILED`。

## 配置项

全部通过环境变量（或仓库根目录的 `.env`）配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | 留空则使用本地启发式摘要器 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 也可指向任何 OpenAI 兼容代理 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `PORT` | `5178` | 监听端口 |
| `DB_PATH` | `./data/cards.db` | SQLite 文件路径，相对仓库根 |

## 安全与隐私说明

- **只监听 `127.0.0.1`**：本应用没有登录系统，绑定局域网地址等于把个人通知数据暴露给同网段所有人。此行为在代码中写死，不通过环境变量开放。
- **API Key 只从环境变量读取**，`.env` 已在 `.gitignore` 中，不会进入版本库。
- **通知原文与数据库文件都不入库**：`data/` 目录整体被忽略。
- 模型返回的内容一律当作**不可信输入**处理：解析层做类型收敛、长度裁剪与要点数量上限，解析失败时退化成可读的占位要点，不会让界面崩掉。

## 约定

见 `AGENTS.md`：每次改动必须对应一次 git commit，且必须附带通过全部测试与类型检查。
