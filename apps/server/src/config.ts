import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** DeepSeek 官方 base URL */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_PORT = 5178;

/**
 * 从当前文件位置向上寻找仓库根目录（以 pnpm-workspace.yaml 为标志）。
 * 这样源码运行（src/）与编译后运行（dist/）都能定位到同一个仓库根。
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function readPort(raw: string | undefined): number {
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return DEFAULT_PORT;
}

export interface AppConfig {
  /** 仓库根目录绝对路径 */
  repoRoot: string;
  /** 监听端口 */
  port: number;
  /** 监听地址：只绑回环地址，禁止局域网访问 */
  host: string;
  /** SQLite 数据库文件绝对路径 */
  dbPath: string;
  /** DeepSeek API Key，为空时回退到 mock 摘要器 */
  deepseekApiKey: string | null;
  deepseekBaseUrl: string;
  deepseekModel: string;
  /** 单次模型调用的超时时间（毫秒） */
  aiTimeoutMs: number;
  /** 已构建前端静态资源目录，存在时由服务端托管 */
  webDistPath: string;
}

/**
 * 只监听 127.0.0.1：本应用没有登录系统，绑定 0.0.0.0 等于把个人数据暴露给同网段所有人。
 */
const LOOPBACK_HOST = '127.0.0.1';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, moduleDir = import.meta.dirname): AppConfig {
  const repoRoot = findRepoRoot(moduleDir);
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const dbPathRaw = env.DB_PATH?.trim();

  return {
    repoRoot,
    port: readPort(env.PORT),
    host: LOOPBACK_HOST,
    dbPath: dbPathRaw
      ? path.resolve(repoRoot, dbPathRaw)
      : path.join(repoRoot, 'data', 'cards.db'),
    deepseekApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    deepseekModel: env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL,
    aiTimeoutMs: 45_000,
    webDistPath: path.join(repoRoot, 'apps', 'web', 'dist'),
  };
}
