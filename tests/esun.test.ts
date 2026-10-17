import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocate, getBalance, getPosition, transferIn } from '../core/ledger.js';
import type { MarketEvent } from '../core/marketdata.js';
import { createOrder, getOrder } from '../core/orders.js';
import type { OrderRequest } from '../core/risk.js';
import { type SecretProfile, type SecretStore, mask, readEsunIni, resolveMarketCredentials, validateCredentials } from '../core/secrets.js';
import { setRiskParams } from '../core/settings.js';
import { getPause } from '../core/state.js';
import {
  BrokerApiError,
  type BrokerHolding,
  type BrokerOrder,
  type MarketDataApi,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type TradeApi,
  type WsLike,
  toBrokerError,
} from '../daemon/esun/api.js';
import { EsunBroker } from '../daemon/esun/broker.js';
import { EsunMarketFeed } from '../daemon/esun/feed.js';
import { type TestEnv, buy, errorCode, makeEnv, sell } from './helpers.js';

// ---------------------------------------------------------------- 假的玉山交易 API

class FakeTradeApi implements TradeApi {
  placed: PlaceOrderInput[] = [];
  orders: BrokerOrder[] = [];
  holdings: BrokerHolding[] = [];
  cancelled: string[] = [];
  next: () => PlaceOrderResult = () => ({ ordNo: `A${this.placed.length}`, ordDate: '20261019', ordTime: '100000000', retCode: '000000', retMsg: '' });
  failGetOrders?: Error;

  async login() {}
  async placeOrder(input: PlaceOrderInput) {
    this.placed.push(input);
    const r = this.next();
    if (r.retCode === '000000') {
      this.orders.push(remote({ ordNo: r.ordNo, symbol: input.symbol, side: input.side, priceX100: input.priceX100, orgQty: input.apCode === '1' ? input.quantity * 1000 : input.quantity, memo: input.memo ?? '' }));
    }
    return r;
  }
  async getOrders() {
    if (this.failGetOrders) throw this.failGetOrders;
    return this.orders.map((o) => ({ ...o }));
  }
  async cancel(ordNo: string) {
    this.cancelled.push(ordNo);
    const o = this.orders.find((x) => x.ordNo === ordNo)!;
    o.celQty = o.orgQty - o.matQty;
  }
  async getHoldings() {
    return this.holdings;
  }
  async diagnostics() {
    return {};
  }
  onReport() {}
  connectStreamer() {}
}

const remote = (o: Partial<BrokerOrder>): BrokerOrder => ({
  ordNo: 'A1',
  symbol: '00632R',
  side: 'buy',
  apCode: '1',
  priceX100: 1500,
  orgQty: 1000,
  matQty: 0,
  celQty: 0,
  avgPriceX100: 0,
  errCode: '00000000',
  errMsg: '',
  ordDate: '20261019',
  ordTime: '100000000',
  memo: '',
  ...o,
});

let env: TestEnv;
let api: FakeTradeApi;
let broker: EsunBroker;
const at = (hhmm: string) => `2026-10-19T${hhmm}:00.000+08:00`;

beforeEach(() => {
  env = makeEnv(at('10:00'));
  env.config.mode = 'live';
  allocate(env.db, 100_000, 'user', undefined, env.clock);
  api = new FakeTradeApi();
  broker = new EsunBroker(env.db, env.config, env.clock, api, { log: () => {} });
});

const place = async (req: OrderRequest) => {
  const o = createOrder(env.db, req, env.ctx);
  return broker.submit(o.id);
};

