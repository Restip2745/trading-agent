import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, projectRoot } from '../core/config.js';
import { type DB, openDb } from '../core/db.js';
import { call } from '../core/ipc.js';
import { ManualFeed } from '../daemon/feeds.js';
import { Daemon } from '../daemon/service.js';
import { testClock } from './helpers.js';

/**
 * 端對端：daemon 在測試程序內執行（ManualFeed 推送行情），ctrade 以子程序透過 IPC 下單。
 * 子程序必須用非同步的 spawn，否則會卡住 daemon 所在的事件迴圈。
 */

const repo = projectRoot();
const NOW = '2026-10-19T10:00:00.000+08:00';
const S = '00632R';

let home: string;
let ipc: string;
let db: DB;
let daemon: Daemon;
let feed: ManualFeed;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctrade-daemon-'));
  cpSync(join(repo, 'config'), join(home, 'config'), { recursive: true });
  cpSync(join(repo, 'migrations'), join(home, 'migrations'), { recursive: true });
  rmSync(join(home, 'config', 'local.toml'), { force: true });
  ipc = process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-test-${process.pid}-${Date.now()}` : join(home, 'daemon.sock');

  const prevMode = process.env.CTRADE_MODE;
  delete process.env.CTRADE_MODE;
  const config = loadConfig(home);
  if (prevMode !== undefined) process.env.CTRADE_MODE = prevMode;
  config.paper.submit_delay_ms = [0, 0];

  const clock = testClock(NOW);
  db = openDb({ root: home, config, clock });
  feed = new ManualFeed();
  daemon = new Daemon({ config, db, root: home, clock, feed, ipcPath: ipc, claude: false, tickMs: 0, log: () => {} });
  await daemon.start();

  feed.push(
    { type: 'ticker', symbol: S, ts: NOW, reference_x100: 1500, prev_close_x100: 1500, limit_up_x100: 1650, limit_down_x100: 1350 },
    {
      type: 'book',
      symbol: S,
      board: 'regular',
      ts: NOW,
      bids: [{ price_x100: 1494, size: 5000 }],
      asks: [{ price_x100: 1495, size: 1000 }],
    },
  );
});

afterAll(async () => {
  await daemon.stop();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function cli(bin: 'ctrade' | 'ctrade-admin', args: string[]) {
  return new Promise<{ code: number | null; json: any; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repo, 'cli', `${bin}.ts`), ...args], {
      env: { ...process.env, CTRADE_HOME: home, CTRADE_MODE: '', CTRADE_IPC_PATH: ipc, CTRADE_TEST_NOW: NOW },
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
      resolve({ code, json, out });
    });
  });
}

describe('daemon 與 ctrade', () => {
  it('ping', async () => {
    expect(await call(ipc, 'ping')).toMatchObject({ mode: 'paper', broker: 'paper', feed: 'manual' });
  });

  it('撥入資金', async () => {
    expect((await cli('ctrade-admin', ['allocate', '--amount', '100000'])).code).toBe(0);
  });

  it('ctrade quote 回傳漲跌停、五檔與升降單位', async () => {
    const r = await cli('ctrade', ['quote', S]);
    expect(r.code).toBe(0);
    expect(r.json.data[0]).toMatchObject({
      symbol: S,
      available: true,
      limit_up: '16.50',
      limit_down: '13.50',
      best_ask: '14.95',
      tick_size: '0.01',
    });
  });

  it('可成交的限價買單：daemon 模擬撮合後回傳成交', async () => {
    const r = await cli('ctrade', ['order', 'buy', S, '--qty', '1000', '--price', '15.00', '--session', 'regular']);
    expect(r.code).toBe(0);
    expect(r.json.data.order).toMatchObject({ status: 'filled', filled_qty: 1000 });
    expect(r.json.data.fills[0]).toMatchObject({ price: '14.95', qty: 1000, simulated: true });
  });

  it('掛單後刪單，圈存釋放', async () => {
    const placed = await cli('ctrade', ['order', 'buy', S, '--qty', '500', '--price', '14.80', '--session', 'odd_intraday']);
    expect(placed.json.data.order.status).toBe('submitted');
    expect(placed.json.data.balance.reserved).toBeGreaterThan(0);

    const id = String(placed.json.data.order.id);
    const cancelled = await cli('ctrade', ['order', 'cancel', id]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.json.data.order.status).toBe('cancelled');
    expect(cancelled.json.data.balance.reserved).toBe(0);
  });

  it('掛單在後續行情中成交', async () => {
    const placed = await cli('ctrade', ['order', 'buy', S, '--qty', '200', '--price', '14.90', '--session', 'odd_intraday']);
    const id = placed.json.data.order.id as number;
    feed.push({ type: 'trade', symbol: S, board: 'odd', ts: '2026-10-19T10:01:00.000+08:00', price_x100: 1490, volume: 5000 });
    const orders = await cli('ctrade', ['orders']);
    expect(orders.json.data.find((o: { id: number }) => o.id === id)).toMatchObject({ status: 'filled', filled_qty: 200 });
  });

  it('風控拒絕：結束碼 3，回報最近合法價，不寫入委託', async () => {
    const before = (await cli('ctrade', ['orders'])).json.data.length;
    const r = await cli('ctrade', ['order', 'buy', S, '--qty', '100', '--price', '14.955', '--session', 'odd_intraday']);
    expect(r.code).toBe(2); // 三位小數是參數錯誤
    const r2 = await cli('ctrade', ['order', 'buy', S, '--qty', '100', '--price', '17.00', '--session', 'odd_intraday']);
    expect(r2.code).toBe(3);
    expect(r2.json.error.code).toBe('PRICE_OUT_OF_LIMIT');
    expect((await cli('ctrade', ['orders'])).json.data.length).toBe(before);
  });

  it('不能賣出帳本以外的持股', async () => {
    const r = await cli('ctrade', ['order', 'sell', S, '--qty', '2000', '--session', 'regular', '--price', '15.00']);
    expect(r.code).toBe(3);
    expect(r.json.error.code).toBe('SELL_EXCEEDS_SELLABLE');
  });

  it('status 以 daemon 報價估值', async () => {
    const r = await cli('ctrade', ['status']);
    expect(r.json.data).toMatchObject({ daemon: 'running', valued_at_cost: [] });
    // 還沒有整股成交，最後成交價以前一日收盤 15.00 計
    expect(r.json.data.market_value).toBe(Math.floor((1500 * 1200) / 100));
  });

  it('daemon 重複收到同一筆委託不會重送', async () => {
    const orders = (await cli('ctrade', ['orders'])).json.data as { id: number; status: string }[];
    const filled = orders.find((o) => o.status === 'filled')!;
    const r = await call<{ order: { status: string } }>(ipc, 'submit', { orderId: filled.id });
    expect(r.order.status).toBe('filled');
    expect(db.prepare('SELECT COUNT(*) FROM fills WHERE order_id = ?').pluck().get(filled.id)).toBe(1);
  });
});
