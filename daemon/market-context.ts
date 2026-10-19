import type { DB } from '../core/db.js';
import {
  CONTEXT_LABELS,
  type ContextContent,
  type ContextKind,
  type ContextRecord,
  type MarketQuote,
  type TaifexNight,
  type UsdTwd,
  recordFetchError,
  saveContext,
} from '../core/market-context.js';
import { isTradingDay } from '../core/state.js';
import { type Clock, addDays, toTwIso, twHhmm } from '../core/time.js';

/**
 * 盤外資訊的抓取（規格第 14 節）。交易日每 refresh_min 分鐘抓一次，寫入 market_context。
 * 來源都是不需要金鑰的公開行情：
 *   - 美股指數與台積電 ADR、美元兌新台幣：Yahoo Finance chart API（非官方介面，格式可能變動）
 *   - 台指期夜盤：臺灣期貨交易所行情網站 mis.taifex.com.tw（盤後交易時段）
 * 抓取失敗只記錄在 system_state 與日誌，保留上一份資料，不影響交易流程。
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const US_QUOTES = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: '那斯達克' },
  { symbol: '^SOX', name: '費城半導體' },
  { symbol: 'TSM', name: '台積電 ADR' },
] as const;

const YAHOO_SOURCE = 'Yahoo Finance';
const TAIFEX_SOURCE = '臺灣期貨交易所';
const TAIFEX_QUOTE_URL = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
const TIMEOUT_MS = 10_000;

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------- 解析

interface YahooChart {
  chart?: {
    result?: {
      meta?: {
        regularMarketTime?: number;
        gmtoffset?: number;
        currentTradingPeriod?: { regular?: { start: number; end: number } };
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

/** 日 K 的最後兩根：最後一根是最近一個交易日（盤中時是今天），前一根是前一日收盤。 */
export function parseYahooChart(json: unknown, symbol: string, now: Date, digits = 2) {
  const r = (json as YahooChart)?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}：${(json as YahooChart)?.chart?.error?.description ?? '回應沒有資料'}`);
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const bars = ts.map((t, i) => ({ t, c: closes[i] })).filter((b): b is { t: number; c: number } => typeof b.c === 'number');
  if (bars.length < 2) throw new Error(`Yahoo ${symbol}：日 K 不足兩根`);
  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  const offset = r.meta?.gmtoffset ?? 0;
  const period = r.meta?.currentTradingPeriod?.regular;
  const nowSec = now.getTime() / 1000;
  const quotedSec = r.meta?.regularMarketTime ?? last.t;
  return {
    date: new Date((last.t + offset) * 1000).toISOString().slice(0, 10),
    close: round(last.c, digits),
    prev_close: round(prev.c, digits),
    change: round(last.c - prev.c, digits),
    change_pct: round(((last.c - prev.c) / prev.c) * 100, 2),
    in_progress: !!period && nowSec >= period.start && nowSec < period.end,
    quoted_at: toTwIso(new Date(quotedSec * 1000)),
  };
}

interface TaifexQuote {
  SymbolID?: string;
  DispCName?: string;
  CDate?: string;
  CTime?: string;
  COpenPrice?: string;
  CHighPrice?: string;
  CLowPrice?: string;
  CLastPrice?: string;
  CRefPrice?: string;
  CDiff?: string;
  CDiffRate?: string;
  CTotalVolume?: string;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nonZero = (v: string | undefined) => {
  const n = num(v);
  return n === 0 ? null : n;
};

/**
 * 盤後交易時段的台指期報價列表：取近月合約（列表中第一個 TXF 月合約）。
 * 夜盤 15:00 開始、隔天 05:00 收盤；CDate 是夜盤開始的日期，05:00 前的成交時間屬於隔天。
 */
export function parseTaifexNight(json: unknown, now: Date): TaifexNight {
  const body = json as { RtCode?: string; RtMsg?: string; RtData?: { QuoteList?: TaifexQuote[] } };
  const list = body?.RtData?.QuoteList;
  if (body?.RtCode !== '0' || !Array.isArray(list)) throw new Error(`期交所行情：${body?.RtMsg || '回應格式不符'}`);
  const near = list.find((q) => /^TXF[A-Z]\d-M$/.test(q.SymbolID ?? ''));
  if (!near) throw new Error('期交所行情：找不到台指期夜盤合約');
  const last = nonZero(near.CLastPrice);
  if (last === null) throw new Error(`期交所行情：${near.SymbolID} 夜盤尚無成交`);
  const cdate = near.CDate ?? '';
  if (!/^\d{8}$/.test(cdate)) throw new Error(`期交所行情：日期格式不符 ${cdate}`);
  const sessionDate = `${cdate.slice(0, 4)}-${cdate.slice(4, 6)}-${cdate.slice(6, 8)}`;
  const ctime = /^\d{6}$/.test(near.CTime ?? '') ? near.CTime! : '000000';
  const tradeDate = ctime < '150000' ? addDays(sessionDate, 1) : sessionDate;
  const time = twHhmm(now);
  const spot = list.find((q) => /^TXF-P$/.test(q.SymbolID ?? ''));
  return {
    contract: (near.DispCName ?? near.SymbolID ?? '').slice(0, 20),
    symbol_id: near.SymbolID!,
    session_date: sessionDate,
    open: nonZero(near.COpenPrice),
    high: nonZero(near.CHighPrice),
    low: nonZero(near.CLowPrice),
    last,
    ref: nonZero(near.CRefPrice),
    change: num(near.CDiff),
    change_pct: num(near.CDiffRate),
    volume: num(near.CTotalVolume),
    last_trade_at: `${tradeDate}T${ctime.slice(0, 2)}:${ctime.slice(2, 4)}:${ctime.slice(4, 6)}.000+08:00`,
    in_progress: time >= '15:00' || time < '05:00',
    spot_ref: nonZero(spot?.CRefPrice),
  };
}

// ---------------------------------------------------------------- 抓取

export class MarketContextJobs {
  private running = false;
  private lastAttempt = 0;

  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly opts: { refreshMin: number; fetch: FetchFn; log: (msg: string) => void },
  ) {}

  /** daemon 每次 tick 呼叫：交易日、距上次抓取滿 refresh_min 分鐘才抓。 */
  async maybeRefresh(): Promise<void> {
    const now = this.clock.now();
    if (this.running || !isTradingDay(this.db, now)) return;
    if (now.getTime() - this.lastAttempt < this.opts.refreshMin * 60_000) return;
    this.lastAttempt = now.getTime();
    this.running = true;
    try {
      await this.refresh();
    } finally {
      this.running = false;
    }
  }

  /** 三項各自抓取，一項失敗不影響其他項。 */
  async refresh(): Promise<void> {
    const jobs: { [K in ContextKind]: () => Promise<Omit<ContextRecord<K>, 'fetched_at'>> } = {
      us_markets: () => this.usMarkets(),
      taifex_night: () => this.taifexNight(),
      usdtwd: () => this.usdTwd(),
    };
    await Promise.all(
      (Object.keys(jobs) as ContextKind[]).map(async (kind) => {
        try {
          saveContext(this.db, kind, await jobs[kind](), this.clock);
        } catch (e) {
          const msg = (e as Error).message;
          if (recordFetchError(this.db, kind, msg, this.clock)) this.opts.log(`盤外資訊「${CONTEXT_LABELS[kind]}」抓取失敗：${msg}`);
        }
      }),
    );
  }

  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.opts.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${new URL(url).host} 回應 HTTP ${res.status}`);
    return res.json();
  }

  private yahoo(symbol: string): Promise<unknown> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`;
    // 沒有 User-Agent 時 Yahoo 常回 429
    return this.json(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  }

  private async usMarkets(): Promise<Omit<ContextRecord<'us_markets'>, 'fetched_at'>> {
    const now = this.clock.now();
    const parsed = await Promise.all(
      US_QUOTES.map(async (q) => ({ q, r: parseYahooChart(await this.yahoo(q.symbol), q.symbol, now) })),
    );
    const quotes: MarketQuote[] = parsed.map(({ q, r }) => ({
      symbol: q.symbol,
      name: q.name,
      date: r.date,
      close: r.close,
      prev_close: r.prev_close,
      change: r.change,
      change_pct: r.change_pct,
      in_progress: r.in_progress,
    }));
    const dataTime = parsed.map(({ r }) => r.quoted_at).sort().at(-1)!;
    return { data_time: dataTime, source: YAHOO_SOURCE, content: { quotes } satisfies ContextContent['us_markets'] };
  }

  private async taifexNight(): Promise<Omit<ContextRecord<'taifex_night'>, 'fetched_at'>> {
    const body = { MarketType: '1', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '', PageNo: '', SortColumn: '', AscDesc: 'A' };
    const json = await this.json(TAIFEX_QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const night = parseTaifexNight(json, this.clock.now());
    return { data_time: night.last_trade_at, source: TAIFEX_SOURCE, content: night };
  }

  private async usdTwd(): Promise<Omit<ContextRecord<'usdtwd'>, 'fetched_at'>> {
    const r = parseYahooChart(await this.yahoo('TWD=X'), 'TWD=X', this.clock.now(), 4);
    const content: UsdTwd = {
      pair: 'USD/TWD',
      last: r.close,
      prev_close: r.prev_close,
      change: r.change,
      change_pct: r.change_pct,
      quoted_at: r.quoted_at,
      note: '數字上升代表新台幣貶值',
    };
    return { data_time: r.quoted_at, source: `${YAHOO_SOURCE}（國際報價，非台北外匯經紀收盤價）`, content };
  }
}