describe('送單', () => {
  it('整股以張、零股以股送出，盤別與限價對應正確', async () => {
    await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    await place(buy('00632R', 300, 1499));
    expect(api.placed[0]).toMatchObject({ symbol: '00632R', side: 'buy', apCode: '1', quantity: 1, priceX100: 1500, trade: '0' });
    expect(api.placed[1]).toMatchObject({ apCode: '5', quantity: 300, priceX100: 1499 });
    expect(api.placed[0]?.memo).toMatch(/^CT\d+$/);
  });

  it('成功後記錄券商委託編號', async () => {
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    expect(o).toMatchObject({ status: 'submitted', broker_order_id: 'A1' });
  });

  it('券商回傳錯誤碼：rejected 並釋放圈存', async () => {
    api.next = () => ({ ordNo: '', ordDate: '', ordTime: '', retCode: '999999', retMsg: '額度不足' });
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    expect(o.status).toBe('rejected');
    expect(o.reject_reason).toContain('額度不足');
    expect(getBalance(env.db).reserved).toBe(0);
  });

  it('送出前就被擋下的錯誤（參數錯誤）：rejected', async () => {
    api.placeOrder = async () => {
      throw new Error('O00008 quantity must <= 499');
    };
    expect((await place(buy('00632R', 1000, 1500, { session: 'regular' }))).status).toBe('rejected');
  });

  it('結果不明（連線中斷）：unknown，不重送', async () => {
    api.placeOrder = async (input) => {
      api.placed.push(input);
      throw new Error('socket hang up');
    };
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    expect(o.status).toBe('unknown');
    expect(await broker.submit(o.id)).toMatchObject({ status: 'unknown' });
    expect(api.placed).toHaveLength(1);
  });

  it('賣出當日買進的部位以現股當沖賣（trade = A）送出', async () => {
    transferIn(env.db, { symbol: '00632R', qty: 1000, costPerShareX100: 1500, actor: 'user' }, env.clock);
    await place(sell('00632R', 1000, 1500, { session: 'regular' }));
    expect(api.placed[0]?.trade).toBe('0'); // 轉入的持股不是當日買進

    const b = await place(buy('00632R', 300, 1500));
    api.orders.find((x) => x.ordNo === b.broker_order_id)!.matQty = 300;
    api.orders.find((x) => x.ordNo === b.broker_order_id)!.avgPriceX100 = 1500;
    await broker.sync();
    env.clock.set(at('10:30'));
    await place(sell('00632R', 300, 1500));
    expect(api.placed.at(-1)?.trade).toBe('A');
  });
});

describe('同步', () => {
  it('依券商已成交股數與均價分次補寫成交', async () => {
    const o = await place(buy('00632R', 2000, 1500, { session: 'regular' }));
    const r = api.orders[0]!;
    r.matQty = 1000;
    r.avgPriceX100 = 1495;
    await broker.sync();
    expect(getOrder(env.db, o.id)).toMatchObject({ status: 'partial', filled_qty: 1000 });

    r.matQty = 2000;
    r.avgPriceX100 = 1497; // 第二批均價 14.99
    await broker.sync();
    expect(getOrder(env.db, o.id)).toMatchObject({ status: 'filled', filled_qty: 2000 });
    expect(env.db.prepare('SELECT price_x100 FROM fills ORDER BY id').pluck().all()).toEqual([1495, 1499]);
    expect(getPosition(env.db, '00632R').qty).toBe(2000);

    await broker.sync(); // 重複同步不重複入帳
    expect(env.db.prepare('SELECT COUNT(*) FROM fills').pluck().get()).toBe(2);
  });

  it('券商刪單後標為 cancelled，部分成交保留', async () => {
    const o = await place(buy('00632R', 2000, 1500, { session: 'regular' }));
    api.orders[0]!.matQty = 1000;
    api.orders[0]!.avgPriceX100 = 1500;
    const c = await broker.cancel(o.id);
    expect(api.cancelled).toEqual(['A1']);
    expect(c).toMatchObject({ status: 'cancelled', filled_qty: 1000 });
    expect(getBalance(env.db).reserved).toBe(0);
  });

  it('券商端錯誤碼且未成交：rejected', async () => {
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    api.orders[0]!.errCode = 'E1234';
    api.orders[0]!.errMsg = '價格超過漲跌停';
    await broker.sync();
    expect(getOrder(env.db, o.id).status).toBe('rejected');
  });

  it('unknown 委託以自訂欄位在券商找到後恢復追蹤', async () => {
    api.placeOrder = async (input) => {
      api.placed.push(input);
      api.orders.push(remote({ ordNo: 'B7', priceX100: input.priceX100, orgQty: 1000, memo: input.memo! }));
      throw new Error('timeout');
    };
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    expect(o.status).toBe('unknown');
    await broker.sync();
    expect(getOrder(env.db, o.id)).toMatchObject({ status: 'submitted', broker_order_id: 'B7' });
  });

  it('unknown 委託在券商查無資料超過一分鐘：確認未送出', async () => {
    api.placeOrder = async () => {
      throw new Error('ECONNRESET');
    };
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    await broker.sync();
    expect(getOrder(env.db, o.id).status).toBe('unknown');
    env.clock.advanceMinutes(1.1);
    await broker.sync();
    expect(getOrder(env.db, o.id)).toMatchObject({ status: 'rejected', reject_reason: '券商查無此委託，確認未送出' });
  });

  it('多筆條件相同的委託無法確定時保持 unknown', async () => {
    api.orders.push(remote({ ordNo: 'X1' }), remote({ ordNo: 'X2' }));
    api.placeOrder = async () => {
      throw new Error('timeout');
    };
    const o = await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    await broker.sync();
    expect(getOrder(env.db, o.id).status).toBe('unknown');
  });
});

