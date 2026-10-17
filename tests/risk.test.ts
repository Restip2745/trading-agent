import { beforeEach, describe, expect, it } from 'vitest';
import { allocate, transferIn } from '../core/ledger.js';
import { applyFill, createOrder, markUnknown, requestCancel } from '../core/orders.js';
import { checkOrder } from '../core/risk.js';
import { setRiskParams } from '../core/settings.js';
import { pause } from '../core/state.js';
import { toTwIso } from '../core/time.js';
import { type TestEnv, buy, errorCode, makeEnv, sell } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  allocate(env.db, 100_000, 'user', undefined, env.clock);
});

const check = (req: Parameters<typeof checkOrder>[1]) => errorCode(() => checkOrder(env.db, req, env.ctx));

const fillNow = (orderId: number, qty: number, priceX100: number) =>
  applyFill(env.db, { orderId, qty, priceX100, ts: toTwIso(env.clock.now()), category: 'etf' }, env.clock);

describe('第 1 條：暫停與時段', () => {
  it('暫停時拒絕 Claude 的委託，但風險應對單可以賣出', () => {
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5000, actor: 'user' }, env.clock);
    pause(env.db, 'manual', '測試', env.clock);
    expect(check(buy('0050', 100, 5000))).toBe('PAUSED');
    expect(check(sell('0050', 100, 5000, { origin: 'stop' }))).toBeUndefined();
  });

  it('非委託時段、非交易日拒絕', () => {
    env.clock.set('2026-10-19T08:00:00.000+08:00');
    expect(check(buy('0050', 1000, 5000))).toBe('OUT_OF_SESSION');
    env.clock.set('2026-10-19T08:30:00.000+08:00');
    expect(check(buy('0050', 1000, 5000, { qty: 1000 }))).not.toBe('OUT_OF_SESSION');
    expect(check(buy('0050', 100, 5000))).toBe('OUT_OF_SESSION'); // 盤中零股 09:00 才開始
    env.clock.set('2026-10-19T14:00:00.000+08:00');
    expect(check(buy('0050', 100, 5000, { session: 'odd_after' }))).toBeUndefined();
    env.clock.set('2026-10-17T10:00:00.000+08:00'); // 週六
    expect(check(buy('0050', 100, 5000))).toBe('OUT_OF_SESSION');
  });
});

describe('數量規則', () => {
  it('整股須為 1000 的倍數，零股 1–999 股', () => {
    expect(check(buy('0050', 1500, 5000, { session: 'regular' }))).toBe('INVALID_QTY');
    expect(check(buy('0050', 1000, 5000, { session: 'odd_intraday' }))).toBe('INVALID_QTY');
    expect(check(buy('0050', 0, 5000))).toBe('INVALID_QTY');
  });
});

describe('第 3 條：可用資金', () => {
  it('價金加預估手續費超過可用資金時拒絕', () => {
    setRiskParams(env.db, { max_order_amount: 1_000_000 }, env.clock);
    env.quotes.set('0050', 9500, { limit_up_x100: 10450, limit_down_x100: 8550 });
    // 90000 + 手續費 128 ≤ 100000
    expect(check(buy('0050', 1000, 9000, { session: 'regular' }))).toBeUndefined();
    // 100000 + 手續費 142 > 100000
    expect(check(buy('0050', 1000, 10000, { session: 'regular' }))).toBe('INSUFFICIENT_FUNDS');
  });

  it('已圈存的金額不能重複使用', () => {
    createOrder(env.db, buy('0050', 500, 5000), env.ctx); // 圈存 25035
    createOrder(env.db, buy('0050', 500, 5000), env.ctx);
    createOrder(env.db, buy('0050', 500, 5000), env.ctx); // 合計圈存 75105
    expect(check(buy('0050', 500, 5000))).toBe('INSUFFICIENT_FUNDS'); // 可用 24895 < 25035
  });
});

