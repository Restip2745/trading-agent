import { createRequire } from 'node:module';
import { CtradeError, ExitCode } from '../../core/errors.js';
import type { EsunCredentials } from '../../core/secrets.js';

/**
 * 玉山 Node.js SDK 的包裝層（見 doc/broker-api-notes.md）。
 *
 * 轉接層與行情來源只依賴這裡定義的窄介面，測試時以假實作取代。
 * 這一層負責：把 SDK 的回應統一成「股」與「分」、把 SDK 例外轉成帶券商錯誤碼的 BrokerApiError。
 */

// ---------------------------------------------------------------- 錯誤

/** 確定無效、重試也不會成功的錯誤：白名單、密碼、憑證、金鑰。 */
const FATAL_CODES = ['AGA0000', 'AGA0002', 'AGA0003', 'AGA0006', 'AGA0007', 'AGA0008', 'AGA0010', 'AGA0011', 'AGA0012', 'C00001', 'C00002', 'C00003', 'C00005', 'AG00001', 'A00003'];

export class BrokerApiError extends CtradeError {
  constructor(
    readonly brokerCode: string | undefined,
    message: string,
    /** 確定沒有送達券商（參數錯誤、被券商拒絕），可以安全地標為 rejected */
    readonly definitelyNotSent: boolean,
  ) {
    super('BROKER_API_ERROR', message, ExitCode.BROKER_ERROR, { broker_code: brokerCode });
  }

  get fatal(): boolean {
    return this.brokerCode !== undefined && FATAL_CODES.includes(this.brokerCode);
  }
}

export function toBrokerError(e: unknown, context: string): BrokerApiError {
  if (e instanceof BrokerApiError) return e;
  const msg = (e as Error)?.message ?? String(e);
  const code = /\b(AG[A-Z]?\d{4,5}|AW[A-Z]?\d{4,5}|[CAO]\d{5})\b/.exec(msg)?.[1];
  // 參數錯誤（O*、AG00000、AW*）在送出前就被擋下；速率限制（AGR*）是券商明確拒絕
  const notSent = !!code && (/^O\d/.test(code) || code === 'AG00000' || code.startsWith('AW') || code.startsWith('AGR') || FATAL_CODES.includes(code));
  return new BrokerApiError(code, `${context}：${msg}`, notSent);
}

// ---------------------------------------------------------------- 交易

export type ApCode = '1' | '2' | '3' | '5';

export interface PlaceOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  apCode: ApCode;
  /** 限價（分） */
  priceX100: number;
  /** 券商單位：整股為張、零股為股 */
  quantity: number;
  /** '0' 現股、'A' 現股當沖賣 */
  trade: '0' | 'A';
  memo?: string;
}

export interface PlaceOrderResult {
  ordNo: string;
  ordDate: string;
  ordTime: string;
  retCode: string;
  retMsg: string;
}

/** 券商當日委託，數量一律為股、價格為分。 */
export interface BrokerOrder {
  ordNo: string;
  symbol: string;
  side: 'buy' | 'sell';
  apCode: string;
  priceX100: number;
  orgQty: number;
  matQty: number;
  celQty: number;
  avgPriceX100: number;
  errCode: string;
  errMsg: string;
  ordDate: string;
  ordTime: string;
  memo: string;
}

export interface BrokerHolding {
  symbol: string;
  /** 目前庫存股數 = 昨餘額 + 今買成交 − 今賣成交 + 調整（待正式環境驗證） */
  qty: number;
}

