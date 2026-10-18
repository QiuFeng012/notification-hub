import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSystemService, SystemError } from '../src/services/system-service.js';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'notification-hub-system-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface SpawnRecord {
  cmd?: string;
  args?: string[];
  opts?: Record<string, unknown>;
  code: number;
}

/**
 * 假的 spawn：记录调用参数，并以给定退出码异步发出 close。
 * 不真正执行 PowerShell，测试因此确定性且不碰真实系统。
 */
function fakeSpawn(record: SpawnRecord): typeof import('node:child_process').spawn {
  return ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    record.cmd = cmd;
    record.args = args;
    record.opts = opts;
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const child = {
      on(event: string, cb: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
        return child;
      },
      unref() {},
    };
    setImmediate(() => {
      for (const cb of listeners['close'] ?? []) cb(record.code);
    });
    return child as unknown as import('node:child_process').ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
}

/** 一个只含两个脚本占位文件的假仓库，避免测试耦合真实仓库 */
function makeRepo(): string {
  const repo = tempDir('notification-hub-repo-');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts', 'set-autostart.ps1'), '# dummy');
  writeFileSync(path.join(repo, 'scripts', 'uninstall-cleaner.ps1'), '# dummy');
  return repo;
}

describe('system-service getStatus', () => {
  it('没有 .lnk 时 autostart 为 false，创建后为 true，删除后回到 false', () => {
    const appDataDir = tempDir('notification-hub-appdata-');
    const repo = makeRepo();
    const service = createSystemService({
      repoRoot: repo,
      port: 5178,
      dataDir: path.join(repo, 'data'),
      appDataDir,
      spawnImpl: fakeSpawn({ code: 0 }),
    });

    assert.deepEqual(service.getStatus(), {
      autostart: false,
      port: 5178,
      dataDir: path.join(repo, 'data'),
    });

    const startupDir = path.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    mkdirSync(startupDir, { recursive: true });
    const lnk = path.join(startupDir, '信息整合台.lnk');
    writeFileSync(lnk, 'x');
    assert.equal(service.getStatus().autostart, true, '存在 .lnk 时应为 true');

    rmSync(lnk);
    assert.equal(service.getStatus().autostart, false, '外部删掉 .lnk 后应回到 false');
  });
});

describe('system-service setAutostart', () => {
  it('-Enable 调 powershell 执行 set-autostart.ps1 且带 -RepoRoot', async () => {
    const repo = makeRepo();
    const record: SpawnRecord = { code: 0 };
    const service = createSystemService({
      repoRoot: repo,
      port: 5178,
      dataDir: path.join(repo, 'data'),
      appDataDir: tempDir(),
      spawnImpl: fakeSpawn(record),
    });

    await service.setAutostart(true);
    assert.equal(record.cmd, 'powershell.exe');
    assert.ok(record.args?.some((a) => a.endsWith('set-autostart.ps1')), '应调用 set-autostart.ps1');
    assert.ok(record.args?.includes('-Enable'), '应带 -Enable');
    assert.ok(record.args?.includes('-RepoRoot'), '应带 -RepoRoot');
  });

  it('-Disable 调 powershell 执行 set-autostart.ps1 且带 -Disable', async () => {
    const repo = makeRepo();
    const record: SpawnRecord = { code: 0 };
    const service = createSystemService({
      repoRoot: repo,
      port: 5178,
      dataDir: path.join(repo, 'data'),
      appDataDir: tempDir(),
      spawnImpl: fakeSpawn(record),
    });

    await service.setAutostart(false);
    assert.ok(record.args?.includes('-Disable'), '应带 -Disable');
  });

  it('脚本非零退出时抛出 AUTOSTART_FAILED', async () => {
    const repo = makeRepo();
    const service = createSystemService({
      repoRoot: repo,
      port: 5178,
      dataDir: path.join(repo, 'data'),
      appDataDir: tempDir(),
      spawnImpl: fakeSpawn({ code: 1 }),
    });

    await assert.rejects(
      () => service.setAutostart(true),
      (error: unknown) => error instanceof SystemError && error.code === 'AUTOSTART_FAILED',
    );
  });
});

describe('system-service scheduleUninstall', () => {
  it('把清理器复制到 tmpDir 并 detached spawn', async () => {
    const repo = makeRepo();
    const tmpDir = tempDir('notification-hub-tmp-');
    const record: SpawnRecord = { code: 0 };
    const service = createSystemService({
      repoRoot: repo,
      port: 5178,
      dataDir: path.join(repo, 'data'),
      tmpDir,
      spawnImpl: fakeSpawn(record),
    });

    const script = await service.scheduleUninstall();
    assert.ok(script.startsWith(tmpDir), '应复制到 tmpDir');
    assert.ok(existsSync(script), '复制后的清理器应存在');
    assert.ok(record.args?.includes('-File'), 'powershell 应带 -File');
    assert.ok(record.args?.includes(script), '应执行复制后的脚本');
    assert.ok(record.args?.includes('-RepoRoot'), '应带 -RepoRoot');
    assert.equal(record.opts?.detached, true, '应为独立进程');
  });
});
