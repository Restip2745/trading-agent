import type { MarketRules, RiskParams } from './config.js';
import type { DB } from './db.js';
import { internalError, invalidArgs } from './errors.js';
import { type FeeSchedule, pctToPpm } from './money.js';
import { type Clock, isValidDate, toTwIso, twDate } from './time.js';

/**
 * 版本化的設定：風控參數、費率、市場規則。全部只增不改，
 * 風控參數以最新一筆為準，費率與市場規則以「生效日 ≤ 查詢日」的最新一筆為準（規格第 6、7 節）。
 */

// ---------------------------------------------------------------- 風控參數

export function getRiskParams(db: DB): RiskParams {
  const row = db.prepare('SELECT params_json FROM risk_settings ORDER BY id DESC LIMIT 1').get() as
    | { params_json: string }
    | undefined;
  if (!row) throw internalError('RISK_SETTINGS_MISSING', '資料庫沒有風控參數');
  return JSON.parse(row.params_json) as RiskParams;
}

type NumericRiskKey = {
  [K in keyof RiskParams]: RiskParams[K] extends number ? K : never;
}[keyof RiskParams];

/** 各數值參數的合理範圍，超出時拒絕。 */
const RISK_BOUNDS: Record<NumericRiskKey, [number, number]> = {
  max_order_amount: [1, 10_000_000],
  max_position_pct: [1, 100],
  max_exposure_pct: [1, 300],
  max_orders_per_day: [1, 500],
  max_orders_per_minute: [1, 20],
  max_round_trips_per_day: [0, 50],
  reentry_cooldown_min: [0, 270],
  daily_loss_limit_pct: [0.1, 100],
  intraday_drawdown_pct: [0.1, 100],
  max_drawdown_pct: [0.1, 100],
  max_api_failures: [1, 100],
  max_broker_rejects: [1, 100],
};

export function setRiskParams(db: DB, patch: Partial<RiskParams>, clock: Clock): RiskParams {
  const current = getRiskParams(db);
  const next: RiskParams = { ...current, ...patch };

  for (const [key, [min, max]] of Object.entries(RISK_BOUNDS) as [NumericRiskKey, [number, number]][]) {
    const v = next[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw invalidArgs('RISK_PARAM_RANGE', `${key} = ${v} 超出允許範圍 ${min} 至 ${max}`);
    }
  }
  if (typeof next.allow_opposite_positions !== 'boolean') {
    throw invalidArgs('RISK_PARAM_TYPE', 'allow_opposite_positions 必須是 true 或 false');
  }
  if (!Array.isArray(next.symbols_allowlist) || next.symbols_allowlist.some((s) => typeof s !== 'string')) {
    throw invalidArgs('RISK_PARAM_TYPE', 'symbols_allowlist 必須是代號字串陣列');
  }
  for (const key of ['trigger_interval_min_range', 'trigger_up_pct_range', 'trigger_down_pct_range'] as const) {
    const r = next[key];
    if (!Array.isArray(r) || r.length !== 2 || !(r[0] > 0 && r[0] <= r[1])) {
      throw invalidArgs('RISK_PARAM_RANGE', `${key} 必須是 [下限, 上限] 且 0 < 下限 ≤ 上限`);
    }
  }

  db.prepare('INSERT INTO risk_settings (ts, params_json, actor) VALUES (?, ?, ?)').run(
    toTwIso(clock.now()),
    JSON.stringify(next),
    'user',
  );
  return next;
}

// ---------------------------------------------------------------- 費率

export function getFeeSchedule(db: DB, date: string): FeeSchedule {
  const row = db
    .prepare(
      `SELECT * FROM fee_schedules WHERE effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`,
    )
    .get(date) as FeeSchedule | undefined;
  if (!row) throw internalError('FEE_SCHEDULE_MISSING', `找不到 ${date} 適用的費率`);
  return row;
}

export function getFeeScheduleById(db: DB, id: number): FeeSchedule {
  const row = db.prepare('SELECT * FROM fee_schedules WHERE id = ?').get(id) as FeeSchedule | undefined;
  if (!row) throw internalError('FEE_SCHEDULE_MISSING', `找不到費率版本 ${id}`);
  return row;
}

