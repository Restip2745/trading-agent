import type { Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDayChart, decisionOrderSummary, defaultChartSymbol, loadDayBars } from '../core/chart.js';
import { loadConfig, projectRoot } from '../core/config.js';
import type { Bar } from '../core/indicators.js';
import { serve } from '../core/ipc.js';
import { allocate } from '../core/ledger.js';
import { applyFill, createOrder, markSubmitted } from '../core/orders.js';
import { toTwIso } from '../core/time.js';
import { buildServer } from '../web/server.js';
import { type TestEnv, buy, makeEnv, testClock } from './helpers.js';

/** 決策日誌的盤勢圖：K 線快取、決策與成交、停損停利、觸發帶、等效曝險。 */

const DAY = '2026-10-16'; // 週五；測試時鐘在下週一

/** 從 09:00 起的 5 分 K，收盤價依序為 closes。 */
function makeBars(date: string, closes: number[], volume = 100): Bar[] {
  return closes.map((close, i) => {
    const m = 540 + i * 5;
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const open = i === 0 ? close : closes[i - 1]!;
    return { date: `${date}T${hh}:${mm}:00.000+08:00`, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume };
  });
}

describe('K 線快取', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = makeEnv();
  });

  it('過去的交易日第一次向 daemon 取並快取，之後直接讀快取', async () => {
    let calls = 0;
    const fetch = async (_s: string, d: string) => (calls++, makeBars(d, [50, 50.5]));
    expect(await loadDayBars(env.db, '0050', DAY, env.clock, fetch)).toMatchObject({ source: 'daemon', bars: { length: 2 } });
    expect(await loadDayBars(env.db, '0050', DAY, env.clock, fetch)).toMatchObject({ source: 'cache', bars: { length: 2 } });
    expect(calls).toBe(1);
  });

  it('當天與空結果不快取；取不到時回錯誤訊息而不是丟例外', async () => {
    let calls = 0;
    const fetch = async (_s: string, d: string) => (calls++, d === DAY ? [] : makeBars(d, [50]));
    await loadDayBars(env.db, '0050', '2026-10-19', env.clock, fetch);
    await loadDayBars(env.db, '0050', '2026-10-19', env.clock, fetch);
    await loadDayBars(env.db, '0050', DAY, env.clock, fetch);
    await loadDayBars(env.db, '0050', DAY, env.clock, fetch);
    expect(calls).toBe(4);
    const failed = await loadDayBars(env.db, '0050', '2026-10-15', env.clock, async () => {
      throw new Error('無法連線到 daemon');
    });
    expect(failed).toEqual({ bars: [], source: 'none', error: '無法連線到 daemon' });
  });

  it('預設基準標的是槓桿 1 倍的標的', () => {
    expect(defaultChartSymbol(env.config)).toBe('0050');
  });
});

