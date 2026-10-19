import type { Config } from './config.js';
import type { DB } from './db.js';
import { getState, setState } from './state.js';
import { type Clock, toTwIso } from './time.js';

/**
 * 盤外資訊（規格第 14 節）：前一晚的美股、台指期夜盤、美元兌新台幣。
 * daemon 定時抓取並寫入 market_context（daemon/market-context.ts），ctrade global 與 pre_open 提示從這裡讀，
 * Claude 查詢時不必等外部服務。抓取失敗不影響交易流程，只在輸出中標示資料缺漏。
 */

export const CONTEXT_KINDS = ['us_markets', 'taifex_night', 'usdtwd'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const CONTEXT_LABELS: Record<ContextKind, string> = {
  us_markets: '美股',
  taifex_night: '台指期夜盤',
  usdtwd: '美元兌新台幣',
};

/** 美股指數或個股的最近一個交易日。 */
export interface MarketQuote {
  symbol: string;
  name: string;
  /** 交易所當地的交易日 */
  date: string;
  close: number;
  prev_close: number;
  change: number;
  change_pct: number;
  /** 抓取時該市場仍在交易，close 是盤中價 */
  in_progress: boolean;
}

export interface UsMarkets {
  quotes: MarketQuote[];
}

export interface TaifexNight {
  contract: string;
  symbol_id: string;
  /** 夜盤開始的日期（15:00 開盤，隔天 05:00 收盤） */
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number;
  /** 參考價：前一個日盤的收盤 */
  ref: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  last_trade_at: string;
  in_progress: boolean;
  /** 加權指數前一日收盤，可與夜盤價比較 */
  spot_ref: number | null;
}

export interface UsdTwd {
  pair: 'USD/TWD';
  last: number;
  prev_close: number;
  change: number;
  change_pct: number;
  quoted_at: string;
  note: string;
}

export interface ContextContent {
  us_markets: UsMarkets;
  taifex_night: TaifexNight;
  usdtwd: UsdTwd;
}

export interface ContextRecord<K extends ContextKind = ContextKind> {
  data_time: string;
  fetched_at: string;
  source: string;
  content: ContextContent[K];
}

export const DEFAULT_REFRESH_MIN = 15;

/** 資料時間超過這個時數視為過期：涵蓋週末加上一天連假（週五美股收盤到週二早上約 101 小時）。 */
export const MAX_DATA_AGE_H = 120;

export const refreshMin = (config: Config) => config.market_context?.refresh_min ?? DEFAULT_REFRESH_MIN;

const errorKey = (kind: ContextKind) => `market_context_error:${kind}`;

/** 寫入一次成功的抓取：資料沒變時只更新 fetched_at。 */
export function saveContext<K extends ContextKind>(
  db: DB,
  kind: K,
  rec: Omit<ContextRecord<K>, 'fetched_at'>,
  clock: Clock,
): void {
  const fetchedAt = toTwIso(clock.now());
  const content = JSON.stringify(rec.content);
  db.transaction(() => {
    const last = db
      .prepare('SELECT id, ts AS data_time, content_json FROM market_context WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as { id: number; data_time: string; content_json: string } | undefined;
    if (last && last.data_time === rec.data_time && last.content_json === content) {
      db.prepare('UPDATE market_context SET fetched_at = ? WHERE id = ?').run(fetchedAt, last.id);
    } else {
      db.prepare('INSERT INTO market_context (kind, ts, fetched_at, source, content_json) VALUES (?, ?, ?, ?, ?)').run(
        kind,
        rec.data_time,
        fetchedAt,
        rec.source,
        content,
      );
    }
    if (getState(db, errorKey(kind)) !== null) setState(db, errorKey(kind), null, clock);
  })();
}

/** 記錄抓取失敗，保留上一份資料。回傳是否為新的錯誤（上一次是成功或不同的錯誤），讓呼叫端決定要不要寫日誌。 */
export function recordFetchError(db: DB, kind: ContextKind, error: string, clock: Clock): boolean {
  const prev = fetchError(db, kind);
  const message = error.slice(0, 300);
  setState(db, errorKey(kind), JSON.stringify({ at: toTwIso(clock.now()), error: message }), clock);
  return prev?.error !== message;
}

export function fetchError(db: DB, kind: ContextKind): { at: string; error: string } | null {
  const raw = getState(db, errorKey(kind));
  return raw ? (JSON.parse(raw) as { at: string; error: string }) : null;
}

export function latestContext<K extends ContextKind>(db: DB, kind: K): ContextRecord<K> | undefined {
  const row = db
    .prepare('SELECT ts AS data_time, fetched_at, source, content_json FROM market_context WHERE kind = ? ORDER BY id DESC LIMIT 1')
    .get(kind) as { data_time: string; fetched_at: string; source: string; content_json: string } | undefined;
  if (!row) return undefined;
  return { data_time: row.data_time, fetched_at: row.fetched_at, source: row.source, content: JSON.parse(row.content_json) };
}

export interface ContextItem<K extends ContextKind = ContextKind> {
  label: string;
  /** ok：可用；stale：有資料但過期；missing：從未成功抓到 */
  status: 'ok' | 'stale' | 'missing';
  stale_reason?: string;
  data_time?: string;
  fetched_at?: string;
  /** 資料時間距今的小時數 */
  age_hours?: number;
  source?: string;
  /** 最近一次抓取失敗（成功後清除） */
  fetch_error?: { at: string; error: string };
  data?: ContextContent[K];
}

export type ContextReport = { [K in ContextKind]: ContextItem<K> };

const hoursBetween = (from: string, to: Date) => (to.getTime() - Date.parse(from)) / 3_600_000;

/**
 * 各項盤外資訊的最新一份與是否過期。過期：資料時間超過 MAX_DATA_AGE_H，
 * 或超過兩倍更新間隔沒有成功抓取（daemon 沒在執行或來源一直失敗，規格第 14 節）。
 */
export function contextReport(db: DB, clock: Clock, refresh: number): ContextReport {
  const now = clock.now();
  const item = <K extends ContextKind>(kind: K): ContextItem<K> => {
    const rec = latestContext(db, kind);
    const err = fetchError(db, kind);
    const base: ContextItem<K> = { label: CONTEXT_LABELS[kind], status: 'missing', ...(err ? { fetch_error: err } : {}) };
    if (!rec) return base;
    const age = hoursBetween(rec.data_time, now);
    const sinceFetchMin = hoursBetween(rec.fetched_at, now) * 60;
    let staleReason: string | undefined;
    if (age > MAX_DATA_AGE_H) staleReason = `資料時間超過 ${MAX_DATA_AGE_H} 小時`;
    else if (sinceFetchMin > refresh * 2) staleReason = `超過 ${refresh * 2} 分鐘沒有成功更新（daemon 沒在執行或來源抓取失敗）`;
    return {
      ...base,
      status: staleReason ? 'stale' : 'ok',
      ...(staleReason ? { stale_reason: staleReason } : {}),
      data_time: rec.data_time,
      fetched_at: rec.fetched_at,
      age_hours: Math.round(age * 10) / 10,
      source: rec.source,
      data: rec.content,
    };
  };
  return { us_markets: item('us_markets'), taifex_night: item('taifex_night'), usdtwd: item('usdtwd') };
}

// ---------------------------------------------------------------- 提示用的摘要

const fmt = (n: number, digits: number) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n: number, digits: number) => `${n > 0 ? '+' : ''}${fmt(n, digits)}`;
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const hhmmss = (iso: string) => iso.slice(0, 19).replace('T', ' ');

function line<K extends ContextKind>(it: ContextItem<K>, body: (d: ContextContent[K], source: string) => string): string {
  if (!it.data) {
    const why = it.fetch_error ? `最近一次抓取失敗：${it.fetch_error.error}` : 'daemon 尚未抓到資料';
    return `- ${it.label}：資料缺漏（${why}）`;
  }
  const stale = it.status === 'stale' ? `【過期：${it.stale_reason}】` : '';
  return `- ${it.label}${stale}：${body(it.data, it.source ?? '')}`;
}

/** pre_open 提示的「隔夜國際行情」段落：每項一行，標示來源、資料時間、過期與缺漏。 */
export function contextSummary(r: ContextReport): string {
  const us = line(r.us_markets, (d, source) => {
    const dates = [...new Set(d.quotes.map((q) => q.date))].join('、');
    const quotes = d.quotes.map((q) => `${q.name} ${fmt(q.close, 2)}（${pct(q.change_pct)}${q.in_progress ? '，盤中' : ''}）`).join('、');
    return `${quotes}。當地 ${dates} 收盤，來源 ${source}`;
  });
  const night = line(r.taifex_night, (d, source) => {
    const vsRef = d.ref !== null && d.change !== null && d.change_pct !== null ? `，較日盤收盤 ${fmt(d.ref, 0)} ${signed(d.change, 0)}（${pct(d.change_pct)}）` : '';
    const spot = d.spot_ref !== null ? `；加權指數前一日收盤 ${fmt(d.spot_ref, 2)}` : '';
    const state = d.in_progress ? '夜盤交易中' : '夜盤已收盤';
    return `${d.contract} ${fmt(d.last, 0)}${vsRef}${spot}。${state}，最後成交 ${hhmmss(d.last_trade_at)}，來源 ${source}`;
  });
  const fx = line(r.usdtwd, (d, source) =>
    `${fmt(d.last, 3)}，較前一日 ${fmt(d.prev_close, 3)} ${signed(d.change, 3)}（${pct(d.change_pct)}）；${d.note}。報價時間 ${hhmmss(d.quoted_at)}，來源 ${source}`,
  );
  return [us, night, fx].join('\n');
}