describe('第 4、11 條：只能賣帳本內的持股', () => {
  it('賣出超過可賣股數時拒絕，含未完成賣單', () => {
    expect(check(sell('0050', 1, 5000))).toBe('SELL_EXCEEDS_SELLABLE');
    transferIn(env.db, { symbol: '0050', qty: 300, costPerShareX100: 5000, actor: 'user' }, env.clock);
    expect(check(sell('0050', 300, 5000))).toBeUndefined();
    createOrder(env.db, sell('0050', 200, 5000), env.ctx);
    expect(check(sell('0050', 200, 5000))).toBe('SELL_EXCEEDS_SELLABLE');
  });

  it('風險應對單同樣不能賣超過帳本持股', () => {
    expect(check(sell('0050', 100, 5000, { origin: 'emergency' }))).toBe('SELL_EXCEEDS_SELLABLE');
  });

  it('風險應對單不能買進', () => {
    expect(check(buy('0050', 100, 5000, { origin: 'stop' }))).toBe('RISK_ORDER_MUST_SELL');
  });
});

describe('第 5 條：價格合法', () => {
  it('超出漲跌停或不符升降單位時拒絕並回報最近合法價', () => {
    expect(check(buy('0050', 100, 5505))).toBe('PRICE_OUT_OF_LIMIT');
    expect(check(buy('0050', 100, 4495))).toBe('PRICE_OUT_OF_LIMIT');
    try {
      checkOrder(env.db, buy('0050', 100, 5003), env.ctx);
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('PRICE_NOT_ON_TICK');
      expect((e as Error).message).toContain('50.00 或 50.05');
    }
  });

  it('沒有報價時拒絕', () => {
    env.quotes.remove('0050');
    expect(check(buy('0050', 100, 5000))).toBe('NO_QUOTE');
  });
});

describe('第 6 條：白名單', () => {
  it('不在白名單內拒絕，空白名單全部禁止', () => {
    env.config.symbols['2330'] = { name: '台積電', category: 'stock', leverage: 1 };
    env.quotes.set('2330', 100000);
    expect(check(buy('2330', 1, 100000))).toBe('SYMBOL_NOT_ALLOWED');
    setRiskParams(env.db, { symbols_allowlist: [] }, env.clock);
    expect(check(buy('0050', 100, 5000))).toBe('SYMBOL_NOT_ALLOWED');
  });
});

describe('第 7、8、13 條：金額、持股比例、總曝險', () => {
  it('單筆金額上限', () => {
    expect(check(buy('0050', 700, 5000))).toBe('ORDER_AMOUNT_EXCEEDED'); // 35000 > 30000
  });

  it('單一持股上限', () => {
    setRiskParams(env.db, { max_position_pct: 20 }, env.clock);
    expect(check(buy('0050', 400, 5000))).toBeUndefined(); // 20000 ≤ 20000
    expect(check(buy('0050', 420, 5000))).toBe('POSITION_LIMIT_EXCEEDED');
  });

  it('總曝險計入槓桿倍數與未完成買單', () => {
    setRiskParams(env.db, { max_exposure_pct: 100 }, env.clock);
    // 00631L 槓桿 2：19980 元 → 曝險 39960
    createOrder(env.db, buy('00631L', 999, 2000), env.ctx);
    createOrder(env.db, buy('0050', 500, 5000), env.ctx); // 再加 25000 → 64960
    expect(check(buy('0050', 600, 5000))).toBeUndefined(); // 再加 30000 → 94960 ≤ 100000
    expect(check(buy('00631L', 999, 2000))).toBe('EXPOSURE_LIMIT_EXCEEDED'); // 再加 39960 → 104920 > 100000
  });
});

