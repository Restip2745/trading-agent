import type { Config, RiskParams } from './config.js';
import type { DB } from './db.js';
import { invalidArgs } from './errors.js';
import { call } from './ipc.js';
import { allocate, transferIn, transferOut, withdraw } from './ledger.js';
import { type Quote, type QuoteSource, staticQuotes, valuate } from './market.js';
import { checkLedgerConsistency, recordReconciliation } from './reconcile.js';
import { scalePeaksForFlow } from './risk.js';
import { type FeeScheduleInput, addFeeSchedule, getFeeSchedule, setRiskParams } from './settings.js';
import { addHoliday, audit, getPause, getState, pause, resume, setState } from './state.js';
import { activateStrategy, git, STRATEGY_DIR } from './strategy.js';
import { type Clock, isValidDate, toTwIso } from './time.js';

/**
 * 使用者的管理操作。ctrade-admin 與 Web UI 都只透過這裡寫入，驗證邏輯只有一份（規格第 11 節）。
 * 每個操作都寫入 audit_log，失敗也記錄。
 */

export interface AdminContext {
  db: DB;
  config: Config;
  root: string;
  clock: Clock;
  /** 估值用的報價；daemon 未執行時為空，以平均成本估值 */
  quotes: QuoteSource;
  ipcPath: string;
  /** 寫入稽核記錄的操作者，例如 user（CLI）、web */
  actor: string;
}

/** 執行管理操作並寫入稽核記錄。 */
export async function runAdmin<T>(ctx: AdminContext, command: string, args: unknown, fn: () => T | Promise<T>): Promise<T> {
  try {
    const result = await fn();
    audit(ctx.db, ctx.actor, command, args, 'ok', ctx.clock);
    return result;
  } catch (e) {
    audit(ctx.db, ctx.actor, command, args, `error: ${(e as Error).message}`, ctx.clock);
    throw e;
  }
}

/** 向 daemon 取報價（daemon 未執行時回傳空報價，呼叫端以平均成本估值）。 */
export async function quotesFromDaemon(ipcPath: string, symbols: string[]): Promise<QuoteSource> {
  try {
    return staticQuotes(await call<Quote[]>(ipcPath, 'quotes', { symbols: [...new Set(symbols)] }, 5_000));
  } catch {
    return staticQuotes([]);
  }
}

const equityOf = (ctx: AdminContext) => valuate(ctx.db, ctx.quotes, ctx.config.symbols).equity;

/** 資金或持股異動：前後權益比例縮放回撤高點（規格第 6 節）。 */
function withPeakScaling<T>(ctx: AdminContext, fn: () => T): T {
  return ctx.db.transaction(() => {
    const before = equityOf(ctx);
    const result = fn();
    scalePeaksForFlow(ctx.db, before, equityOf(ctx), ctx.clock);
    return result;
  })();
}

// ---------------------------------------------------------------- 資金與持股

export const allocateFunds = (ctx: AdminContext, input: { amount: number; note?: string }) =>
  runAdmin(ctx, 'allocate', input, () => withPeakScaling(ctx, () => allocate(ctx.db, input.amount, 'user', input.note, ctx.clock)));

export const withdrawFunds = (ctx: AdminContext, input: { amount: number; note?: string }) =>
  runAdmin(ctx, 'withdraw', input, () => withPeakScaling(ctx, () => withdraw(ctx.db, input.amount, 'user', input.note, ctx.clock)));

export interface TransferInInput {
  symbol: string;
  qty: number;
  /** 每股成本（分）；未提供時以前一交易日收盤價 */
  costPerShareX100?: number;
  note?: string;
}

