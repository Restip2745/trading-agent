import { CommanderError } from 'commander';
import { type Config, loadConfig, projectRoot } from '../core/config.js';
import { type DB, openDb } from '../core/db.js';
import { CtradeError, ExitCode, internalError, invalidArgs } from '../core/errors.js';
import { call, ipcPath } from '../core/ipc.js';
import { type Quote, type QuoteSource, staticQuotes } from '../core/market.js';
import { parsePrice } from '../core/money.js';
import { indicatorsReport } from '../core/indicator-catalog.js';
import { type Bar, dailyIndicators, intradayIndicators } from '../core/indicators.js';
import { type Clock, addDays, fixedClock, systemClock, toTwIso, twDate } from '../core/time.js';

/**
 * ctrade 與 ctrade-admin 共用：載入設定、開啟帳本、統一輸出格式與結束碼（規格第 5 節）。
 *
 * 輸出：預設 JSON {"mode": "PAPER", "ok": true, "data": {...}}；--text 時第一行為 [PAPER] 或 [LIVE]。
 */

export interface Ctx {
  root: string;
  config: Config;
  db: DB;
  clock: Clock;
  quotes: QuoteSource;
  text: boolean;
}

let ctx: Ctx | undefined;
let modeLabel = 'UNKNOWN';
let textOutput = process.argv.includes('--text');

export function getCtx(): Ctx {
  if (ctx) return ctx;
  const root = projectRoot();
  const config = loadConfig(root);
  modeLabel = config.mode.toUpperCase();
  const clock = resolveClock(config.mode);
  // 報價由 daemon 提供，需要時以 loadQuotes 取得；沒有報價時估值以平均成本計算並標示。
  ctx = { root, config, db: openDb({ root, config, clock }), clock, quotes: staticQuotes([]), text: textOutput };
  return ctx;
}

/**
 * 測試用的固定時間 CTRADE_TEST_NOW，只在 paper 模式有效：
 * live 模式一律用系統時間，避免用假時間繞過交易時段檢查。
 */
function resolveClock(mode: Config['mode']): Clock {
  const fake = process.env.CTRADE_TEST_NOW;
  if (!fake) return systemClock;
  if (mode !== 'paper') throw internalError('TEST_CLOCK_IN_LIVE', 'CTRADE_TEST_NOW 只能在 paper 模式使用');
  return fixedClock(fake);
}

export function daemonPath(c: Ctx): string {
  return ipcPath(c.root, c.config.mode);
}

/** 向 daemon 取報價並放進 ctx，之後的風控與估值都用這份報價。 */
export async function loadQuotes(c: Ctx, symbols: string[], timeoutMs = 5_000): Promise<void> {
  const quotes = await call<Quote[]>(daemonPath(c), 'quotes', { symbols: [...new Set(symbols)] }, timeoutMs);
  c.quotes = staticQuotes(quotes);
}

/**
 * ctrade indicators 的資料：報價與 K 線都向 daemon 取，計算與回測共用 core/indicators.ts。
 * journal add 的指標快照也走這裡，確保快照與 agent 用 ctrade indicators 看到的是同一份定義。
 * timeoutMs 套用在每一個 daemon 呼叫（同時送出），預設報價 5 秒、K 線 30 秒。
 */
export async function fetchIndicators(c: Ctx, symbol: string, periods: number[], timeoutMs?: number) {
  const now = c.clock.now();
  const today = twDate(now);
  const path = daemonPath(c);
  const barsMs = timeoutMs ?? 30_000;
  // 日 K：取足夠計算最長週期的「昨日」均線；5 分 K：今天，以及近 20 個交易日（約 40 個日曆日）
  const maxN = Math.max(...periods, 20);
  const [, daily, todayBars, pastBars] = await Promise.all([
    loadQuotes(c, [symbol], timeoutMs),
    call<Bar[]>(path, 'bars', { symbol, interval: 'D', from: addDays(today, -Math.ceil(maxN * 1.6) - 30), to: addDays(today, -1) }, barsMs),
    call<Bar[]>(path, 'bars', { symbol, interval: '5m', from: today, to: today }, barsMs),
    call<Bar[]>(path, 'bars', { symbol, interval: '5m', from: addDays(today, -40), to: addDays(today, -1) }, barsMs),
  ]);
  const last = c.quotes.getQuote(symbol)?.last_x100;
  const lastPrice = last === undefined ? null : last / 100;
  return indicatorsReport(symbol, toTwIso(now), lastPrice, dailyIndicators(daily, lastPrice, periods), intradayIndicators(todayBars, pastBars, lastPrice, now));
}