export interface FeeScheduleInput {
  fee_rate_pct: number;
  fee_discount: number;
  rebate_mode: 'instant' | 'monthly';
  min_fee_regular: number;
  min_fee_odd: number;
  tax_stock_pct: number;
  tax_daytrade_pct: number;
  tax_etf_pct: number;
}

function requireFutureDate(effectiveDate: string, clock: Clock): void {
  if (!isValidDate(effectiveDate)) throw invalidArgs('INVALID_DATE', `生效日 ${effectiveDate} 格式錯誤，須為 YYYY-MM-DD`);
  const today = twDate(clock.now());
  if (effectiveDate < today) {
    throw invalidArgs('RETROACTIVE_DATE', `生效日 ${effectiveDate} 早於今天 ${today}，不可回溯`);
  }
}

export function addFeeSchedule(db: DB, input: FeeScheduleInput, effectiveDate: string, clock: Clock): FeeSchedule {
  requireFutureDate(effectiveDate, clock);
  const checks: [string, number, number, number][] = [
    ['fee_rate_pct', input.fee_rate_pct, 0, 1],
    ['fee_discount', input.fee_discount, 0, 1],
    ['min_fee_regular', input.min_fee_regular, 0, 100],
    ['min_fee_odd', input.min_fee_odd, 0, 100],
    ['tax_stock_pct', input.tax_stock_pct, 0, 1],
    ['tax_daytrade_pct', input.tax_daytrade_pct, 0, 1],
    ['tax_etf_pct', input.tax_etf_pct, 0, 1],
  ];
  for (const [name, v, min, max] of checks) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw invalidArgs('FEE_RANGE', `${name} = ${v} 超出合理範圍 ${min} 至 ${max}`);
    }
  }
  if (input.rebate_mode !== 'instant' && input.rebate_mode !== 'monthly') {
    throw invalidArgs('FEE_RANGE', 'rebate_mode 必須是 instant 或 monthly');
  }
  const info = db
    .prepare(
      `INSERT INTO fee_schedules (effective_date, fee_rate_ppm, fee_discount_bp, rebate_mode,
         min_fee_regular, min_fee_odd, tax_stock_ppm, tax_daytrade_ppm, tax_etf_ppm, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?)`,
    )
    .run(
      effectiveDate,
      pctToPpm(input.fee_rate_pct),
      Math.round(input.fee_discount * 10_000),
      input.rebate_mode,
      input.min_fee_regular,
      input.min_fee_odd,
      pctToPpm(input.tax_stock_pct),
      pctToPpm(input.tax_daytrade_pct),
      pctToPpm(input.tax_etf_pct),
      toTwIso(clock.now()),
    );
  return getFeeScheduleById(db, Number(info.lastInsertRowid));
}

// ---------------------------------------------------------------- 市場規則

export function getMarketRules(db: DB, date: string): MarketRules & { id: number } {
  const row = db
    .prepare(
      `SELECT id, rules_json FROM market_rules WHERE effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`,
    )
    .get(date) as { id: number; rules_json: string } | undefined;
  if (!row) throw internalError('MARKET_RULES_MISSING', `找不到 ${date} 適用的市場規則`);
  return { id: row.id, ...(JSON.parse(row.rules_json) as MarketRules) };
}

export function addMarketRules(db: DB, rules: MarketRules, effectiveDate: string, clock: Clock): number {
  requireFutureDate(effectiveDate, clock);
  if (!(rules.price_limit_pct > 0 && rules.price_limit_pct <= 100)) {
    throw invalidArgs('RULES_RANGE', `price_limit_pct = ${rules.price_limit_pct} 超出 0 至 100`);
  }
  for (const [category, table] of Object.entries(rules.tick_sizes)) {
    if (!Array.isArray(table) || table.length === 0 || table.some(([floor, size]) => !(floor >= 0 && size > 0))) {
      throw invalidArgs('RULES_RANGE', `tick_sizes.${category} 格式錯誤`);
    }
  }
  const info = db
    .prepare(`INSERT INTO market_rules (effective_date, rules_json, created_by, created_at) VALUES (?, ?, 'user', ?)`)
    .run(effectiveDate, JSON.stringify(rules), toTwIso(clock.now()));
  return Number(info.lastInsertRowid);
}
