import { beforeEach, describe, expect, it } from 'vitest';
import { allocate, getBalance, getPosition } from '../core/ledger.js';
import {
  applyFill,
  createOrder,
  expireOpenOrders,
  getOrder,
  markCancelled,
  markSubmitted,
  markUnknown,
  settleDate,
} from '../core/orders.js';
import { checkLedgerConsistency } from '../core/reconcile.js';
import { addHoliday } from '../core/state.js';
import { toTwIso } from '../core/time.js';
import { type TestEnv, buy, errorCode, makeEnv, sell } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  allocate(env.db, 100_000, 'user', undefined, env.clock);
});

const fill = (orderId: number, qty: number, priceX100: number) =>
  applyFill(env.db, { orderId, qty, priceX100, ts: toTwIso(env.clock.now()), category: 'etf', simulated: true }, env.clock);

describe('圈存', () => {
  it('買單建立時圈存價金加預估手續費，可用資金減少', () => {
    const order = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    expect(order.status).toBe('pending_submit');
    expect(order.reserved_amount).toBe(10_014);
    expect(getBalance(env.db)).toEqual({ cash: 100_000, reserved: 10_014, available: 89_986 });
  });

  it('部分成交後依剩餘股數保留圈存，取消後全部釋放', () => {
    const order = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    markSubmitted(env.db, order.id, 'A0001', env.clock);
    fill(order.id, 100, 5000);
    const b = getBalance(env.db);
    expect(b.reserved).toBe(5007);
    expect(b.cash).toBe(100_000 - 5000 - 7);

    markCancelled(env.db, order.id, env.clock);
    expect(getBalance(env.db).reserved).toBe(0);
    expect(getOrder(env.db, order.id)).toMatchObject({ status: 'cancelled', filled_qty: 100 });
  });

  it('時段結束未成交的委託轉為 expired 並釋放圈存', () => {
    const order = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    markSubmitted(env.db, order.id, null, env.clock);
    expect(expireOpenOrders(env.db, 'odd_intraday', env.clock)).toBe(1);
    expect(getBalance(env.db).reserved).toBe(0);
  });

  it('unknown 委託仍保留圈存', () => {
    const order = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    markUnknown(env.db, order.id, env.clock);
    expect(getBalance(env.db).reserved).toBe(10_014);
  });
});

describe('成交入帳', () => {
  it('買進：成本含手續費；賣出：扣稅、依平均成本扣除成本', () => {
    const b = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    markSubmitted(env.db, b.id, null, env.clock);
    const r = fill(b.id, 200, 4995);
    expect(r.fee).toBe(14); // 9990 × 0.1425% = 14.2
    expect(r.order.status).toBe('filled');

    const pos = getPosition(env.db, '0050');
    expect(pos.qty).toBe(200);
    expect(pos.cost_x100).toBe((9990 + 14) * 100);
    expect(getBalance(env.db)).toEqual({ cash: 100_000 - 9990 - 14, reserved: 0, available: 100_000 - 9990 - 14 });

    env.clock.advanceMinutes(30);
    const s = createOrder(env.db, sell('0050', 100, 5100), env.ctx);
    markSubmitted(env.db, s.id, null, env.clock);
    const sr = fill(s.id, 100, 5100);
    expect(sr.tax).toBe(5); // 5100 × 0.1%
    expect(sr.dayTrade).toBe(true);
    expect(getPosition(env.db, '0050')).toMatchObject({ qty: 100, cost_x100: 500_200 });
    expect(checkLedgerConsistency(env.db)).toEqual([]);
  });

  it('成交價不可劣於限價，成交量不可超過委託', () => {
    const b = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    expect(errorCode(() => fill(b.id, 100, 5005))).toBe('FILL_PRICE_ABOVE_LIMIT');
    expect(errorCode(() => fill(b.id, 300, 5000))).toBe('FILL_EXCEEDS_ORDER');
  });

  it('前一日持股的賣出不是當沖', () => {
    const b = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    fill(b.id, 200, 5000);
    env.clock.set('2026-10-20T10:00:00.000+08:00');
    const s = createOrder(env.db, sell('0050', 200, 5000), env.ctx);
    expect(fill(s.id, 200, 5000).dayTrade).toBe(false);
  });
});

describe('成交時間', () => {
  it('UTC 格式的成交時間轉成台灣時間入帳，交易日不會錯一天', () => {
    const b = createOrder(env.db, buy('0050', 100, 5000), env.ctx);
    // 2026-10-18T23:59Z = 台灣 2026-10-19 07:59
    applyFill(env.db, { orderId: b.id, qty: 100, priceX100: 5000, ts: '2026-10-18T23:59:00.000Z', category: 'etf' }, env.clock);
    const f = env.db.prepare('SELECT ts, settle_date FROM fills').get() as { ts: string; settle_date: string };
    expect(f.ts).toBe('2026-10-19T07:59:00.000+08:00');
    expect(f.settle_date).toBe('2026-10-21');
  });
});

describe('交割日', () => {
  it('T+2 跳過週末與休市日', () => {
    expect(settleDate(env.db, '2026-10-19')).toBe('2026-10-21');
    expect(settleDate(env.db, '2026-10-22')).toBe('2026-10-26');
    addHoliday(env.db, '2026-10-21', '測試休市');
    expect(settleDate(env.db, '2026-10-19')).toBe('2026-10-22');
  });
});
