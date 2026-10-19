import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectRoot } from '../core/config.js';
import { CtradeError, ExitCode } from '../core/errors.js';
import type { Bar } from '../core/indicators.js';
import { serve } from '../core/ipc.js';

/**
 * ctrade journal add 的指標快照：決策先寫入，再向 daemon 取與 ctrade indicators 相同的資料補上。
 * daemon 不可用、逾時或回錯誤時，決策照常寫入、快照留空並記下原因（交易原則第 4 條）。
 * daemon 以測試程序內的假 IPC 服務代替，ctrade 以非同步子程序執行。
 */

const repo = projectRoot();
const NOW = '2026-10-19T10:00:00+08:00';
const TODAY = '2026-10-19';

let home: string;
let ipc: string;
let daemon: Server;
let mode: 'ok' | 'hang' | 'feed_error' = 'ok';
const requests: { method: string; params: any }[] = [];

/** 日 K：從 from 起每個平日一根，收盤緩步上升 */
function dailyBars(from: string, to: string): Bar[] {
  const bars: Bar[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  let close = 100;
  while (d.toISOString().slice(0, 10) <= to) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      close += 0.1;
      const c = Number(close.toFixed(2));
      bars.push({ date: d.toISOString().slice(0, 10), open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 5_000_000 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

/** 某一天 09:00 起的 5 分 K */
function intradayBars(date: string, closes: number[], volumes: number[]): Bar[] {
  return closes.map((c, k) => {
    const m = 9 * 60 + k * 5;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return { date: `${date}T${hh}:${mm}:00+08:00`, open: c, high: c + 0.3, low: c - 0.3, close: c, volume: volumes[k] ?? 100 };
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctrade-snapshot-'));
  cpSync(join(repo, 'config'), join(home, 'config'), { recursive: true });
  cpSync(join(repo, 'migrations'), join(home, 'migrations'), { recursive: true });
  rmSync(join(home, 'config', 'local.toml'), { force: true });
  ipc = process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-snapshot-${process.pid}-${Date.now()}` : join(home, 'daemon.sock');
  daemon = await serve(ipc, (method, params: any) => {
    requests.push({ method, params });
    if (mode === 'hang') return new Promise(() => {});
    if (method === 'quotes') {
      return (params.symbols as string[]).map((symbol) => ({ symbol, last_x100: 11_050, limit_up_x100: 12_000, limit_down_x100: 10_000 }));
    }
    if (method === 'bars') {
      if (mode === 'feed_error') throw new CtradeError('FEED_UNSUPPORTED', '行情來源 manual 不提供歷史 K 線', ExitCode.BROKER_ERROR);
      if (params.interval === 'D') return dailyBars(params.from, params.to);
      if (params.from === TODAY) return intradayBars(TODAY, [110, 110.5, 110.2, 109.8, 110.4, 110.6, 110.5, 110.3, 110.6, 110.8, 111], [300, 200, 150, 120, 180, 90, 110, 100, 140, 160, 999]);
      return [...intradayBars('2026-10-15', [109, 109.5], [4000, 3000]), ...intradayBars('2026-10-16', [109.5, 110], [5000, 2000])];
    }
    throw new Error(`unexpected ${method}`);
  });
});

afterAll(async () => {
  await new Promise((r) => daemon.close(r));
  rmSync(home, { recursive: true, force: true });
});

function ctrade(args: string[], ipcPath = ipc) {
  return new Promise<{ code: number | null; json: any; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', join(repo, 'cli', 'ctrade.ts'), ...args], {
      env: { ...process.env, CTRADE_HOME: home, CTRADE_MODE: '', CTRADE_IPC_PATH: ipcPath, CTRADE_TEST_NOW: NOW },
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.on('close', (code) => {
      let json: any;
      try {
        json = JSON.parse(out.trim());
      } catch {
        json = undefined;
      }
      resolve({ code, json, ms: Date.now() - started });
    });
  });
}

function decision(id: number) {
  const db = new Database(join(home, 'data', 'paper.db'), { readonly: true });
  try {
    return db.prepare('SELECT reasoning, indicators_json, indicators_error FROM decisions WHERE id = ?').get(id) as {
      reasoning: string;
      indicators_json: string | null;
      indicators_error: string | null;
    };
  } finally {
    db.close();
  }
}

const journal = (ipcPath?: string) => ctrade(['journal', 'add', '--reasoning', '盤勢整理', '--actions', '不動作'], ipcPath);

describe('journal add 的指標快照', () => {
  it('daemon 正常：快照與 ctrade indicators 的輸出相同（不含 notes）', async () => {
    mode = 'ok';
    const r = await journal();
    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ decision_id: expect.any(Number), indicators_snapshot: 'saved' });

    const row = decision(r.json.data.decision_id);
    expect(row.reasoning).toBe('盤勢整理');
    expect(row.indicators_error).toBeNull();
    const snap = JSON.parse(row.indicators_json!);
    expect(snap).not.toHaveProperty('notes');
    expect(snap).toMatchObject({ symbol: '0050', last_price: 110.5, daily: { sma: { '20': expect.any(Object), '60': expect.any(Object) } } });
    expect(snap.intraday.vwap).toEqual(expect.any(Number));
    expect(snap.intraday.last_bar).toMatchObject({ start: '2026-10-19T09:50:00+08:00', volume_lots: 999 });

    const ind = await ctrade(['indicators', '0050']);
    expect(ind.code).toBe(0);
    const { notes: _notes, ...expected } = ind.json.data;
    expect(snap).toEqual(expected);
  });

  it('daemon 未執行：決策照常寫入，快照留空並記下原因', async () => {
    const none = process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-snapshot-none-${process.pid}` : join(home, 'none.sock');
    const r = await journal(none);
    expect(r.code).toBe(0);
    expect(r.json.data.indicators_snapshot).toBe('unavailable');
    const row = decision(r.json.data.decision_id);
    expect(row.indicators_json).toBeNull();
    expect(row.indicators_error).toMatch(/^DAEMON_UNAVAILABLE/);
  });

  it('行情來源回錯誤：決策照常寫入', async () => {
    mode = 'feed_error';
    const r = await journal();
    expect(r.code).toBe(0);
    expect(r.json.data.indicators_snapshot).toBe('unavailable');
    expect(decision(r.json.data.decision_id)).toMatchObject({ indicators_json: null, indicators_error: expect.stringMatching(/^FEED_UNSUPPORTED/) });
  });

  it('daemon 沒有回應：約 5 秒後放棄快照，決策照常寫入', async () => {
    mode = 'hang';
    const r = await journal();
    expect(r.code).toBe(0);
    expect(r.json.data.indicators_snapshot).toBe('unavailable');
    expect(r.ms).toBeLessThan(15_000);
    expect(decision(r.json.data.decision_id)).toMatchObject({ indicators_json: null, indicators_error: expect.stringMatching(/^DAEMON_TIMEOUT/) });
  }, 30_000);
});