describe('停機條件', () => {
  it('無法重試的券商錯誤（IP 白名單）立即暫停', async () => {
    api.placeOrder = async () => {
      throw new Error('AGA0002 Invalid IP');
    };
    await place(buy('00632R', 1000, 1500, { session: 'regular' }));
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'broker_api' });
  });

  it('API 連續失敗達門檻時暫停', async () => {
    setRiskParams(env.db, { max_api_failures: 2 }, env.clock);
    api.failGetOrders = new Error('ETIMEDOUT');
    await expect(broker.sync()).rejects.toThrow();
    expect(getPause(env.db).paused).toBe(false);
    await expect(broker.sync()).rejects.toThrow();
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'broker_api' });
  });

  it('委託連續被拒達門檻時暫停，成功送單會歸零', async () => {
    setRiskParams(env.db, { max_broker_rejects: 2, max_orders_per_minute: 20 }, env.clock);
    api.next = () => ({ ordNo: '', ordDate: '', ordTime: '', retCode: '1', retMsg: 'x' });
    await place(buy('00632R', 100, 1500));
    api.next = () => ({ ordNo: 'OK1', ordDate: '', ordTime: '', retCode: '000000', retMsg: '' });
    await place(buy('00632R', 100, 1500));
    api.next = () => ({ ordNo: '', ordDate: '', ordTime: '', retCode: '1', retMsg: 'x' });
    await place(buy('00632R', 100, 1500));
    expect(getPause(env.db).paused).toBe(false);
    await place(buy('00632R', 100, 1500));
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'broker_rejects' });
  });

  it('券商持股少於帳本持股時暫停', async () => {
    transferIn(env.db, { symbol: '0050', qty: 500, costPerShareX100: 5000, actor: 'user' }, env.clock);
    api.holdings = [{ symbol: '0050', qty: 400 }];
    const r = await broker.checkHoldings('test');
    expect(r.ok).toBe(false);
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'reconciliation' });
  });

  it('券商持股足夠時不暫停（使用者自己的持股也算在內）', async () => {
    transferIn(env.db, { symbol: '0050', qty: 500, costPerShareX100: 5000, actor: 'user' }, env.clock);
    api.holdings = [{ symbol: '0050', qty: 30_000 }];
    expect((await broker.checkHoldings('test')).ok).toBe(true);
  });
});

describe('錯誤分類', () => {
  it('從 SDK 訊息取出券商錯誤碼', () => {
    expect(toBrokerError(new Error('AGA0002 Invalid IP'), '下單')).toMatchObject({ brokerCode: 'AGA0002', definitelyNotSent: true, fatal: true });
    expect(toBrokerError(new Error('AGR0002 Exceed'), '下單')).toMatchObject({ definitelyNotSent: true, fatal: false });
    expect(toBrokerError(new Error('socket hang up'), '下單')).toMatchObject({ brokerCode: undefined, definitelyNotSent: false });
    expect(new BrokerApiError('C00005', 'x', true).fatal).toBe(true);
  });
});

// ---------------------------------------------------------------- 行情