describe('第 9、12 條：委託頻率', () => {
  it('每日委託次數上限', () => {
    setRiskParams(env.db, { max_orders_per_day: 2, max_orders_per_minute: 20 }, env.clock);
    createOrder(env.db, buy('0050', 10, 5000), env.ctx);
    createOrder(env.db, buy('0050', 10, 5000), env.ctx);
    expect(check(buy('0050', 10, 5000))).toBe('DAILY_ORDER_LIMIT');
  });

  it('每分鐘新單加刪單上限，一分鐘後恢復', () => {
    setRiskParams(env.db, { max_orders_per_minute: 2 }, env.clock);
    const o = createOrder(env.db, buy('0050', 10, 5000), env.ctx);
    requestCancel(env.db, o.id, env.clock);
    expect(check(buy('0050', 10, 5000))).toBe('RATE_LIMIT');
    env.clock.advanceMinutes(1.1);
    expect(check(buy('0050', 10, 5000))).toBeUndefined();
  });

  it('風險應對單不計入頻率限制', () => {
    setRiskParams(env.db, { max_orders_per_day: 1 }, env.clock);
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5000, actor: 'user' }, env.clock);
    createOrder(env.db, buy('0050', 10, 5000), env.ctx);
    expect(check(sell('0050', 100, 5000, { origin: 'stop' }))).toBeUndefined();
  });
});

describe('第 10 條：限制高頻進出', () => {
  it('賣出成交後冷卻期間不得再買進，但可以繼續賣', () => {
    const b = createOrder(env.db, buy('0050', 200, 5000), env.ctx);
    fillNow(b.id, 200, 5000);
    env.clock.advanceMinutes(5);
    const s = createOrder(env.db, sell('0050', 100, 5000), env.ctx);
    fillNow(s.id, 100, 5000);
    env.clock.advanceMinutes(10);
    expect(check(buy('0050', 100, 5000))).toBe('REENTRY_COOLDOWN');
    expect(check(sell('0050', 100, 5000))).toBeUndefined();
    env.clock.advanceMinutes(6);
    expect(check(buy('0050', 100, 5000))).toBeUndefined();
  });

  it('每日回合數上限', () => {
    setRiskParams(env.db, { max_round_trips_per_day: 1, reentry_cooldown_min: 0 }, env.clock);
    const b = createOrder(env.db, buy('0050', 100, 5000), env.ctx);
    fillNow(b.id, 100, 5000);
    const s = createOrder(env.db, sell('0050', 100, 5000), env.ctx);
    fillNow(s.id, 100, 5000);
    expect(check(buy('0050', 100, 5000))).toBe('ROUND_TRIP_LIMIT');
  });
});

describe('正反向標的', () => {
  it('持有正向時不得買進反向，可設定允許', () => {
    const b = createOrder(env.db, buy('0050', 100, 5000), env.ctx);
    fillNow(b.id, 100, 5000);
    expect(check(buy('00632R', 100, 1500))).toBe('OPPOSITE_POSITION');
    expect(check(buy('00631L', 100, 2000))).toBeUndefined();
    setRiskParams(env.db, { allow_opposite_positions: true }, env.clock);
    expect(check(buy('00632R', 100, 1500))).toBeUndefined();
  });

  it('掛單中的買單也算持有', () => {
    createOrder(env.db, buy('00632R', 100, 1500), env.ctx);
    expect(check(buy('0050', 100, 5000))).toBe('OPPOSITE_POSITION');
  });
});

describe('第 14、15 條：未確認委託與特殊狀態股票', () => {
  it('該代號有 unknown 委託時拒絕', () => {
    const o = createOrder(env.db, buy('0050', 100, 5000), env.ctx);
    markUnknown(env.db, o.id, env.clock);
    expect(check(buy('0050', 100, 5000))).toBe('UNKNOWN_ORDER_PENDING');
    expect(check(buy('00631L', 100, 2000))).toBeUndefined();
  });

  it('處置股、注意股、暫停交易拒絕', () => {
    env.quotes.set('0050', 5000, { is_disposition: true });
    expect(check(buy('0050', 100, 5000))).toBe('SPECIAL_STATUS');
    env.quotes.set('0050', 5000, { is_halted: true });
    expect(check(buy('0050', 100, 5000))).toBe('SPECIAL_STATUS');
  });
});

describe('原子性', () => {
  it('風控失敗時不寫入委託、不圈存', () => {
    expect(errorCode(() => createOrder(env.db, buy('0050', 700, 5000), env.ctx))).toBe('ORDER_AMOUNT_EXCEEDED');
    expect(env.db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(0);
  });
});
