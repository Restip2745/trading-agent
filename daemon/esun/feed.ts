import type { Board, BookEvent, Level, MarketEvent, TickerEvent, TradeEvent } from '../../core/marketdata.js';
import { type Clock, addDays, toTwIso, twDate } from '../../core/time.js';
import type { MarketFeed } from '../feeds.js';
import type { MarketDataApi, WsLike } from './api.js';

/**
 * 玉山行情來源（規格第 14 節、doc/broker-api-notes.md）。
 *
 *   - REST ticker：參考價、漲跌停、注意／處置／暫停交易；每天更新，日期不是今天就重抓。
 *   - REST quote：啟動與重連時的初始五檔與最後成交。
 *   - WebSocket：兩條連線（上限 2），一條整股、一條盤中零股，各訂閱 trades 與 books。
 *
 * 單位換算：整股的數量是「張」，乘以交易單位（boardLot，通常 1000）換成股；零股本來就是股。
 * 時間戳是微秒 epoch。試撮（isTrial）不是真實成交，不送出。
 * 盤後零股沒有即時推播：paper 模式的盤後零股委託不會成交，live 模式由券商回報。
 */

const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const TICKER_CHECK_MS = 5 * 60_000;

const microsToIso = (us: unknown) => toTwIso(new Date(Number(us) / 1000));
const x100 = (v: unknown) => Math.round(Number(v) * 100);

export interface EsunFeedOptions {
  log: (msg: string) => void;
  clock: Clock;
}

