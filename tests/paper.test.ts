import { beforeEach, describe, expect, it } from 'vitest';
import { allocate, getBalance, getPosition, transferIn } from '../core/ledger.js';
import { type Board, type Level, QuoteCache } from '../core/marketdata.js';
import { createOrder, getOrder, markSubmitted } from '../core/orders.js';
import { PaperMatcher } from '../core/paper.js';
import type { OrderRequest } from '../core/risk.js';
import { checkLedgerConsistency } from '../core/reconcile.js';
import { type TestEnv, buy, makeEnv, sell } from './helpers.js';

/**
 * 模擬撮合規則（規格第 7 節）。標的用 00632R（15 元附近，升降單位 0.01），
 * 讓整股委託金額落在單筆上限 30000 元內。
 */

let env: TestEnv;
let cache: QuoteCache;
let matcher: PaperMatcher;

const S = '00632R';
const at = (hhmm: string) => `2026-10-19T${hhmm}:00.000+08:00`;

function setup(opts: { fillAtTouch?: boolean; share?: number } = {}) {
  cache = new QuoteCache();
  matcher = new PaperMatcher(env.db, env.config, env.clock, (s, b) => cache.book(s, b), {
    fillAtTouch: opts.fillAtTouch ?? false,
    maxVolumeSharePct: opts.share ?? 20,
  });
}

beforeEach(() => {
  env = makeEnv(at('10:00'));
  allocate(env.db, 100_000, 'user', undefined, env.clock);
  setup();
});

function submit(req: OrderRequest) {
  const o = createOrder(env.db, req, env.ctx);
  markSubmitted(env.db, o.id, `P${o.id}`, env.clock);
  const fills = matcher.onSubmitted(o.id);
  return { id: o.id, fills };
}

function book(board: Board, bids: Level[], asks: Level[]) {
  cache.apply({ type: 'book', symbol: S, board, ts: env.clock.now().toISOString(), bids, asks });
}

function trade(board: Board, priceX100: number, volume: number, auction?: 'open' | 'close') {
  return matcher.onEvent({ type: 'trade', symbol: S, board, ts: env.clock.now().toISOString(), price_x100: priceX100, volume, auction });
}

const lv = (price_x100: number, size: number): Level => ({ price_x100, size });

describe('整股：送出時即可成交的限價單', () => {
  it('以最佳賣價成交，數量不超過該檔賣量，剩餘轉為掛單', () => {
    book('regular', [lv(1494, 5000)], [lv(1495, 1000), lv(1496, 5000)]);
    const { id, fills } = submit(buy(S, 2000, 1500, { session: 'regular' }));
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ fee: 21 });
    expect(getOrder(env.db, id)).toMatchObject({ status: 'partial', filled_qty: 1000 });
    expect(env.db.prepare('SELECT price_x100 FROM fills').pluck().get()).toBe(1495);
  });

  it('限價低於最佳賣價時不成交，轉為掛單', () => {
    book('regular', [lv(1494, 5000)], [lv(1495, 1000)]);
    const { id, fills } = submit(buy(S, 1000, 1494, { session: 'regular' }));
    expect(fills).toEqual([]);
    expect(getOrder(env.db, id).status).toBe('submitted');
  });

  it('賣單以最佳買價成交', () => {
    transferIn(env.db, { symbol: S, qty: 2000, costPerShareX100: 1500, actor: 'user' }, env.clock);
    book('regular', [lv(1499, 3000)], [lv(1500, 1000)]);
    const { fills } = submit(sell(S, 2000, 1498, { session: 'regular' }));
    expect(fills[0]?.order).toMatchObject({ status: 'filled', filled_qty: 2000 });
    expect(env.db.prepare('SELECT price_x100 FROM fills').pluck().get()).toBe(1499);
  });

  it('集合競價時段（開盤前）不立即成交', () => {
    env.clock.set(at('08:45'));
    book('regular', [lv(1494, 5000)], [lv(1495, 5000)]);
    const { fills } = submit(buy(S, 1000, 1500, { session: 'regular' }));
    expect(fills).toEqual([]);
  });
});