export const transferSharesIn = (ctx: AdminContext, input: TransferInInput) =>
  runAdmin(ctx, 'transfer-in', input, async () => {
    // 規格第 5 節：live 模式必須先向券商查詢實際持股，確認「使用者持股 − 已轉入股數」足夠
    let brokerHeldQty: number | undefined;
    if (ctx.config.mode === 'live') {
      const holdings = await call<{ symbol: string; qty: number }[]>(ctx.ipcPath, 'broker_holdings', {}, 30_000);
      brokerHeldQty = holdings.find((h) => h.symbol === input.symbol)?.qty ?? 0;
    }
    const cost = input.costPerShareX100 ?? ctx.quotes.getQuote(input.symbol)?.prev_close_x100;
    if (!cost) throw invalidArgs('COST_REQUIRED', `取不到 ${input.symbol} 前一交易日收盤價，請指定每股成本`);
    return withPeakScaling(ctx, () =>
      transferIn(
        ctx.db,
        { symbol: input.symbol, qty: input.qty, costPerShareX100: cost, brokerHeldQty, actor: 'user', note: input.note },
        ctx.clock,
      ),
    );
  });

export const transferSharesOut = (ctx: AdminContext, input: { symbol: string; qty: number; note?: string }) =>
  runAdmin(ctx, 'transfer-out', input, () =>
    withPeakScaling(ctx, () => transferOut(ctx.db, { ...input, actor: 'user' }, ctx.clock)),
  );

// ---------------------------------------------------------------- 暫停與恢復

export const pauseTrading = (ctx: AdminContext, input: { reason?: string }) =>
  runAdmin(ctx, 'pause', input, () => {
    pause(ctx.db, 'manual', input.reason?.trim() || '使用者手動暫停', ctx.clock);
    return getPause(ctx.db);
  });

export const resumeTrading = (ctx: AdminContext, input: { resetPeak?: boolean }) =>
  runAdmin(ctx, 'resume', input, () => {
    resume(ctx.db, { resetPeak: !!input.resetPeak, currentEquity: equityOf(ctx) }, ctx.clock);
    return getPause(ctx.db);
  });

// ---------------------------------------------------------------- 緊急操作（規格第 18 節，經 daemon 送單）

export const cancelAllOrders = (ctx: AdminContext) =>
  runAdmin(ctx, 'cancel-all', {}, () => call(ctx.ipcPath, 'cancel_all', {}, 60_000));

export const flattenAll = (ctx: AdminContext) =>
  runAdmin(ctx, 'flatten', {}, () => call(ctx.ipcPath, 'flatten', {}, 60_000));

// ---------------------------------------------------------------- 風控、費率、休市

export const updateRiskParams = (ctx: AdminContext, patch: Partial<RiskParams>) =>
  runAdmin(ctx, 'risk set', patch, () => setRiskParams(ctx.db, patch, ctx.clock));

/** 新增費率版本；未提供的欄位沿用生效日當時的版本。 */
export const addFeeVersion = (ctx: AdminContext, input: Partial<FeeScheduleInput> & { effective: string }) =>
  runAdmin(ctx, 'fees set', input, () => {
    if (!isValidDate(input.effective)) throw invalidArgs('INVALID_DATE', `生效日 ${input.effective} 格式錯誤，須為 YYYY-MM-DD`);
    const cur = getFeeSchedule(ctx.db, input.effective);
    const merged: FeeScheduleInput = {
      fee_rate_pct: input.fee_rate_pct ?? cur.fee_rate_ppm / 10_000,
      fee_discount: input.fee_discount ?? cur.fee_discount_bp / 10_000,
      rebate_mode: input.rebate_mode ?? cur.rebate_mode,
      min_fee_regular: input.min_fee_regular ?? cur.min_fee_regular,
      min_fee_odd: input.min_fee_odd ?? cur.min_fee_odd,
      tax_stock_pct: input.tax_stock_pct ?? cur.tax_stock_ppm / 10_000,
      tax_daytrade_pct: input.tax_daytrade_pct ?? cur.tax_daytrade_ppm / 10_000,
      tax_etf_pct: input.tax_etf_pct ?? cur.tax_etf_ppm / 10_000,
    };
    return addFeeSchedule(ctx.db, merged, input.effective, ctx.clock);
  });

export const markHoliday = (ctx: AdminContext, input: { date: string; reason?: string }) =>
  runAdmin(ctx, 'holiday add', input, () => {
    if (!isValidDate(input.date)) throw invalidArgs('INVALID_DATE', `日期 ${input.date} 格式錯誤，須為 YYYY-MM-DD`);
    addHoliday(ctx.db, input.date, input.reason ?? null);
    return { date: input.date, reason: input.reason ?? null };
  });