export class EsunMarketFeed implements MarketFeed {
  readonly name = 'esun';
  private symbols: string[] = [];
  private onEvent?: (e: MarketEvent) => void;
  private readonly sockets = new Map<Board, WsLike>();
  private readonly backoff = new Map<Board, number>();
  private readonly boardLot = new Map<string, number>();
  private readonly tickerDate = new Map<string, string>();
  private tickerTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly api: MarketDataApi,
    private readonly opts: EsunFeedOptions,
  ) {}

  async start(onEvent: (e: MarketEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.stopped = false;
    await this.api.login();
    this.tickerTimer = setInterval(() => void this.refreshTickers(), TICKER_CHECK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickerTimer) clearInterval(this.tickerTimer);
    for (const ws of this.sockets.values()) {
      try {
        ws.disconnect();
      } catch {
        // 已斷線
      }
    }
    this.sockets.clear();
  }

  async subscribe(symbols: string[]): Promise<void> {
    this.symbols = [...new Set(symbols)];
    await this.refreshTickers(true);
    await this.snapshot();
    await Promise.all([this.connect('regular'), this.connect('odd')]);
  }

  private emit(e: MarketEvent): void {
    this.onEvent?.(e);
  }

  // ---------------------------------------------------------------- REST

  /** 抓取（或重抓日期不是今天的）參考價與漲跌停。 */
  async refreshTickers(force = false): Promise<void> {
    const today = twDate(this.opts.clock.now());
    for (const symbol of this.symbols) {
      if (!force && this.tickerDate.get(symbol) === today) continue;
      try {
        const t = await this.api.ticker(symbol);
        this.boardLot.set(symbol, Number(t.boardLot) || 1000);
        this.tickerDate.set(symbol, String(t.date ?? ''));
        this.emit(this.toTicker(symbol, t));
      } catch (e) {
        this.opts.log(`行情 ticker ${symbol} 取得失敗：${(e as Error).message}`);
      }
    }
  }

  toTicker(symbol: string, t: Record<string, any>): TickerEvent {
    return {
      type: 'ticker',
      symbol,
      ts: toTwIso(this.opts.clock.now()),
      reference_x100: x100(t.referencePrice),
      prev_close_x100: x100(t.previousClose ?? t.referencePrice),
      limit_up_x100: x100(t.limitUpPrice),
      limit_down_x100: x100(t.limitDownPrice),
      is_attention: !!t.isAttention,
      is_disposition: !!t.isDisposition,
      is_halted: t.securityStatus === 'SUSPENDED' || t.securityStatus === 'TERMINATED',
    };
  }

  /** 初始五檔與最後成交（啟動與重連時）。 */
  private async snapshot(): Promise<void> {
    for (const symbol of this.symbols) {
      for (const board of ['regular', 'odd'] as const) {
        try {
          const q = await this.api.quote(symbol, board === 'odd');
          const ts = q.lastUpdated ? microsToIso(q.lastUpdated) : toTwIso(this.opts.clock.now());
          this.emit({ type: 'book', symbol, board, ts, bids: this.levels(symbol, board, q.bids), asks: this.levels(symbol, board, q.asks) });
          // 初始的最後成交只更新報價；volume 為 0，不會觸發模擬撮合
          const last = q.lastTrade?.price ?? q.closePrice;
          if (last) this.emit({ type: 'trade', symbol, board, ts, price_x100: x100(last), volume: 0 });
        } catch (e) {
          this.opts.log(`行情 quote ${symbol} ${board} 取得失敗：${(e as Error).message}`);
        }
      }
    }
  }

  private levels(symbol: string, board: Board, raw: unknown): Level[] {
    const unit = board === 'regular' ? (this.boardLot.get(symbol) ?? 1000) : 1;
    return (Array.isArray(raw) ? raw : []).map((l: any) => ({ price_x100: x100(l.price), size: Number(l.size) * unit }));
  }

  // ---------------------------------------------------------------- WebSocket

  private async connect(board: 'regular' | 'odd'): Promise<void> {
    if (this.stopped || this.symbols.length === 0) return;
    const ws = this.api.websocket();
    this.sockets.set(board, ws);
    ws.on('message', (raw: unknown) => this.handleMessage(board, raw));
    ws.on('disconnect', () => this.scheduleReconnect(board));
    ws.on('error', (err: unknown) => this.opts.log(`行情 WebSocket（${board}）錯誤：${(err as Error)?.message ?? err}`));
    try {
      await ws.connect();
      const odd = board === 'odd' ? { intradayOddLot: true } : {};
      ws.subscribe({ channel: 'trades', symbols: this.symbols, ...odd });
      ws.subscribe({ channel: 'books', symbols: this.symbols, ...odd });
      this.backoff.delete(board);
      this.opts.log(`行情 WebSocket（${board}）已連線，訂閱 ${this.symbols.join(', ')}`);
    } catch (e) {
      this.opts.log(`行情 WebSocket（${board}）連線失敗：${(e as Error)?.message ?? JSON.stringify(e)}`);
      this.scheduleReconnect(board);
    }
  }

  private scheduleReconnect(board: 'regular' | 'odd'): void {
    if (this.stopped || this.sockets.get(board) === undefined) return;
    this.sockets.delete(board);
    const delay = Math.min(RECONNECT_MAX_MS, (this.backoff.get(board) ?? RECONNECT_MIN_MS / 2) * 2);
    this.backoff.set(board, delay);
    this.opts.log(`行情 WebSocket（${board}）斷線，${delay / 1000} 秒後重連`);
    setTimeout(async () => {
      if (this.stopped) return;
      try {
        // token 可能過期：重新登入，並以 REST 補上斷線期間的報價
        await this.api.login();
        await this.snapshot();
      } catch (e) {
        this.opts.log(`行情重新登入失敗：${(e as Error).message}`);
      }
      await this.connect(board);
    }, delay);
  }

  /** WebSocket 訊息是 JSON 字串；控制訊息（authenticated、subscribed…）略過，資料在 event === 'data'。 */
  handleMessage(board: 'regular' | 'odd', raw: unknown): void {
    let msg: { event?: string; channel?: string; data?: any };
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as typeof msg);
    } catch {
      return;
    }
    if (msg?.event !== 'data' || !msg.data) return;
    const d = msg.data;
    const symbol = String(d.symbol ?? '');
    if (!symbol) return;

    if (msg.channel === 'trades') {
      if (d.isTrial) return;
      const unit = board === 'regular' ? (this.boardLot.get(symbol) ?? 1000) : 1;
      const e: TradeEvent = {
        type: 'trade',
        symbol,
        board,
        ts: microsToIso(d.time),
        price_x100: x100(d.price),
        volume: Number(d.size ?? 0) * unit,
      };
      if (board === 'regular' && d.isOpen) e.auction = 'open';
      if (board === 'regular' && d.isClose) e.auction = 'close';
      this.emit(e);
    } else if (msg.channel === 'books') {
      const e: BookEvent = {
        type: 'book',
        symbol,
        board,
        ts: microsToIso(d.time),
        bids: this.levels(symbol, board, d.bids),
        asks: this.levels(symbol, board, d.asks),
      };
      this.emit(e);
    }
  }

  // ---------------------------------------------------------------- K 線

  async candles(symbol: string, interval: string, count: number): Promise<unknown[]> {
    const tf = /^(\d+)m$/.exec(interval)?.[1];
    if (tf) {
      // 日內 K 線以 date 欄位給出該根的起始時間（ISO，含 +08:00）；average 為當日累計成交均價（VWAP）
      const r = await this.api.intradayCandles(symbol, tf);
      return (r.data ?? []).slice(-count);
    }
    if (interval === 'D' || interval === '1d') {
      const today = twDate(this.opts.clock.now());
      // 單次請求跨度須小於一年；交易日約為日曆日的 7 成
      const from = addDays(today, -Math.min(360, Math.ceil(count * 1.6) + 10));
      const r = await this.api.historicalCandles(symbol, from, today);
      const rows = (r.data ?? []) as { date: string }[];
      return rows.sort((a, b) => a.date.localeCompare(b.date)).slice(-count);
    }
    throw new Error(`不支援的 K 線週期 ${interval}，可用 1m、5m、10m、15m、30m、60m、D`);
  }
}
