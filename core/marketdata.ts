import type { Quote } from './market.js';

/**
 * 行情事件：daemon 的行情來源（玉山 WebSocket、錄製檔重播、測試）一律轉成這組型別，
 * 報價快取與模擬撮合只認這組型別，不知道資料從哪裡來。
 *
 * 單位：價格為分（*_x100），數量一律為「股」。券商回報的整股數量是「張」，
 * 由轉接層乘以 1000 後再送進來。
 */

/** regular：整股；odd：盤中零股；odd_after：盤後零股 */
export type Board = 'regular' | 'odd' | 'odd_after';

export interface Level {
  price_x100: number;
  size: number;
}

/** 每日一次或狀態改變時：參考價、漲跌停、特殊狀態（玉山 intraday/ticker）。 */
export interface TickerEvent {
  type: 'ticker';
  symbol: string;
  ts: string;
  reference_x100: number;
  prev_close_x100: number;
  limit_up_x100: number;
  limit_down_x100: number;
  is_attention?: boolean;
  is_disposition?: boolean;
  is_full_delivery?: boolean;
  is_halted?: boolean;
}

/** 最佳五檔。 */
export interface BookEvent {
  type: 'book';
  symbol: string;
  board: Board;
  ts: string;
  bids: Level[];
  asks: Level[];
}

/**
 * 一筆成交。auction 標示集合競價撮合（開盤、收盤）；零股的每次定期撮合也是一筆 trade。
 * volume 為該筆成交量（股）。
 */
export interface TradeEvent {
  type: 'trade';
  symbol: string;
  board: Board;
  ts: string;
  price_x100: number;
  volume: number;
  auction?: 'open' | 'close';
}

export type MarketEvent = TickerEvent | BookEvent | TradeEvent;

interface SymbolState {
  ticker?: TickerEvent;
  book?: BookEvent;
  last?: TradeEvent;
  oddBook?: BookEvent;
  oddLast?: TradeEvent;
  ts?: string;
}

/** 由行情事件組出風控與 ctrade quote 用的報價。 */
export class QuoteCache {
  private state = new Map<string, SymbolState>();

  apply(e: MarketEvent): void {
    const s = this.state.get(e.symbol) ?? {};
    if (e.type === 'ticker') s.ticker = e;
    else if (e.type === 'book') {
      if (e.board === 'regular') s.book = e;
      else s.oddBook = e;
    } else if (e.board === 'regular') s.last = e;
    else s.oddLast = e;
    s.ts = e.ts;
    this.state.set(e.symbol, s);
  }

  book(symbol: string, board: Board): BookEvent | undefined {
    const s = this.state.get(symbol);
    return board === 'regular' ? s?.book : s?.oddBook;
  }

  /** 沒有 ticker（漲跌停未知）時不回報價，風控因此會拒絕下單。 */
  getQuote(symbol: string): Quote | undefined {
    const s = this.state.get(symbol);
    if (!s?.ticker) return undefined;
    const last = s.last?.price_x100 ?? s.ticker.prev_close_x100;
    return {
      symbol,
      last_x100: last,
      prev_close_x100: s.ticker.prev_close_x100,
      limit_up_x100: s.ticker.limit_up_x100,
      limit_down_x100: s.ticker.limit_down_x100,
      best_bid_x100: s.book?.bids[0]?.price_x100,
      best_ask_x100: s.book?.asks[0]?.price_x100,
      is_attention: s.ticker.is_attention,
      is_disposition: s.ticker.is_disposition,
      is_full_delivery: s.ticker.is_full_delivery,
      is_halted: s.ticker.is_halted,
      ts: s.ts ?? s.ticker.ts,
    };
  }

  /** 給 ctrade quote 的完整資料：整股與零股的最後成交與五檔。 */
  detail(symbol: string) {
    const s = this.state.get(symbol);
    if (!s) return undefined;
    return {
      quote: this.getQuote(symbol),
      book: s.book ? { bids: s.book.bids, asks: s.book.asks, ts: s.book.ts } : undefined,
      odd_last: s.oddLast ? { price_x100: s.oddLast.price_x100, volume: s.oddLast.volume, ts: s.oddLast.ts } : undefined,
      odd_book: s.oddBook ? { bids: s.oddBook.bids, asks: s.oddBook.asks, ts: s.oddBook.ts } : undefined,
    };
  }

  symbols(): string[] {
    return [...this.state.keys()];
  }
}

export type QuoteDetail = { symbol: string } & Partial<NonNullable<ReturnType<QuoteCache['detail']>>>;
