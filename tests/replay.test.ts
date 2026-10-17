import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectRoot } from '../core/config.js';
import { allocate, getBalance, getPosition } from '../core/ledger.js';
import { type MarketEvent, QuoteCache } from '../core/marketdata.js';
import { createOrder, expireOpenOrders, getOrder, markSubmitted } from '../core/orders.js';
import { PaperMatcher } from '../core/paper.js';
import { checkLedgerConsistency } from '../core/reconcile.js';
import type { OrderRequest } from '../core/risk.js';
import { ReplayFeed, readRecording } from '../daemon/feeds.js';
import { type TestEnv, buy, errorCode, makeEnv, sell } from './helpers.js';

/**
 * 第 3 階段驗收：以錄製的行情資料重播，模擬撮合結果符合第 7 節規則（規格第 19 節）。
 */

const FIXTURE = join(projectRoot(), 'tests', 'fixtures', 'replay-00632R.jsonl');
const S = '00632R';
const at = (hhmm: string) => `2026-10-19T${hhmm}.000+08:00`;

let env: TestEnv;
let cache: QuoteCache;
let matcher: PaperMatcher;
let pending: MarketEvent[];

beforeEach(() => {
  env = makeEnv(at('08:30:00'));
  allocate(env.db, 100_000, 'user', undefined, env.clock);
  cache = new QuoteCache();
  matcher = new PaperMatcher(env.db, env.config, env.clock, (s, b) => cache.book(s, b), {
    fillAtTouch: false,
    maxVolumeSharePct: 20,
  });
  // 風控也用重播出來的報價，跟 daemon 一樣
  env.ctx.quotes = cache;
  pending = readRecording(FIXTURE);
});

/** 依序送出時間 ≤ until 的事件，時鐘跟著事件走。 */
function replayUntil(until: string) {
  while (pending.length > 0 && Date.parse(pending[0]!.ts) <= Date.parse(until)) {
    const e = pending.shift()!;
    env.clock.set(e.ts);
    cache.apply(e);
    matcher.onEvent(e);
  }
  env.clock.set(until);
}

function submit(req: OrderRequest): number {
  const o = createOrder(env.db, req, env.ctx);
  markSubmitted(env.db, o.id, `P${o.id}`, env.clock);
  matcher.onSubmitted(o.id);
  return o.id;
}

describe('重播一個交易日', () => {
  it('開盤競價、逐筆掛單、零股、收盤競價、盤後零股', () => {
    replayUntil(at('08:50:00'));
    const a = submit(buy(S, 1000, 1500, { session: 'regular' })); // 等開盤競價

    replayUntil(at('09:10:00'));
    expect(getOrder(env.db, a)).toMatchObject({ status: 'filled' }); // 開盤 14.98，以撮合價成交
    const b = submit(buy(S, 1000, 1490, { session: 'regular' })); // 低於賣一 14.98，掛單

    replayUntil(at('09:20:00'));
    expect(getOrder(env.db, b).filled_qty).toBe(0); // 14.92 未穿越、14.90 剛好等於限價
    replayUntil(at('09:25:00'));
    expect(getOrder(env.db, b).filled_qty).toBe(0); // 14.89 穿越但 3000 股的 20% 不足一張
    replayUntil(at('09:30:00'));
    expect(getOrder(env.db, b)).toMatchObject({ status: 'filled', filled_qty: 1000 }); // 以限價 14.90 成交

    replayUntil(at('10:00:00'));
    const c = submit(sell(S, 500, 1495)); // 盤中零股賣出
    replayUntil(at('10:01:30'));
    expect(getOrder(env.db, c)).toMatchObject({ status: 'filled', filled_qty: 500 });

    // 賣出成交後 15 分鐘內不得再買進同一標的
    expect(errorCode(() => submit(buy(S, 300, 1494)))).toBe('REENTRY_COOLDOWN');

    replayUntil(at('13:26:00'));
    const e = submit(sell(S, 1000, 1505, { session: 'regular' })); // 收盤競價
    replayUntil(at('13:31:00'));
    expect(getOrder(env.db, e)).toMatchObject({ status: 'filled' });

    replayUntil(at('14:00:00'));
    const f = submit(sell(S, 100, 1510, { session: 'odd_after' })); // 盤後零股撮合價 15.06 低於限價
    replayUntil(at('14:31:00'));
    expect(getOrder(env.db, f).filled_qty).toBe(0);
    expireOpenOrders(env.db, 'odd_after', env.clock);
    expect(getOrder(env.db, f).status).toBe('expired');

    const prices = env.db.prepare('SELECT price_x100 FROM fills ORDER BY id').pluck().all();
    expect(prices).toEqual([1498, 1490, 1495, 1505]);
    expect(getPosition(env.db, S).qty).toBe(500);
    expect(getBalance(env.db).reserved).toBe(0);
    expect(checkLedgerConsistency(env.db)).toEqual([]);
  });
});

describe('ReplayFeed', () => {
  it('倍速 0 時依序立即送出全部事件', async () => {
    const got: MarketEvent[] = [];
    await ReplayFeed.fromFile(FIXTURE, { speed: 0, rebaseToNow: false }).start((e) => got.push(e));
    expect(got).toHaveLength(readRecording(FIXTURE).length);
    expect(got[0]?.type).toBe('ticker');
  });

  it('rebaseToNow 時把事件時間改寫成當下', async () => {
    const got: MarketEvent[] = [];
    await ReplayFeed.fromFile(FIXTURE, { speed: 0, rebaseToNow: true }).start((e) => got.push(e));
    expect(got.every((e) => !e.ts.startsWith('2026-10-19T08:30'))).toBe(true);
  });
});