class FakeWs implements WsLike {
  handlers = new Map<string, (d: any) => void>();
  subs: Record<string, unknown>[] = [];
  on(event: string, cb: (d: any) => void) {
    this.handlers.set(event, cb);
    return this;
  }
  async connect() {
    return {};
  }
  disconnect() {}
  subscribe(p: Record<string, unknown>) {
    this.subs.push(p);
  }
}

class FakeMarketApi implements MarketDataApi {
  sockets: FakeWs[] = [];
  async login() {}
  async ticker(symbol: string) {
    return { date: '2026-10-19', symbol, referencePrice: 15, previousClose: 15, limitUpPrice: 16.5, limitDownPrice: 13.5, boardLot: 1000, isAttention: false, isDisposition: true, securityStatus: 'NORMAL' };
  }
  async quote(_symbol: string, oddlot: boolean) {
    return oddlot
      ? { bids: [{ price: 14.98, size: 300 }], asks: [{ price: 15.0, size: 120 }], lastTrade: { price: 14.99 }, lastUpdated: 1_792_380_000_000_000 }
      : { bids: [{ price: 14.98, size: 20 }], asks: [{ price: 14.99, size: 15 }], lastTrade: { price: 14.99 }, lastUpdated: 1_792_380_000_000_000 };
  }
  async intradayCandles() {
    return { data: [1, 2, 3].map((i) => ({ date: `2026-10-16T09:0${i}:00.000+08:00`, open: i, close: i, average: i })) };
  }
  async historicalCandles() {
    return { data: [{ date: '2026-10-16' }, { date: '2026-10-15' }] };
  }
  websocket() {
    const ws = new FakeWs();
    this.sockets.push(ws);
    return ws;
  }
}

