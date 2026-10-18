import { spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SystemView } from '@notification-hub/shared';

/** 生命周期操作失败，由 HTTP 层映射成 500 */
export class SystemError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SystemError';
    this.code = code;
  }
}

export interface SystemServiceOptions {
  repoRoot: string;
  port: number;
  dataDir: string;
  /** 可注入，便于测试时不真正执行 PowerShell */
  spawnImpl?: typeof spawn;
  /** 启动文件夹根（默认 %APPDATA%）；测试注入临时目录 */
  appDataDir?: string;
  /** 清理器副本落地目录（默认系统 temp）；测试注入临时目录 */
  tmpDir?: string;
}

export interface SystemService {
  /** 读取本机状态：自启是否开启、端口、数据目录 */
  getStatus(): SystemView;
  /** 开/关开机自启；返回切换后的状态 */
  setAutostart(enabled: boolean): Promise<SystemView>;
  /**
   * 把清理器复制到临时目录并 detach 启动，返回副本路径。
   * 真正的删除由清理器在服务退出后完成。
   */
  scheduleUninstall(): Promise<string>;
}

/** 启动文件夹在 %APPDATA% 下的相对位置 */
const STARTUP_RELATIVE = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const APP_NAME = '信息整合台';

function startupShortcutPath(appDataDir: string): string {
  return path.join(appDataDir, STARTUP_RELATIVE, `${APP_NAME}.lnk`);
}

export function createSystemService(options: SystemServiceOptions): SystemService {
  const { repoRoot, port, dataDir } = options;
  const scriptsDir = path.join(repoRoot, 'scripts');
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? '';
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const spawnImpl = options.spawnImpl ?? spawn;

  function getStatus(): SystemView {
    return {
      autostart: existsSync(startupShortcutPath(appDataDir)),
      port,
      dataDir,
    };
  }

  /** 跑一个 PowerShell 脚本并等它结束；非零退出抛错 */
  function runScript(scriptPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { windowsHide: true, stdio: 'ignore' },
      );
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new SystemError('SCRIPT_FAILED', `脚本退出码 ${code}`));
      });
    });
  }

  return {
    getStatus,

    async setAutostart(enabled: boolean): Promise<SystemView> {
      const scriptPath = path.join(scriptsDir, 'set-autostart.ps1');
      try {
        await runScript(scriptPath, [enabled ? '-Enable' : '-Disable', '-RepoRoot', repoRoot]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SystemError('AUTOSTART_FAILED', `切换开机自启失败：${reason}`);
      }
      return getStatus();
    },

    async scheduleUninstall(): Promise<string> {
      const source = path.join(scriptsDir, 'uninstall-cleaner.ps1');
      const copy = path.join(tmpDir, 'notification-hub-uninstall-cleaner.ps1');
      try {
        copyFileSync(source, copy);
        const child = spawnImpl(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, '-RepoRoot', repoRoot],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.on('error', () => {
          // detach 后不再关心它的结果；副本路径由清理器自己负责
        });
        child.unref();
        return copy;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SystemError('UNINSTALL_FAILED', `启动卸载清理器失败：${reason}`);
      }
    },
  };
}
