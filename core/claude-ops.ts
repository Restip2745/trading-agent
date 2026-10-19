import type { DB } from './db.js';
import { invalidArgs, riskRejected } from './errors.js';
import { getPositions } from './ledger.js';
import { formatPrice } from './money.js';
import { getRiskParams } from './settings.js';
import type { Actor } from './state.js';
import { type Clock, toTwIso } from './time.js';

/**
 * Claude 透過 ctrade 可以寫入的三種資料：觸發條件、決策記錄、硬停損停利價。
 */

// ---------------------------------------------------------------- 觸發條件（規格第 8 節）

export interface TriggerConfig {
  interval_min: number | null;
  up_pct: number | null;
  down_pct: number | null;
  set_by: Actor;
  set_at: string;
}

export function getTriggerConfig(db: DB): TriggerConfig {
  return db
    .prepare('SELECT interval_min, up_pct, down_pct, set_by, set_at FROM trigger_config ORDER BY id DESC LIMIT 1')
    .get() as TriggerConfig;
}

export interface TriggerPatch {
  /** null = 關閉 */
  interval_min?: number | null;
  /** price: null = 關閉價格觸發（up 與 down 一起） */
  price?: { up_pct: number; down_pct: number } | null;
}

export function setTriggerConfig(db: DB, patch: TriggerPatch, actor: Actor, clock: Clock): TriggerConfig {
  const risk = getRiskParams(db);
  const current = getTriggerConfig(db);
  const next = { interval_min: current.interval_min, up_pct: current.up_pct, down_pct: current.down_pct };

  const inRange = (name: string, v: number, [min, max]: [number, number], unit: string) => {
    if (!Number.isFinite(v) || v < min || v > max) {
      throw riskRejected('TRIGGER_OUT_OF_RANGE', `${name} = ${v}${unit} 超出允許範圍 ${min} 至 ${max}${unit}`, {
        name,
        value: v,
        range: [min, max],
      });
    }
  };

  if (patch.interval_min !== undefined) {
    if (patch.interval_min !== null) {
      if (!Number.isInteger(patch.interval_min)) throw invalidArgs('INVALID_INTERVAL', 'interval 必須是整數分鐘或 off');
      inRange('interval', patch.interval_min, risk.trigger_interval_min_range, ' 分鐘');
    }
    next.interval_min = patch.interval_min;
  }
  if (patch.price !== undefined) {
    if (patch.price === null) {
      next.up_pct = null;
      next.down_pct = null;
    } else {
      inRange('up', patch.price.up_pct, risk.trigger_up_pct_range, '%');
      inRange('down', patch.price.down_pct, risk.trigger_down_pct_range, '%');
      next.up_pct = patch.price.up_pct;
      next.down_pct = patch.price.down_pct;
    }
  }

  if (next.interval_min === null && next.up_pct === null) {
    throw riskRejected('TRIGGER_ALL_OFF', '定時觸發與價格觸發至少要開一種');
  }
  if (next.up_pct === null && getPositions(db).some((p) => p.qty > 0)) {
    throw riskRejected('PRICE_TRIGGER_REQUIRED', '目前有持股，價格觸發不能關閉');
  }

  db.prepare(
    'INSERT INTO trigger_config (interval_min, up_pct, down_pct, set_by, set_at) VALUES (?, ?, ?, ?, ?)',
  ).run(next.interval_min, next.up_pct, next.down_pct, actor, toTwIso(clock.now()));
  return getTriggerConfig(db);
}

// ---------------------------------------------------------------- 決策記錄

export interface JournalInput {
  reasoning: string;
  actions: string;
  triggerEventId?: number;
  model?: string;
  strategyVersion?: string;
}

const MAX_REASONING = 20_000;

