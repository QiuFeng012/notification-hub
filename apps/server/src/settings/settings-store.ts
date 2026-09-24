import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_API_KEY_LENGTH, MAX_BASE_URL_LENGTH, MAX_MODEL_LENGTH, type SettingsSource, type SettingsView } from '@notification-hub/shared';

/** 落盘结构。apiKey 是明文——这是本机个人应用，必须依赖文件权限而非加密。 */
interface PersistedSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ResolvedSettings {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  source: SettingsSource;
}

export interface SettingsStoreOptions {
  /** settings.json 的绝对路径 */
  filePath: string;
  /** 环境变量 / .env 提供的 Key，作为用户配置的兜底 */
  envApiKey: string | null;
  /** 默认 base URL（来自 config） */
  defaultBaseUrl: string;
  /** 默认模型名（来自 config） */
  defaultModel: string;
}

export interface SettingsStore {
  /** 解析当前生效的设置：用户配置 > 环境变量 > 无 */
  resolve(): ResolvedSettings;
  /** 供界面展示的视图，Key 只给掩码 */
  view(): SettingsView;
  /** 合并保存；apiKey 传空字符串表示清除 */
  save(patch: { apiKey?: string; baseUrl?: string; model?: string }): SettingsView;
  /** 清除用户保存的配置（回落到环境变量或 mock） */
  clear(): SettingsView;
  /** 用户是否保存过配置 */
  hasUserConfig(): boolean;
}

/** 把 Key 变成 "sk-1234…cdef" 形式，足够辨认是不是自己那把，又不泄露全文 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}${'*'.repeat(Math.max(1, trimmed.length - 2))}`;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/** 尽量收紧文件权限：只允许当前用户读写。失败不影响功能，只是权限没那么严。 */
function restrictFilePermissions(filePath: string): void {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME;
    if (!username) return;
    // Windows 下 chmod 基本无效，用 icacls 去掉继承并只授权当前用户
    execFile(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${username}:F`],
      { windowsHide: true },
      () => {
        // 失败也无所谓：这是尽力而为的加固，不是功能依赖
      },
    );
    return;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // 同上
  }
}

function readPersisted(filePath: string): PersistedSettings {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const result: PersistedSettings = {};
    if (typeof record.apiKey === 'string' && record.apiKey.trim().length > 0) {
      result.apiKey = record.apiKey.trim();
    }
    if (typeof record.baseUrl === 'string' && record.baseUrl.trim().length > 0) {
      result.baseUrl = record.baseUrl.trim();
    }
    if (typeof record.model === 'string' && record.model.trim().length > 0) {
      result.model = record.model.trim();
    }
    return result;
  } catch {
    // 文件损坏时按"没有用户配置"处理，不要因为一个坏文件让整个应用起不来
    return {};
  }
}

function writePersisted(filePath: string, data: PersistedSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 先写临时文件再改名，避免写到一半断电留下半个 JSON
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  restrictFilePermissions(filePath);
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const { filePath, envApiKey, defaultBaseUrl, defaultModel } = options;

  /** 校验长度，超限直接截断并抛错，避免把整段粘贴文本当 Key 存进去 */
  function assertLength(value: string, max: number, label: string): string {
    const trimmed = value.trim();
    if (trimmed.length > max) {
      throw new Error(`${label} 过长（${trimmed.length} 字符），上限 ${max} 字符`);
    }
    return trimmed;
  }

  function resolve(): ResolvedSettings {
    const persisted = readPersisted(filePath);
    if (persisted.apiKey) {
      return {
        apiKey: persisted.apiKey,
        baseUrl: persisted.baseUrl ?? null,
        model: persisted.model ?? null,
        source: 'user',
      };
    }
    if (envApiKey) {
      return { apiKey: envApiKey, baseUrl: null, model: null, source: 'env' };
    }
    // 没有 Key 时，用户在界面上填的 baseUrl / model 也一并忽略——
    // 它们只对真实模型调用有意义
    return { apiKey: null, baseUrl: null, model: null, source: 'mock' };
  }

  function view(): SettingsView {
    const resolved = resolve();
    // 地址与模型名要反映"用户存在文件里的值"，而不是只反映当前生效值：
    // 用户可能先填了自建代理地址、还没填 Key，这时界面上必须显示他刚存的地址，
    // 否则一保存就"变回"默认值，看起来像没保存成功。
    const persisted = readPersisted(filePath);
    return {
      configured: resolved.apiKey !== null,
      apiKeyMask: resolved.apiKey ? maskApiKey(resolved.apiKey) : null,
      source: resolved.source,
      baseUrl: persisted.baseUrl ?? defaultBaseUrl,
      model: persisted.model ?? defaultModel,
    };
  }

  return {
    resolve,
    view,

    hasUserConfig() {
      return Object.keys(readPersisted(filePath)).length > 0;
    },

    save(patch) {
      const current = readPersisted(filePath);
      const next: PersistedSettings = { ...current };

      if (patch.apiKey !== undefined) {
        const key = assertLength(patch.apiKey, MAX_API_KEY_LENGTH, 'API Key');
        // 空字符串代表"清除"，不是"保存一个空 Key"
        if (key.length === 0) delete next.apiKey;
        else next.apiKey = key;
      }
      if (patch.baseUrl !== undefined) {
        const baseUrl = assertLength(patch.baseUrl, MAX_BASE_URL_LENGTH, 'base URL');
        if (baseUrl.length === 0) delete next.baseUrl;
        else next.baseUrl = baseUrl;
      }
      if (patch.model !== undefined) {
        const model = assertLength(patch.model, MAX_MODEL_LENGTH, '模型名');
        if (model.length === 0) delete next.model;
        else next.model = model;
      }

      writePersisted(filePath, next);
      return view();
    },

    clear() {
      writePersisted(filePath, {});
      return view();
    },
  };
}
