import { loadConfig, projectRoot, type Config } from '../core/config.js';
import { type DB, openDb } from '../core/db.js';
import { type Quote, type QuoteSource } from '../core/market.js';
import { type OrderRequest, type RiskContext } from '../core/risk.js';
import type { Clock } from '../core/time.js';

/** 2026-10-19 是週一，一般交易日。 */
export const MONDAY_10AM = '2026-10-19T10:00:00.000+08:00';

export interface TestClock extends Clock {
  set(iso: string): void;
  advanceMinutes(min: number): void;
}

export function testClock(iso = MONDAY_10AM): TestClock {
  let t = new Date(iso);
  return {
    now: () => new Date(t),
    set: (v) => {
      t = new Date(v);
    },
    advanceMinutes: (m) => {
      t = new Date(t.getTime() + m * 60_000);
    },
  };
}

/** 可修改的報價表，預設三檔 ETF 都有報價。價格以分表示。 */
export class TestQuotes implements QuoteSource {
  private map = new Map<string, Quote>();

  constructor() {
    this.set('0050', 5000);
    this.set('00631L', 2000);
    this.set('00632R', 1500);
  }

  set(symbol: string, lastX100: number, extra: Partial<Quote> = {}): void {
    this.map.set(symbol, {
      symbol,
      last_x100: lastX100,
      prev_close_x100: lastX100,
      limit_up_x100: Math.floor(lastX100 * 1.1),
      limit_down_x100: Math.ceil(lastX100 * 0.9),
      ts: MONDAY_10AM,
      ...extra,
    });
  }

  remove(symbol: string): void {
    this.map.delete(symbol);
  }

  getQuote(symbol: string): Quote | undefined {
    return this.map.get(symbol);
  }
}

export interface TestEnv {
  db: DB;
  config: Config;
  clock: TestClock;
  quotes: TestQuotes;
  ctx: RiskContext;
}

export function makeEnv(iso = MONDAY_10AM): TestEnv {
  const root = projectRoot();
  const config = loadConfig(root);
  config.mode = 'paper';
  // 測試的期望值以固定的數值計算，不受 config.toml 調整影響
  config.risk.max_order_amount = 30_000;
  config.fees.fee_discount = 1.0;
  config.fees.rebate_mode = 'instant';
  const clock = testClock(iso);
  const db = openDb({ root, config, path: ':memory:', clock });
  const quotes = new TestQuotes();
  return { db, config, clock, quotes, ctx: { config, quotes, clock } };
}

export const buy = (symbol: string, qty: number, priceX100: number, extra: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol,
  side: 'buy',
  session: qty % 1000 === 0 ? 'regular' : 'odd_intraday',
  priceX100,
  qty,
  origin: 'claude',
  ...extra,
});

export const sell = (symbol: string, qty: number, priceX100: number, extra: Partial<OrderRequest> = {}): OrderRequest => ({
  ...buy(symbol, qty, priceX100, extra),
  side: 'sell',
  ...extra,
});

/** 預期丟出指定代碼的 CtradeError。 */
export function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}
