import type { Session } from './config.js';
import type { DB } from './db.js';
import { invalidArgs } from './errors.js';
import { getMarketRules } from './settings.js';
import { type Clock, toTwIso, twDate, twHhmm, twWeekday } from './time.js';

export type Actor = 'claude' | 'user' | 'system';

// ---------------------------------------------------------------- system_state

export function getState(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setState(db: DB, key: string, value: string | null, clock: Clock): void {
  db.prepare(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, toTwIso(clock.now()));
}

export function recordRiskEvent(db: DB, rule: string, detail: unknown, action: string, clock: Clock): void {
  db.prepare('INSERT INTO risk_events (ts, rule, detail_json, action) VALUES (?, ?, ?, ?)').run(
    toTwIso(clock.now()),
    rule,
    JSON.stringify(detail ?? null),
    action,
  );
}

export function audit(db: DB, actor: string, command: string, args: unknown, result: string, clock: Clock): void {
  db.prepare('INSERT INTO audit_log (ts, actor, command, args_json, result) VALUES (?, ?, ?, ?, ?)').run(
    toTwIso(clock.now()),
    actor,
    command,
    JSON.stringify(args ?? null),
    result,
  );
}

// ---------------------------------------------------------------- 暫停與恢復（規格第 6 節）

export interface PauseInfo {
  paused: boolean;
  reason: string | null;
  /** 觸發暫停的規則，例如 max_drawdown；使用者手動暫停為 manual。 */
  rule: string | null;
  since: string | null;
}

export function getPause(db: DB): PauseInfo {
  return {
    paused: getState(db, 'paused') === '1',
    reason: getState(db, 'pause_reason'),
    rule: getState(db, 'pause_rule'),
    since: getState(db, 'paused_at'),
  };
}

export function pause(db: DB, rule: string, reason: string, clock: Clock): void {
  db.transaction(() => {
    setState(db, 'paused', '1', clock);
    setState(db, 'pause_reason', reason, clock);
    setState(db, 'pause_rule', rule, clock);
    setState(db, 'paused_at', toTwIso(clock.now()), clock);
    recordRiskEvent(db, rule, { reason }, 'pause', clock);
  })();
}

/**
 * 恢復交易。因跨日回撤暫停時必須重設歷史權益高點，否則一恢復就會再次停機（規格第 6 節）。
 * currentEquity 由呼叫端以當下行情計算後傳入。
 */
export function resume(db: DB, opts: { resetPeak: boolean; currentEquity?: number }, clock: Clock): void {
  const info = getPause(db);
  if (!info.paused) throw invalidArgs('NOT_PAUSED', '系統目前沒有暫停');
  if (info.rule === 'max_drawdown' && !opts.resetPeak) {
    throw invalidArgs(
      'RESET_PEAK_REQUIRED',
      '系統因跨日累計回撤暫停，恢復時必須加上 --reset-peak，以目前權益重設歷史權益高點',
    );
  }
  if (opts.resetPeak && opts.currentEquity === undefined) {
    throw invalidArgs('EQUITY_REQUIRED', '重設高點需要目前權益');
  }
  db.transaction(() => {
    if (opts.resetPeak && opts.currentEquity !== undefined) {
      const before = getState(db, 'peak_equity');
      setState(db, 'peak_equity', String(opts.currentEquity), clock);
      recordRiskEvent(db, 'peak_reset', { before: before && Number(before), after: opts.currentEquity }, 'adjust', clock);
    }
    setState(db, 'paused', '0', clock);
    setState(db, 'pause_reason', null, clock);
    setState(db, 'pause_rule', null, clock);
    setState(db, 'paused_at', null, clock);
  })();
}

// ---------------------------------------------------------------- 交易日與時段（規格第 8 節）

export function isHoliday(db: DB, date: string): boolean {
  return !!db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date);
}

export function isTradingDay(db: DB, d: Date): boolean {
  const weekday = twWeekday(d);
  if (weekday === 0 || weekday === 6) return false;
  return !isHoliday(db, twDate(d));
}

export function addHoliday(db: DB, date: string, reason: string | null): void {
  db.prepare(
    `INSERT INTO holidays (date, reason, source) VALUES (?, ?, 'user')
     ON CONFLICT(date) DO UPDATE SET reason = excluded.reason, source = 'user'`,
  ).run(date, reason);
}

/** 目前所在的交易時段，以及每個盤別此刻是否接受委託。 */
export function sessionStatus(db: DB, clock: Clock): { tradingDay: boolean; time: string; open: Record<Session, boolean> } {
  const now = clock.now();
  const tradingDay = isTradingDay(db, now);
  const rules = getMarketRules(db, twDate(now));
  const time = twHhmm(now);
  const within = (s: Session) => {
    const [start, end] = rules.sessions[s].accept;
    return tradingDay && time >= start && time < end;
  };
  return {
    tradingDay,
    time,
    open: { regular: within('regular'), odd_intraday: within('odd_intraday'), odd_after: within('odd_after') },
  };
}