export function emit(data: unknown): void {
  if (textOutput) {
    process.stdout.write(`[${modeLabel}]\n${toText(data)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ mode: modeLabel, ok: true, data })}\n`);
  }
}

function emitError(code: string, message: string, details?: Record<string, unknown>): void {
  if (textOutput) {
    process.stdout.write(`[${modeLabel}] 錯誤 ${code}：${message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ mode: modeLabel, ok: false, error: { code, message, ...(details ? { details } : {}) } })}\n`);
  }
}

/** 執行指令並把例外轉成規格的錯誤輸出與結束碼。 */
export async function run(action: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const data = await action();
    if (data !== undefined) emit(data);
    process.exitCode = ExitCode.OK;
  } catch (e) {
    process.exitCode = handleError(e);
  } finally {
    ctx?.db.close();
    ctx = undefined;
  }
}

export function handleError(e: unknown): number {
  if (e instanceof CtradeError) {
    emitError(e.code, e.message, e.details);
    return e.exitCode;
  }
  if (e instanceof CommanderError) {
    emitError('INVALID_ARGS', e.message.replace(/^error: /, ''));
    return ExitCode.INVALID_ARGS;
  }
  const err = e as Error;
  emitError('INTERNAL', err?.message ?? String(e));
  return ExitCode.INTERNAL;
}

/** 啟動時就先決定模式標示，讓參數錯誤的輸出也帶有正確模式。 */
export function initMode(): void {
  textOutput = process.argv.includes('--text');
  try {
    modeLabel = loadConfig().mode.toUpperCase();
  } catch {
    // 設定檔有問題時，等實際執行指令再回報具體錯誤
  }
}

// ---------------------------------------------------------------- 參數解析

export function parseIntArg(name: string, v: string): number {
  if (!/^-?\d+$/.test(v.trim())) throw invalidArgs('INVALID_ARGS', `${name} 必須是整數，收到 ${JSON.stringify(v)}`);
  return Number(v);
}

export function parseNumberArg(name: string, v: string): number {
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw invalidArgs('INVALID_ARGS', `${name} 必須是數字，收到 ${JSON.stringify(v)}`);
  return n;
}

export const parsePriceArg = (v: string) => parsePrice(v);

export function parseSymbol(v: string): string {
  const s = v.trim().toUpperCase();
  if (!/^[0-9A-Z]{4,6}$/.test(s)) throw invalidArgs('INVALID_SYMBOL', `股票代號 ${JSON.stringify(v)} 格式錯誤`);
  return s;
}

// ---------------------------------------------------------------- 文字輸出

function toText(data: unknown, indent = ''): string {
  if (data === null || data === undefined) return `${indent}-`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}（無資料）`;
    if (data.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return table(data as Record<string, unknown>[], indent);
    return data.map((v) => `${indent}- ${scalar(v)}`).join('\n');
  }
  if (typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) =>
        v !== null && typeof v === 'object' ? `${indent}${k}:\n${toText(v, `${indent}  `)}` : `${indent}${k}: ${scalar(v)}`,
      )
      .join('\n');
  }
  return `${indent}${scalar(data)}`;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function table(rows: Record<string, unknown>[], indent: string): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cells = rows.map((r) => cols.map((c) => scalar(r[c])));
  const width = (s: string) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const widths = cols.map((c, i) => Math.max(width(c), ...cells.map((row) => width(row[i] ?? ''))));
  const line = (vals: string[]) => indent + vals.map((v, i) => v + ' '.repeat((widths[i] ?? 0) - width(v))).join('  ');
  return [line(cols), ...cells.map(line)].join('\n');
}