describe('單日盤勢圖', () => {
  let env: TestEnv;
  const at = (hhmm: string, date = DAY) => `${date}T${hhmm}:00.000+08:00`;

  beforeEach(() => {
    env = makeEnv(at('10:00', '2026-10-15'));
    const { db, clock } = env;
    allocate(db, 200_000, 'user', undefined, clock);
    // 前一天：買進 0050 500 股、設停損 48
    const o1 = createOrder(db, buy('0050', 500, 5000), env.ctx);
    markSubmitted(db, o1.id, null, clock);
    applyFill(db, { orderId: o1.id, qty: 500, priceX100: 5000, ts: toTwIso(clock.now()), category: 'etf', simulated: true }, clock);
    db.prepare(`INSERT INTO protective_stops (ts, symbol, stop_x100, set_by) VALUES (?, '0050', 4800, 'claude')`).run(at('10:01', '2026-10-15'));

    // 當天：盤前重設觸發條件，09:05 決策（不動作），10:10 決策買進 00631L
    db.prepare(`INSERT INTO trigger_config (interval_min, up_pct, down_pct, set_by, set_at) VALUES (5, 3, 2, 'system', ?)`).run(at('08:30'));
    const insertDecision = db.prepare(`INSERT INTO decisions (ts, reasoning, actions_json) VALUES (?, ?, ?)`);
    const d1 = Number(insertDecision.run(at('09:05'), '觀望', JSON.stringify('不動作')).lastInsertRowid);
    db.prepare(`INSERT INTO price_refs (symbol, price_x100, decision_id, set_at) VALUES ('0050', 5000, ?, ?)`).run(d1, at('09:06'));
    const d2 = Number(insertDecision.run(at('10:10'), '放量止跌', JSON.stringify('買進 00631L 1000 股')).lastInsertRowid);
    clock.set(at('10:10'));
    env.quotes.set('00631L', 2000);
    const o2 = createOrder(db, buy('00631L', 1000, 2000), env.ctx, { decisionId: d2 });
    markSubmitted(db, o2.id, null, clock);
    applyFill(db, { orderId: o2.id, qty: 1000, priceX100: 2000, ts: at('10:12'), category: 'etf', simulated: true }, clock);
    db.prepare(`INSERT INTO protective_stops (ts, symbol, stop_x100, take_profit_x100, set_by) VALUES (?, '0050', 4900, 5300, 'claude')`).run(at('10:12'));
  });

  const chart = () =>
    buildDayChart(
      env.db,
      env.config,
      DAY,
      '0050',
      new Map([
        ['0050', makeBars(DAY, [50, 50.2, 50.4, 50.1, 49.9, 50, 50.3, 50.5, 50.6, 50.8, 51, 51.2, 51.1, 51, 50.9, 51.3, 51.4])],
        ['00631L', makeBars(DAY, Array.from({ length: 17 }, () => 20))],
      ]),
    );

  it('當天的決策（含委託數）與成交', () => {
    const c = chart();
    expect(c.decisions.map((d) => [d.ts.slice(11, 16), d.actions, d.orders])).toEqual([
      ['09:05', '不動作', 0],
      ['10:10', '買進 00631L 1000 股', 1],
    ]);
    // 前一天的成交不在當天的圖上
    expect(c.fills).toMatchObject([{ symbol: '00631L', side: 'buy', price: 20, qty: 1000, decision_id: c.decisions[1]!.id }]);
  });

  it('決策依委託方向分類：買入、賣出、買賣、不動作，並標示是否成交', () => {
    const { db } = env;
    const insertDecision = db.prepare(`INSERT INTO decisions (ts, reasoning, actions_json) VALUES (?, '', '""')`);
    const insertOrder = db.prepare(
      `INSERT INTO orders (client_order_id, symbol, side, session, origin, price_x100, qty, status, decision_id, created_at, updated_at)
       VALUES (?, '0050', ?, 'odd_intraday', 'claude', 5000, 100, 'cancelled', ?, ?, ?)`,
    );
    const sellOnly = Number(insertDecision.run(at('11:00')).lastInsertRowid);
    insertOrder.run('t-sell', 'sell', sellOnly, at('11:00'), at('11:00'));
    const both = Number(insertDecision.run(at('11:30')).lastInsertRowid);
    insertOrder.run('t-both-b', 'buy', both, at('11:30'), at('11:30'));
    insertOrder.run('t-both-s', 'sell', both, at('11:30'), at('11:30'));

    const c = chart();
    expect(c.decisions.map((d) => [d.ts.slice(11, 16), d.action, d.filled])).toEqual([
      ['09:05', 'none', false],
      ['10:10', 'buy', true],
      ['11:00', 'sell', false], // 有下單但被刪單：未成交
      ['11:30', 'both', false],
    ]);
    expect(decisionOrderSummary(db, [both, 999]).get(999)).toEqual({ orders: 0, action: 'none', filled: false });
  });

  it('VWAP 為典型價格依量加權的累計值', () => {
    const c = chart();
    const b = c.bars[0]!;
    expect(c.vwap[0]).toBeCloseTo((b.high + b.low + b.close) / 3);
    expect(c.vwap).toHaveLength(c.bars.length);
  });

  it('停損停利與觸發帶延續前一天的設定，再加上當天的變動', () => {
    const c = chart();
    expect(c.stops).toEqual([
      { ts: at('10:01', '2026-10-15'), stop: 48, take_profit: null },
      { ts: at('10:12'), stop: 49, take_profit: 53 },
    ]);
    const last = c.triggers[c.triggers.length - 1]!;
    expect(last.ref).toBe(50);
    expect(last.upper).toBeCloseTo(51.5);
    expect(last.lower).toBeCloseTo(49);
  });

  it('等效曝險：市值 × 槓桿 ÷ 權益，成交後加入新的標的', () => {
    const c = chart();
    expect(c.exposure_symbols).toEqual([
      { symbol: '0050', leverage: 1 },
      { symbol: '00631L', leverage: 2 },
    ]);
    const first = c.exposure[0]!; // 09:05：只有 0050 500 股，收 50
    const p0050 = first.parts.find((p) => p.symbol === '0050')!;
    expect(p0050).toMatchObject({ qty: 500, value: 25_000 });
    expect(first.net_pct).toBeCloseTo(25_000 / first.equity);

    const after = c.exposure.find((p) => p.t >= at('10:15'))!; // 10:12 成交後
    const pL = after.parts.find((p) => p.symbol === '00631L')!;
    expect(pL).toMatchObject({ qty: 1000, value: 40_000 }); // 1000 股 × 20 元 × 2 倍
    expect(after.net_pct).toBeCloseTo(after.parts.reduce((s, p) => s + p.value, 0) / after.equity);
  });

  it('沒有 K 線時仍回傳決策與成交，曝險為空', () => {
    const c = buildDayChart(env.db, env.config, DAY, '0050', new Map());
    expect(c.bars).toEqual([]);
    expect(c.decisions).toHaveLength(2);
    expect(c.exposure).toEqual([]);
  });
});