describe('玉山行情來源', () => {
  let mdApi: FakeMarketApi;
  let feed: EsunMarketFeed;
  let events: MarketEvent[];

  beforeEach(async () => {
    mdApi = new FakeMarketApi();
    feed = new EsunMarketFeed(mdApi, { log: () => {}, clock: env.clock });
    events = [];
    await feed.start((e) => events.push(e));
    await feed.subscribe(['00632R']);
  });

  afterEach(async () => {
    await feed.stop();
  });

  it('啟動時送出 ticker 與初始五檔，整股數量換成股', () => {
    expect(events[0]).toMatchObject({ type: 'ticker', symbol: '00632R', limit_up_x100: 1650, limit_down_x100: 1350, is_disposition: true });
    const book = events.find((e) => e.type === 'book' && e.board === 'regular');
    expect(book).toMatchObject({ bids: [{ price_x100: 1498, size: 20_000 }], asks: [{ price_x100: 1499, size: 15_000 }] });
    const odd = events.find((e) => e.type === 'book' && e.board === 'odd');
    expect(odd).toMatchObject({ bids: [{ price_x100: 1498, size: 300 }] });
    // 初始最後成交只更新報價，成交量為 0
    expect(events.find((e) => e.type === 'trade')).toMatchObject({ price_x100: 1499, volume: 0 });
  });

  it('兩條 WebSocket：整股與盤中零股，各訂閱 trades 與 books', () => {
    expect(mdApi.sockets).toHaveLength(2);
    expect(mdApi.sockets[0]?.subs).toEqual([
      { channel: 'trades', symbols: ['00632R'] },
      { channel: 'books', symbols: ['00632R'] },
    ]);
    expect(mdApi.sockets[1]?.subs[0]).toEqual({ channel: 'trades', symbols: ['00632R'], intradayOddLot: true });
  });

  it('成交訊息：整股張換股、零股不換、略過試撮、標示開收盤競價', () => {
    events.length = 0;
    const msg = (data: object) => JSON.stringify({ event: 'data', channel: 'trades', data: { symbol: '00632R', time: 1_792_380_000_000_000, ...data } });
    feed.handleMessage('regular', msg({ price: 15.01, size: 3 }));
    feed.handleMessage('odd', msg({ price: 15.02, size: 250 }));
    feed.handleMessage('regular', msg({ price: 15.03, size: 9, isTrial: true }));
    feed.handleMessage('regular', msg({ price: 15.0, size: 500, isOpen: true }));
    feed.handleMessage('regular', JSON.stringify({ event: 'subscribed', data: {} }));
    expect(events).toMatchObject([
      { type: 'trade', board: 'regular', price_x100: 1501, volume: 3000 },
      { type: 'trade', board: 'odd', price_x100: 1502, volume: 250 },
      { type: 'trade', board: 'regular', price_x100: 1500, volume: 500_000, auction: 'open' },
    ]);
    expect(events[0]?.ts).toMatch(/\+08:00$/);
  });

  it('K 線：分 K 走日內、日 K 走歷史並依日期排序', async () => {
    const bars = (await feed.candles('00632R', '5m', 2)) as { date: string; average: number }[];
    expect(bars).toEqual([
      { date: '2026-10-16T09:02:00.000+08:00', open: 2, close: 2, average: 2 },
      { date: '2026-10-16T09:03:00.000+08:00', open: 3, close: 3, average: 3 },
    ]);
    const daily = (await feed.candles('00632R', 'D', 5)) as { date: string }[];
    expect(daily.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16']);
    await expect(feed.candles('00632R', 'W', 5)).rejects.toThrow(/不支援/);
  });
});

// ---------------------------------------------------------------- 金鑰

describe('金鑰設定檔', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctrade-ini-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('讀取玉山金鑰設定檔，忽略範本的註解佔位路徑', () => {
    const ini = join(dir, 'config.ini');
    writeFileSync(
      ini,
      '[Core]\r\nEntry = https://esuntradingapi-simulation.esunsec.com.tw/api/v1\r\nEnvironment = SIMULATION\r\n\r\n[Cert]\r\nPath = ;Your Cert File Path Ex: ./python/cert.p12\r\n\r\n[Api]\r\nKey = K1\r\nSecret = S1\r\n\r\n[User]\r\nAccount = 123\r\n',
    );
    expect(readEsunIni(ini)).toEqual({
      apiUrl: 'https://esuntradingapi-simulation.esunsec.com.tw/api/v1',
      apiKey: 'K1',
      apiSecret: 'S1',
      aid: '123',
      environment: 'SIMULATION',
      certPath: undefined,
    });
  });

  it('驗證必要欄位、https 與憑證檔', () => {
    const cert = join(dir, 'a.p12');
    writeFileSync(cert, 'x');
    const base = { apiUrl: 'https://x', apiKey: 'k', apiSecret: 's', aid: 'a', password: 'p', certPass: 'c', certPath: cert };
    expect(() => validateCredentials(base)).not.toThrow();
    expect(errorCode(() => validateCredentials({ ...base, password: '' }))).toBe('CREDENTIALS_INCOMPLETE');
    expect(errorCode(() => validateCredentials({ ...base, apiUrl: 'http://x' }))).toBe('CREDENTIALS_INVALID');
    expect(errorCode(() => validateCredentials({ ...base, certPath: 'rel.p12' }))).toBe('CREDENTIALS_INVALID');
  });

  it('行情金鑰優先用 esun-marketdata，沒有時改用 esun-live，都沒有回 undefined', async () => {
    const creds = (url: string) => ({ apiUrl: url, apiKey: 'k', apiSecret: 's', aid: 'a', password: 'p', certPass: 'c', certPath: '/x.p12' });
    const store = (entries: Partial<Record<SecretProfile, ReturnType<typeof creds>>>): SecretStore => ({
      get: async (p) => entries[p],
      set: async () => {},
      delete: async () => true,
    });
    expect((await resolveMarketCredentials(store({ 'esun-marketdata': creds('https://md'), 'esun-live': creds('https://live') })))?.profile).toBe(
      'esun-marketdata',
    );
    expect((await resolveMarketCredentials(store({ 'esun-live': creds('https://live'), 'esun-sim': creds('https://sim') })))?.profile).toBe('esun-live');
    // 模擬金鑰不拿來接行情
    expect(await resolveMarketCredentials(store({ 'esun-sim': creds('https://sim') }))).toBeUndefined();
  });

  it('遮罩只露頭尾', () => {
    expect(mask('CC78A0F4D37A4843')).toBe('CC7********843');
    expect(mask('abc')).toBe('***');
  });
});