// ---------------------------------------------------------------- Claude、用量預算

export const resetClaude = (ctx: AdminContext) =>
  runAdmin(ctx, 'claude reset', {}, () => {
    const was = getState(ctx.db, 'claude_unavailable');
    setState(ctx.db, 'claude_unavailable', null, ctx.clock);
    return { claude_unavailable: null, was };
  });

/** 自訂用量預算（覆寫設定檔的初始值，規格第 11 節）。 */
export const setUsageBudget = (ctx: AdminContext, input: { daily_budget_tokens: number; weekly_budget_tokens: number }) =>
  runAdmin(ctx, 'usage budget', input, () => {
    for (const [k, v] of Object.entries(input)) {
      if (!Number.isInteger(v) || v <= 0) throw invalidArgs('INVALID_BUDGET', `${k} 必須是正整數，收到 ${v}`);
    }
    if (input.weekly_budget_tokens < input.daily_budget_tokens) {
      throw invalidArgs('INVALID_BUDGET', '每週預算不可小於每日預算');
    }
    setState(ctx.db, 'usage_daily_budget_tokens', String(input.daily_budget_tokens), ctx.clock);
    setState(ctx.db, 'usage_weekly_budget_tokens', String(input.weekly_budget_tokens), ctx.clock);
    return usageBudget(ctx.db, ctx.config);
  });

export function usageBudget(db: DB, config: Config): { daily_budget_tokens: number; weekly_budget_tokens: number } {
  const n = (key: string) => {
    const v = getState(db, key);
    return v === null ? undefined : Number(v);
  };
  return {
    daily_budget_tokens: n('usage_daily_budget_tokens') ?? config.usage.daily_budget_tokens,
    weekly_budget_tokens: n('usage_weekly_budget_tokens') ?? config.usage.weekly_budget_tokens,
  };
}

// ---------------------------------------------------------------- 對帳

export const runReconciliation = (ctx: AdminContext) =>
  runAdmin(ctx, 'reconcile', {}, () => {
    const diffs = checkLedgerConsistency(ctx.db);
    const status = recordReconciliation(ctx.db, diffs, ctx.clock);
    if (status === 'error') pause(ctx.db, 'reconciliation', '對帳出現差異', ctx.clock);
    return { status, diffs };
  });

/** 標記對帳差異已處理（記錄處理說明；不會自動恢復交易）。 */
export const resolveReconciliation = (ctx: AdminContext, input: { id: number; note: string }) =>
  runAdmin(ctx, 'reconcile resolve', input, () => {
    if (!input.note?.trim()) throw invalidArgs('NOTE_REQUIRED', '請說明差異如何處理');
    const info = ctx.db
      .prepare('UPDATE reconciliation_runs SET resolved_at = ?, resolved_note = ? WHERE id = ? AND resolved_at IS NULL')
      .run(toTwIso(ctx.clock.now()), input.note.trim(), input.id);
    if (info.changes === 0) throw invalidArgs('NOT_FOUND', `找不到未處理的對帳紀錄 ${input.id}`);
    return { id: input.id, resolved: true };
  });

// ---------------------------------------------------------------- 策略版本

/** 把目前 commit 的策略 skill 記錄為生效版本；策略檔有未 commit 的修改時拒絕。 */
export const activateCurrentStrategy = (ctx: AdminContext, input: { note?: string }) =>
  runAdmin(ctx, 'strategy activate', input, () => {
    const dirty = git(ctx.root, ['status', '--porcelain', '--', STRATEGY_DIR]);
    if (dirty) throw invalidArgs('STRATEGY_UNCOMMITTED', `${STRATEGY_DIR} 有未 commit 的修改，請先 commit：\n${dirty}`);
    const version = git(ctx.root, ['log', '-1', '--format=%H', '--', STRATEGY_DIR]);
    if (!version) throw invalidArgs('STRATEGY_NOT_COMMITTED', `${STRATEGY_DIR} 尚未進版控`);
    const subject = git(ctx.root, ['log', '-1', '--format=%s', version]);
    return { ...activateStrategy(ctx.db, version, input.note, ctx.clock), commit_subject: subject };
  });