describe('整股：掛單', () => {
  it('成交價嚴格穿越限價才成交，成交價為限價', () => {
    const { id } = submit(buy(S, 2000, 1500, { session: 'regular' }));
    expect(trade('regular', 1500, 50_000)).toEqual([]); // 剛好等於限價
    const r = trade('regular', 1499, 50_000);
    expect(r).toHaveLength(1);
    expect(getOrder(env.db, id)).toMatchObject({ status: 'filled', filled_qty: 2000 });
    expect(env.db.prepare('SELECT price_x100 FROM fills').pluck().get()).toBe(1500);
  });

  it('fill_at_touch 時等於限價也成交', () => {
    setup({ fillAtTouch: true });
    submit(buy(S, 1000, 1500, { session: 'regular' }));
    expect(trade('regular', 1500, 50_000)).toHaveLength(1);
  });

  it('賣單掛單：成交價高於限價才成交', () => {
    transferIn(env.db, { symbol: S, qty: 1000, costPerShareX100: 1500, actor: 'user' }, env.clock);
    submit(sell(S, 1000, 1510, { session: 'regular' }));
    expect(trade('regular', 1510, 50_000)).toEqual([]);
    expect(trade('regular', 1511, 50_000)).toHaveLength(1);
  });

  it('每筆成交量最多分給模擬單 20%，整股以張為單位', () => {
    const { id } = submit(buy(S, 2000, 1500, { session: 'regular' }));
    expect(trade('regular', 1499, 4000)).toEqual([]); // 800 股 → 不足一張
    trade('regular', 1499, 5000); // 1000 股
    expect(getOrder(env.db, id)).toMatchObject({ status: 'partial', filled_qty: 1000 });
    trade('regular', 1498, 100_000);
    expect(getOrder(env.db, id)).toMatchObject({ status: 'filled', filled_qty: 2000 });
  });

  it('成交量依限價優先分配給模擬單', () => {
    const low = submit(buy(S, 1000, 1500, { session: 'regular' })).id;
    const high = submit(buy(S, 1000, 1502, { session: 'regular' })).id;
    trade('regular', 1499, 5000); // 只夠一張
    expect(getOrder(env.db, high).filled_qty).toBe(1000);
    expect(getOrder(env.db, low).filled_qty).toBe(0);
  });

  it('委託送出前的成交不能拿來撮合', () => {
    const { id } = submit(buy(S, 1000, 1500, { session: 'regular' }));
    matcher.onEvent({ type: 'trade', symbol: S, board: 'regular', ts: at('09:30'), price_x100: 1490, volume: 100_000 });
    expect(getOrder(env.db, id).filled_qty).toBe(0);
  });
});

describe('整股：集合競價', () => {
  it('限價優於或等於撮合價即成交，成交價為撮合價', () => {
    env.clock.set(at('08:50'));
    const a = submit(buy(S, 1000, 1500, { session: 'regular' })).id;
    const b = submit(buy(S, 1000, 1497, { session: 'regular' })).id;
    env.clock.set(at('09:00'));
    trade('regular', 1497, 100_000, 'open');
    expect(getOrder(env.db, a).status).toBe('filled');
    expect(getOrder(env.db, b).status).toBe('filled'); // 等於撮合價也成交
    expect(env.db.prepare('SELECT DISTINCT price_x100 FROM fills').pluck().all()).toEqual([1497]);
  });

  it('限價劣於撮合價不成交', () => {
    env.clock.set(at('13:26'));
    const { id } = submit(buy(S, 1000, 1495, { session: 'regular' }));
    env.clock.set(at('13:30'));
    trade('regular', 1496, 100_000, 'close');
    expect(getOrder(env.db, id).filled_qty).toBe(0);
  });
});

describe('零股', () => {
  it('盤中零股：每次撮合以零股撮合價判斷，等於限價也成交', () => {
    const { id } = submit(buy(S, 500, 1500));
    expect(trade('odd', 1501, 10_000)).toEqual([]);
    trade('odd', 1500, 3000); // 20% = 600 股
    expect(getOrder(env.db, id)).toMatchObject({ status: 'filled', filled_qty: 500 });
    expect(env.db.prepare('SELECT price_x100 FROM fills').pluck().get()).toBe(1500);
  });

  it('盤中零股不吃整股的成交', () => {
    const { id } = submit(buy(S, 500, 1500));
    trade('regular', 1490, 100_000);
    expect(getOrder(env.db, id).filled_qty).toBe(0);
  });

  it('盤後零股只在盤後撮合成交，成交價為撮合價', () => {
    env.clock.set(at('14:00'));
    const { id } = submit(buy(S, 100, 1500, { session: 'odd_after' }));
    trade('odd', 1490, 10_000);
    expect(getOrder(env.db, id).filled_qty).toBe(0);
    env.clock.set(at('14:30'));
    trade('odd_after', 1498, 1000);
    expect(getOrder(env.db, id)).toMatchObject({ status: 'filled', filled_qty: 100 });
    expect(env.db.prepare('SELECT price_x100 FROM fills').pluck().get()).toBe(1498);
  });

  it('數量上限可能分多次部分成交', () => {
    const { id } = submit(buy(S, 900, 1500));
    trade('odd', 1500, 2000); // 400
    expect(getOrder(env.db, id).filled_qty).toBe(400);
    trade('odd', 1500, 2000); // 400
    trade('odd', 1500, 2000); // 剩 100
    expect(getOrder(env.db, id)).toMatchObject({ status: 'filled', filled_qty: 900 });
  });
});

describe('帳本一致', () => {
  it('撮合後帳本一致，圈存全部釋放', () => {
    book('regular', [lv(1494, 5000)], [lv(1495, 1000)]);
    submit(buy(S, 2000, 1500, { session: 'regular' }));
    trade('regular', 1499, 50_000);
    expect(getPosition(env.db, S).qty).toBe(2000);
    expect(getBalance(env.db).reserved).toBe(0);
    expect(checkLedgerConsistency(env.db)).toEqual([]);
  });
});