export interface TradeApi {
  login(): Promise<void>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  getOrders(): Promise<BrokerOrder[]>;
  cancel(ordNo: string): Promise<void>;
  getHoldings(): Promise<BrokerHolding[]>;
  /** 唯讀檢查用的原始資料 */
  diagnostics(): Promise<Record<string, unknown>>;
  /** 主動回報（委託或成交）到達時呼叫 */
  onReport(cb: (kind: 'order' | 'trade', raw: unknown) => void): void;
  connectStreamer(): void;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toX100 = (v: unknown) => Math.round(num(v) * 100);

interface SdkPlacedOrder {
  payload: Record<string, unknown>;
}

interface SdkTrade {
  login(): Promise<void>;
  placeOrder(order: unknown): Promise<PlaceOrderResult>;
  getOrders(): Promise<SdkPlacedOrder[]>;
  cancelOrder(order: SdkPlacedOrder): Promise<unknown>;
  getInventories(): Promise<Record<string, unknown>[]>;
  getKeyInfo(): Promise<unknown>;
  getCertInfo(): Promise<unknown>;
  getTradeStatus(): Promise<unknown>;
  getMarketStatus(): Promise<unknown>;
  getMachineTime(): Promise<unknown>;
  streamer?: { on(event: string, cb: (data: unknown) => void): void; connect(): void };
}

const load = createRequire(import.meta.url);

export class EsunTradeApi implements TradeApi {
  private readonly sdk: SdkTrade;
  private readonly OrderCtor: new (payload: Record<string, unknown>) => unknown;
  private reportCb?: (kind: 'order' | 'trade', raw: unknown) => void;

  constructor(creds: EsunCredentials) {
    const mod = load('@esun/trade') as { EsunTrade: new (o: unknown) => SdkTrade; Order: new (p: Record<string, unknown>) => unknown };
    // 同時提供 password 與 certPass 時，SDK 直接建立連線，不會跳出互動式詢問
    this.sdk = new mod.EsunTrade({ config: { ...creds } });
    this.OrderCtor = mod.Order;
  }

  private async call<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toBrokerError(e, context);
    }
  }

  login() {
    return this.call('登入', () => this.sdk.login());
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const order = new this.OrderCtor({
      stockNo: input.symbol,
      buySell: input.side === 'buy' ? 'B' : 'S',
      price: input.priceX100 / 100,
      quantity: input.quantity,
      apCode: input.apCode,
      priceFlag: '0', // 限價
      bsFlag: 'R', // ROD
      trade: input.trade,
      userDef: input.memo,
    });
    return this.call('下單', () => this.sdk.placeOrder(order));
  }

  async getOrders(): Promise<BrokerOrder[]> {
    const list = await this.call('查詢委託', () => this.sdk.getOrders());
    return list.map(({ payload: p }) => ({
      ordNo: String(p.ordNo ?? ''),
      symbol: String(p.stockNo ?? ''),
      side: p.buySell === 'S' ? 'sell' : 'buy',
      apCode: String(p.apCode ?? ''),
      priceX100: toX100(p.odPrice),
      orgQty: num(p.orgQtyShare),
      matQty: num(p.matQtyShare),
      celQty: num(p.celQtyShare),
      avgPriceX100: toX100(p.avgPrice),
      errCode: String(p.errCode ?? ''),
      errMsg: String(p.errMsg ?? ''),
      ordDate: String(p.ordDate ?? ''),
      ordTime: String(p.ordTime ?? ''),
      memo: String(p.userDef ?? ''),
    }));
  }

  async cancel(ordNo: string): Promise<void> {
    const list = await this.call('查詢委託', () => this.sdk.getOrders());
    const target = list.find((o) => String(o.payload.ordNo) === ordNo);
    if (!target) throw new BrokerApiError('AG00003', `刪單：券商查無委託 ${ordNo}`, false);
    await this.call('刪單', () => this.sdk.cancelOrder(target));
  }

  async getHoldings(): Promise<BrokerHolding[]> {
    const list = await this.call('查詢庫存', () => this.sdk.getInventories());
    return list.map((s) => ({
      symbol: String(s.stkNo ?? ''),
      qty: num(s.qtyL) + num(s.qtyBm) - num(s.qtySm) + num(s.qtyC),
    }));
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const safe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        return [name, await fn()] as const;
      } catch (e) {
        return [name, { error: toBrokerError(e, name).message }] as const;
      }
    };
    const results = await Promise.all([
      safe('key_info', () => this.sdk.getKeyInfo()),
      safe('cert_info', () => this.sdk.getCertInfo()),
      safe('trade_status', () => this.sdk.getTradeStatus()),
      safe('market_status', () => this.sdk.getMarketStatus()),
      safe('machine_time', () => this.sdk.getMachineTime()),
    ]);
    return Object.fromEntries(results);
  }

  onReport(cb: (kind: 'order' | 'trade', raw: unknown) => void): void {
    this.reportCb = cb;
  }

  connectStreamer(): void {
    const s = this.sdk.streamer;
    if (!s) return;
    s.on('order', (d) => this.reportCb?.('order', d));
    s.on('trade', (d) => this.reportCb?.('trade', d));
    s.on('error', () => {});
    s.connect();
  }
}

