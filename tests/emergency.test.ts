import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocate, getBalance, getPosition, transferIn } from '../core/ledger.js';
import { createOrder } from '../core/orders.js';
import { getPause } from '../core/state.js';
import { ManualFeed } from '../daemon/feeds.js';
import { Daemon } from '../daemon/service.js';
import { type TestEnv, buy, makeEnv } from './helpers.js';

/** 緊急操作（規格第 18 節）：刪除所有未完成委託、全部平倉，執行後自動暫停。 */

let env: TestEnv;
let root: string;
let daemon: Daemon;
const NOW = '2026-10-19T10:00:00.000+08:00';

beforeEach(() => {
  env = makeEnv(NOW);
  env.config.paper.submit_delay_ms = [0, 0];
  root = mkdtempSync(join(tmpdir(), 'ctrade-emergency-'));
  daemon = new Daemon({ config: env.config, db: env.db, root, clock: env.clock, feed: new ManualFeed(), ipcPath: 'unused', claude: false, tickMs: 0, log: () => {} });
  allocate(env.db, 200_000, 'user', undefined, env.clock);
  for (const [s, last] of [['0050', 10900], ['00632R', 965]] as const) {
    daemon.onMarketEvent({ type: 'ticker', symbol: s, ts: NOW, reference_x100: last, prev_close_x100: last, limit_up_x100: Math.floor(last * 1.1), limit_down_x100: Math.ceil(last * 0.9) });
  }
  daemon.onMarketEvent({ type: 'book', symbol: '00632R', board: 'regular', ts: NOW, bids: [{ price_x100: 964, size: 50_000 }], asks: [{ price_x100: 965, size: 50_000 }] });
  daemon.onMarketEvent({ type: 'book', symbol: '00632R', board: 'odd', ts: NOW, bids: [{ price_x100: 963, size: 5_000 }], asks: [{ price_x100: 966, size: 5_000 }] });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('刪除所有未完成委託', () => {
  it('刪掉所有掛單、釋放圈存並暫停', async () => {
    const ctx = { config: env.config, quotes: daemon.quotes, clock: env.clock };
    const a = createOrder(env.db, buy('0050', 100, 10800), ctx);
    const b = createOrder(env.db, buy('0050', 100, 10750), ctx);
    await daemon.broker.submit(a.id);
    await daemon.broker.submit(b.id);
    expect(getBalance(env.db).reserved).toBeGreaterThan(0);

    const r = (await daemon.handle('cancel_all', {})) as { cancelled: number[] };
    expect(r.cancelled).toEqual([a.id, b.id]);
    expect(getBalance(env.db).reserved).toBe(0);
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'emergency' });
  });
});

describe('全部平倉', () => {
  it('整股與零頭分別以對手價賣出全部持股，並暫停', async () => {
    transferIn(env.db, { symbol: '00632R', qty: 1500, costPerShareX100: 950, actor: 'user' }, env.clock);
    const r = (await daemon.handle('flatten', {})) as { orders: { session: string; qty: number; price: string; status: string }[] };
    expect(r.orders).toEqual([
      expect.objectContaining({ session: 'regular', qty: 1000, price: '9.64', status: 'filled' }),
      expect.objectContaining({ session: 'odd_intraday', qty: 500, price: '9.63' }),
    ]);
    expect(getPosition(env.db, '00632R')).toMatchObject({ qty: 500, sellable_qty: 0 }); // 零股等下一次撮合
    expect(getPause(env.db).paused).toBe(true);
    const origins = env.db.prepare(`SELECT DISTINCT origin FROM orders`).pluck().all();
    expect(origins).toEqual(['emergency']);
  });

  it('沒有報價的持股略過並回報', async () => {
    transferIn(env.db, { symbol: '2330', qty: 10, costPerShareX100: 100_000, actor: 'user' }, env.clock);
    const r = (await daemon.handle('flatten', {})) as { skipped: { symbol: string; reason: string }[] };
    expect(r.skipped).toEqual([{ symbol: '2330', reason: '沒有報價' }]);
  });

  it('不在委託時段時略過並回報', async () => {
    transferIn(env.db, { symbol: '00632R', qty: 1000, costPerShareX100: 950, actor: 'user' }, env.clock);
    env.clock.set('2026-10-19T15:00:00.000+08:00');
    const r = (await daemon.handle('flatten', {})) as { orders: unknown[]; skipped: { reason: string }[] };
    expect(r.orders).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('不在委託時段');
  });
});