export function addJournal(db: DB, input: JournalInput, clock: Clock): number {
  const reasoning = input.reasoning.trim();
  if (!reasoning) throw invalidArgs('EMPTY_REASONING', '決策理由不能為空');
  if (reasoning.length > MAX_REASONING) {
    throw invalidArgs('REASONING_TOO_LONG', `決策理由 ${reasoning.length} 字超過上限 ${MAX_REASONING} 字`);
  }
  const trigger = db.prepare('SELECT interval_min, up_pct, down_pct FROM trigger_config ORDER BY id DESC LIMIT 1').get();
  const info = db
    .prepare(
      `INSERT INTO decisions (trigger_event_id, ts, model, reasoning, actions_json, next_trigger_json, strategy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.triggerEventId ?? null,
      toTwIso(clock.now()),
      input.model ?? null,
      reasoning,
      JSON.stringify(input.actions),
      JSON.stringify(trigger ?? null),
      input.strategyVersion ?? null,
    );
  return Number(info.lastInsertRowid);
}

/**
 * 補上決策當下的指標快照（ctrade indicators 的輸出）。決策已經先寫入，
 * 這裡失敗不影響決策記錄本身；取不到快照時只記原因。
 */
export function attachIndicatorSnapshot(db: DB, decisionId: number, snapshot: { indicators: unknown } | { error: string }): void {
  db.prepare('UPDATE decisions SET indicators_json = ?, indicators_error = ? WHERE id = ?').run(
    'indicators' in snapshot ? JSON.stringify(snapshot.indicators) : null,
    'error' in snapshot ? snapshot.error : null,
    decisionId,
  );
}

// ---------------------------------------------------------------- 硬停損停利（規格第 6 節）

export interface ProtectiveStop {
  symbol: string;
  stop_x100: number | null;
  take_profit_x100: number | null;
  set_by: Actor;
  ts: string;
}

/** 每檔目前生效的停損停利價。已出清的持股不列出（自動失效）。 */
export function getStops(db: DB): ProtectiveStop[] {
  const held = new Set(getPositions(db).filter((p) => p.qty > 0).map((p) => p.symbol));
  const rows = db
    .prepare(
      `SELECT s.symbol, s.stop_x100, s.take_profit_x100, s.set_by, s.ts FROM protective_stops s
       WHERE s.id = (SELECT MAX(id) FROM protective_stops WHERE symbol = s.symbol) ORDER BY s.symbol`,
    )
    .all() as ProtectiveStop[];
  return rows.filter((r) => held.has(r.symbol));
}

export interface StopPatch {
  symbol: string;
  stopX100?: number;
  takeProfitX100?: number;
  actor: Actor;
  reason?: string;
}

/**
 * 設定硬停損停利價。Claude 設定的停損價只能上調（避免虧損時一路放寬）；
 * 系統（除權息調整）與使用者不受此限（規格第 6、16 節）。
 */
export function setStop(db: DB, patch: StopPatch, clock: Clock): ProtectiveStop {
  if (patch.stopX100 === undefined && patch.takeProfitX100 === undefined) {
    throw invalidArgs('STOP_EMPTY', '至少要指定 --stop 或 --take-profit');
  }
  const pos = getPositions(db).find((p) => p.symbol === patch.symbol);
  if (!pos || pos.qty <= 0) throw invalidArgs('NO_POSITION', `帳本沒有 ${patch.symbol} 的持股，無法設定停損停利`);

  const current = getStops(db).find((s) => s.symbol === patch.symbol);
  const stop = patch.stopX100 ?? current?.stop_x100 ?? null;
  const takeProfit = patch.takeProfitX100 ?? current?.take_profit_x100 ?? null;

  if (patch.actor === 'claude' && patch.stopX100 !== undefined && current?.stop_x100 != null && patch.stopX100 < current.stop_x100) {
    throw riskRejected(
      'STOP_CANNOT_LOWER',
      `停損價只能上調：目前 ${formatPrice(current.stop_x100)}，不能改為 ${formatPrice(patch.stopX100)}`,
      { current: formatPrice(current.stop_x100) },
    );
  }
  if (stop !== null && takeProfit !== null && stop >= takeProfit) {
    throw invalidArgs('STOP_ABOVE_TAKE_PROFIT', `停損價 ${formatPrice(stop)} 必須低於停利價 ${formatPrice(takeProfit)}`);
  }

  const ts = toTwIso(clock.now());
  db.prepare(
    'INSERT INTO protective_stops (ts, symbol, stop_x100, take_profit_x100, set_by, reason) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ts, patch.symbol, stop, takeProfit, patch.actor, patch.reason ?? null);
  return { symbol: patch.symbol, stop_x100: stop, take_profit_x100: takeProfit, set_by: patch.actor, ts };
}