// ---------------------------------------------------------------- 行情

export interface WsLike {
  on(event: string, cb: (data: any) => void): unknown;
  connect(): Promise<unknown>;
  disconnect(): void;
  subscribe(params: Record<string, unknown>): void;
}

export interface MarketDataApi {
  login(): Promise<void>;
  ticker(symbol: string): Promise<Record<string, any>>;
  quote(symbol: string, oddlot: boolean): Promise<Record<string, any>>;
  intradayCandles(symbol: string, timeframe: string): Promise<Record<string, any>>;
  /** timeframe：D 日 K（預設）、5 為 5 分 K 等；單次跨度須小於一年 */
  historicalCandles(symbol: string, from: string, to: string, timeframe?: string): Promise<Record<string, any>>;
  /** 每次呼叫建立一條新的 WebSocket（上限 2 條：整股一條、零股一條） */
  websocket(): WsLike;
}

interface SdkMarketdata {
  login(): Promise<void>;
  restClient: { stock: any };
  websocketClient: { stock: WsLike };
}

/** 行情 REST 的 4xx 是以一般回應回傳 {statusCode, message}，不會丟例外（evalis 實測）。 */
function checkPayload<T extends Record<string, any>>(payload: T, context: string): T {
  if (payload && typeof payload.statusCode === 'number' && payload.statusCode >= 400) {
    throw new BrokerApiError(`HTTP${payload.statusCode}`, `${context}：HTTP ${payload.statusCode} ${payload.message ?? ''}`, true);
  }
  return payload;
}

export class EsunMarketDataApi implements MarketDataApi {
  private readonly sdk: SdkMarketdata;

  constructor(creds: EsunCredentials) {
    const mod = load('@esun/marketdata') as { EsunMarketdata: new (o: unknown) => SdkMarketdata };
    this.sdk = new mod.EsunMarketdata({ config: { ...creds } });
  }

  async login(): Promise<void> {
    try {
      await this.sdk.login();
    } catch (e) {
      throw toBrokerError(e, '行情登入');
    }
  }

  private get rest() {
    return this.sdk.restClient.stock;
  }

  async ticker(symbol: string) {
    return checkPayload(await this.rest.intraday.ticker({ symbol }), `ticker ${symbol}`);
  }

  async quote(symbol: string, oddlot: boolean) {
    return checkPayload(await this.rest.intraday.quote(oddlot ? { symbol, type: 'oddlot' } : { symbol }), `quote ${symbol}`);
  }

  async intradayCandles(symbol: string, timeframe: string) {
    return checkPayload(await this.rest.intraday.candles({ symbol, timeframe }), `candles ${symbol}`);
  }

  async historicalCandles(symbol: string, from: string, to: string, timeframe = 'D') {
    // from 是保留字，只能用物件傳入（evalis 實測）；非交易日區段回 404，視為沒有資料
    const r = await this.rest.historical.candles({ symbol, from, to, timeframe });
    if (r && r.statusCode === 404) return { data: [] };
    return checkPayload(r, `historical ${symbol}`);
  }

  websocket(): WsLike {
    // websocketClient 每次取用都建立新的工廠與連線
    return this.sdk.websocketClient.stock;
  }
}