describe('Web API /api/chart/day', () => {
  const PORT = 18789;
  const HOST = `127.0.0.1:${PORT}`;
  let dir: string;
  let daemon: Server;
  let server: Awaited<ReturnType<typeof buildServer>>;
  const requests: unknown[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctrade-chart-'));
    const ipcPath = process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-chart-${process.pid}` : join(dir, 'd.sock');
    daemon = await serve(ipcPath, (method, params) => {
      if (method !== 'bars') throw new Error(`unexpected ${method}`);
      requests.push(params);
      const p = params as { symbol: string; from: string };
      return makeBars(p.from, [50, 50.5, 51]);
    });
    const config = loadConfig(projectRoot());
    config.mode = 'paper';
    server = await buildServer({
      root: projectRoot(),
      config,
      clock: testClock('2026-10-19T10:00:00.000+08:00'),
      ipcPath,
      port: PORT,
      token: 'test-token',
      dbPath: join(dir, 'paper.db'),
    });
  });

  afterAll(async () => {
    await server.app.close();
    server.close();
    await new Promise((r) => daemon.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => server.app.inject({ method: 'GET', url, headers: { host: HOST } });

  it('過去的日期：第一次向 daemon 取，第二次讀快取', async () => {
    const first = (await get(`/api/chart/day?date=${DAY}`)).json().data;
    expect(first).toMatchObject({ symbol: '0050', bars_source: 'daemon', bars_error: null, bars: { length: 3 } });
    expect(first.symbols.map((s: { symbol: string }) => s.symbol)).toEqual(['0050', '00631L', '00632R']);
    expect((await get(`/api/chart/day?date=${DAY}`)).json().data.bars_source).toBe('cache');
    expect(requests).toEqual([{ symbol: '0050', interval: '5m', from: DAY, to: DAY }]);
  });

  it('可指定基準標的；未來的日期與錯誤的代號回 400', async () => {
    expect((await get(`/api/chart/day?date=${DAY}&symbol=00631L`)).json().data.symbol).toBe('00631L');
    expect((await get('/api/chart/day?date=2026-10-20')).json().error.code).toBe('INVALID_DATE');
    expect((await get('/api/chart/day?symbol=bad!')).json().error.code).toBe('INVALID_SYMBOL');
  });
});
