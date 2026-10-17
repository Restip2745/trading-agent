import type { SymbolConfig } from './config.js';
import type { DB } from './db.js';
import { getBalance, getPositions } from './ledger.js';

/**
 * 行情快照的最小介面。風控與估值只依賴這個介面：
 * live 與 paper 都由 daemon 從真實行情提供，測試時以固定值注入。
 */
export interface Quote {
  symbol: string;
  /** 最後成交價（分） */
  last_x100: number;
  /** 前一交易日收盤價（分） */
  prev_close_x100?: number;
  limit_up_x100: number;
  limit_down_x100: number;
  best_bid_x100?: number;
  best_ask_x100?: number;
  /** 注意股、處置股、全額交割、暫停交易（規格第 6 節第 15 條） */
  is_attention?: boolean;
  is_disposition?: boolean;
  is_full_delivery?: boolean;
  is_halted?: boolean;
  /** 報價時間（ISO） */
  ts: string;
}

export interface QuoteSource {
  getQuote(symbol: string): Quote | undefined;
}

export const staticQuotes = (quotes: Quote[]): QuoteSource => {
  const map = new Map(quotes.map((q) => [q.symbol, q]));
  return { getQuote: (s) => map.get(s) };
};

export interface Valuation {
  cash: number;
  reserved: number;
  available: number;
  market_value: number;
  equity: number;
  /** 總曝險 = Σ 市值 × |槓桿倍數|（規格第 13 節） */
  gross_exposure: number;
  /** 淨曝險 = Σ 市值 × 帶號槓桿倍數 */
  net_exposure: number;
  /** 缺報價、改以平均成本估值的代號 */
  stale_symbols: string[];
}

/** 以當下報價計算總權益與曝險。缺報價時以平均成本估值並標示。 */
export function valuate(db: DB, quotes: QuoteSource, symbols: Record<string, SymbolConfig>): Valuation {
  const balance = getBalance(db);
  let marketValue = 0;
  let gross = 0;
  let net = 0;
  const stale: string[] = [];
  for (const p of getPositions(db)) {
    if (p.qty === 0) continue;
    const q = quotes.getQuote(p.symbol);
    const price = q?.last_x100 ?? p.avg_cost_x100;
    if (!q) stale.push(p.symbol);
    const mv = Math.floor((price * p.qty) / 100);
    const lev = symbols[p.symbol]?.leverage ?? 1;
    marketValue += mv;
    gross += mv * Math.abs(lev);
    net += mv * lev;
  }
  return {
    ...balance,
    market_value: marketValue,
    equity: balance.cash + marketValue,
    gross_exposure: gross,
    net_exposure: net,
    stale_symbols: stale,
  };
}
