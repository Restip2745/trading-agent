import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectRoot } from '../core/config.js';

/**
 * 端對端：以子程序執行 ctrade 與 ctrade-admin，確認輸出格式與結束碼（規格第 5 節）。
 * 使用暫存的 CTRADE_HOME，不碰專案的 data/。
 */

const repo = projectRoot();
let home: string;
const noDaemonPath =
  process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-test-none-${process.pid}` : join(tmpdir(), `ctrade-none-${process.pid}.sock`);

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ctrade-test-'));
  cpSync(join(repo, 'config'), join(home, 'config'), { recursive: true });
  cpSync(join(repo, 'migrations'), join(home, 'migrations'), { recursive: true });
  // 本機覆寫檔不帶進測試
  rmSync(join(home, 'config', 'local.toml'), { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function cli(bin: 'ctrade' | 'ctrade-admin', args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'cli', `${bin}.ts`), ...args], {
    // 指向不存在的 daemon，避免碰到本機正在執行的 daemon
    env: { ...process.env, CTRADE_HOME: home, CTRADE_MODE: '', CTRADE_IPC_PATH: noDaemonPath, ...env },
    encoding: 'utf8',
  });
  const out = r.stdout.trim();
  let json: { mode: string; ok: boolean; data?: any; error?: { code: string; message: string } } | undefined;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { code: r.status, out, json, stderr: r.stderr };
}

describe('CLI', () => {
  it('JSON 輸出第一個欄位是模式', () => {
    const r = cli('ctrade', ['balance']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith('{"mode":"PAPER"')).toBe(true);
    expect(r.json?.data).toEqual({ cash: 0, reserved: 0, available: 0 });
  });

  it('--text 輸出以 [PAPER] 開頭', () => {
    const r = cli('ctrade', ['balance', '--text']);
    expect(r.code).toBe(0);
    expect(r.out.startsWith('[PAPER]')).toBe(true);
  });

  it('撥入、轉入、查詢持倉，並寫入稽核記錄', () => {
    expect(cli('ctrade-admin', ['allocate', '--amount', '100000']).code).toBe(0);
    const t = cli('ctrade-admin', ['transfer-in', '0050', '--qty', '200', '--cost', '50.5']);
    expect(t.code).toBe(0);
    expect(t.json?.data).toMatchObject({ symbol: '0050', qty: 200, avg_cost: '50.50' });

    const s = cli('ctrade', ['status']);
    expect(s.json?.data).toMatchObject({ daemon: 'unavailable', cash: 100000, equity: 110100, valued_at_cost: ['0050'] });
  });

  it('撥出超過可用資金：結束碼 3，訊息寫出限制值', () => {
    const r = cli('ctrade-admin', ['withdraw', '--amount', '999999']);
    expect(r.code).toBe(3);
    expect(r.json?.ok).toBe(false);
    expect(r.json?.error?.message).toContain('100000');
  });

  it('參數錯誤：結束碼 2', () => {
    expect(cli('ctrade-admin', ['allocate']).code).toBe(2);
    expect(cli('ctrade-admin', ['allocate', '--amount', 'abc']).code).toBe(2);
    expect(cli('ctrade', ['no-such-command']).code).toBe(2);
  });

  it('觸發條件超出範圍：結束碼 3', () => {
    const r = cli('ctrade', ['trigger', 'set', '--interval', '1']);
    expect(r.code).toBe(3);
    expect(r.json?.error?.code).toBe('TRIGGER_OUT_OF_RANGE');
    expect(cli('ctrade', ['trigger', 'set', '--interval', '10']).code).toBe(0);
  });

  it('唯讀模式拒絕設定指令', () => {
    const r = cli('ctrade', ['stop', 'set', '0050', '--stop', '48'], { CTRADE_READONLY: '1' });
    expect(r.json?.error?.code).toBe('READONLY');
    expect(cli('ctrade', ['stop', 'set', '0050', '--stop', '48']).code).toBe(0);
  });

  it('暫停與恢復', () => {
    expect(cli('ctrade-admin', ['pause', '--reason', '測試']).json?.data).toMatchObject({ paused: true, reason: '測試' });
    expect(cli('ctrade', ['status']).json?.data.paused).toBe(true);
    expect(cli('ctrade-admin', ['resume']).json?.data.paused).toBe(false);
  });

  it('決策記錄', () => {
    const r = cli('ctrade', ['journal', 'add', '--reasoning', '盤勢整理', '--actions', '不動作']);
    expect(r.code).toBe(0);
    expect(r.json?.data.decision_id).toBeGreaterThan(0);
  });

  it('CTRADE_MODE 與設定檔不一致：結束碼 1', () => {
    const r = cli('ctrade', ['balance'], { CTRADE_MODE: 'live' });
    expect(r.code).toBe(1);
    expect(r.json?.error?.code).toBe('MODE_MISMATCH');
  });

  it('daemon 未執行時下單：結束碼 4，不寫入委託', () => {
    const r = cli('ctrade', ['order', 'buy', '0050', '--qty', '100', '--price', '50', '--session', 'odd_intraday']);
    expect(r.code).toBe(4);
    expect(r.json?.error?.code).toBe('DAEMON_UNAVAILABLE');
    expect(cli('ctrade', ['orders']).json?.data).toEqual([]);
  });

  it('下單缺少必要參數：結束碼 2', () => {
    expect(cli('ctrade', ['order', 'buy', '0050', '--qty', '100', '--price', '50']).code).toBe(2);
    expect(cli('ctrade', ['order', 'buy', '0050', '--qty', '100', '--price', '50', '--session', 'night']).code).toBe(2);
  });

  it('CTRADE_TEST_NOW 在 live 模式被拒絕', () => {
    writeFileSync(join(home, 'config', 'local.toml'), 'mode = "live"\n');
    try {
      const r = cli('ctrade', ['balance'], { CTRADE_TEST_NOW: '2026-10-19T10:00:00+08:00' });
      expect(r.json?.error?.code).toBe('TEST_CLOCK_IN_LIVE');
    } finally {
      rmSync(join(home, 'config', 'local.toml'), { force: true });
    }
  });

  it('對帳通過', () => {
    expect(cli('ctrade-admin', ['reconcile']).json?.data).toEqual({ status: 'ok', diffs: [] });
  });

  it('live 模式轉入持股需要券商查詢', () => {
    writeFileSync(join(home, 'config', 'local.toml'), 'mode = "live"\n');
    try {
      const r = cli('ctrade-admin', ['transfer-in', '0050', '--qty', '1', '--cost', '50']);
      expect(r.code).toBe(4);
      expect(r.out.startsWith('{"mode":"LIVE"')).toBe(true);
    } finally {
      rmSync(join(home, 'config', 'local.toml'), { force: true });
    }
  });
});
