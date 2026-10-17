import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTriggerConfig } from '../core/claude-ops.js';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { getPositions } from '../core/ledger.js';
import { type QuoteSource, valuate } from '../core/market.js';
import { checkLedgerConsistency, recordReconciliation } from '../core/reconcile.js';
import { evaluateEquityHalts } from '../core/risk.js';
import { getMarketRules } from '../core/settings.js';
import { getPause, getState, isTradingDay, pause, recordRiskEvent, setState } from '../core/state.js';
import { type Clock, addDays, toTwIso, twDate, twDayStartIso, twHhmm } from '../core/time.js';

/**
 * 每日例行工作：盤前重設、盤中以權益檢查停機條件、收盤後對帳／快照／備份（規格第 6、8、10、12 節）。
 */

/** 盤前重設的時間：早於 pre_open 觸發，讓 Claude 看到的是重設後的狀態。 */
const DAILY_RESET_AT = '08:00';
const BACKUP_KEEP_DAYS = 30;

export class DailyJobs {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly root: string,
    private readonly clock: Clock,
    private readonly quotes: QuoteSource,
    private readonly log: (msg: string) => void,
  ) {}

  private equity() {
    return valuate(this.db, this.quotes, this.config.symbols);
  }

  /**
   * 每個交易日一次：觸發條件重設為預設值、記錄開盤前權益、重設當日權益高點。
   * 因用量預算用盡而停止的 Claude 在新的一天恢復。
   */
  maybeDailyReset(): boolean {
    const now = this.clock.now();
    const today = twDate(now);
    if (!isTradingDay(this.db, now) || twHhmm(now) < DAILY_RESET_AT) return false;
    if (getState(this.db, 'last_daily_reset') === today) return false;

    const d = this.config.trigger.defaults;
    const { equity } = this.equity();
    this.db.transaction(() => {
      setTriggerConfig(this.db, { interval_min: d.interval_min, price: { up_pct: d.up_pct, down_pct: d.down_pct } }, 'system', this.clock);
      setState(this.db, 'day_start_equity', String(equity), this.clock);
      setState(this.db, 'intraday_peak_equity', String(equity), this.clock);
      if (getState(this.db, 'peak_equity') === null && equity > 0) setState(this.db, 'peak_equity', String(equity), this.clock);
      if (getState(this.db, 'claude_unavailable')?.startsWith('budget_daily')) setState(this.db, 'claude_unavailable', null, this.clock);
      setState(this.db, 'last_daily_reset', today, this.clock);
    })();
    this.log(`每日重設：觸發條件回到預設值，開盤前權益 ${equity} 元`);
    return true;
  }

  /**
   * 盤中以即時權益檢查當日虧損、當日回撤、跨日回撤。有持股缺報價時不檢查，避免以成本估值誤判。
   */
  checkHalts(): void {
    const now = this.clock.now();
    if (!isTradingDay(this.db, now) || getState(this.db, 'last_daily_reset') !== twDate(now)) return;
    const rules = getMarketRules(this.db, twDate(now));
    const time = twHhmm(now);
    if (time < rules.continuous[0] || time >= rules.sessions.regular.accept[1]) return;

    const v = this.equity();
    if (v.stale_symbols.length > 0) return;
    const halt = evaluateEquityHalts(this.db, v.equity, this.clock);
    if (halt && !getPause(this.db).paused) {
      pause(this.db, halt.rule, halt.reason, this.clock);
      this.log(`停機：${halt.reason}`);
    }
  }

  /** 收盤後、復盤觸發之前：對帳、每日快照、備份。每天一次。 */
  async closeOfDay(): Promise<void> {
    const today = twDate(this.clock.now());
    if (getState(this.db, 'last_close_jobs') === today) return;

    const diffs = checkLedgerConsistency(this.db);
    const status = recordReconciliation(this.db, diffs, this.clock);
    if (status === 'error' && !getPause(this.db).paused) {
      pause(this.db, 'reconciliation', `對帳出現 ${diffs.length} 項差異`, this.clock);
      this.log('對帳出現差異，系統暫停');
    }

    this.snapshot();
    try {
      await this.backup(today);
    } catch (e) {
      recordRiskEvent(this.db, 'backup_failed', { error: (e as Error).message }, 'warn', this.clock);
      this.log(`備份失敗：${(e as Error).message}`);
    }
    setState(this.db, 'last_close_jobs', today, this.clock);
  }

  /** 每日收盤快照，並以收盤權益更新歷史權益高點（盤中不更新，規格第 6 節）。 */
  snapshot(): void {
    const now = this.clock.now();
    const today = twDate(now);
    const v = this.equity();
    const dayStart = twDayStartIso(now);

    const sells = this.db
      .prepare(
        `SELECT f.price_x100, f.qty, f.fee, f.tax, COALESCE(p.cost_x100, 0) AS cost_x100
         FROM fills f JOIN orders o ON o.id = f.order_id
         LEFT JOIN position_movements p ON p.fill_id = f.id
         WHERE o.side = 'sell' AND f.ts >= ?`,
      )
      .all(dayStart) as { price_x100: number; qty: number; fee: number; tax: number; cost_x100: number }[];
    // 已實現損益 = 賣出價金 − 手續費 − 稅 − 扣除的成本（cost_x100 為負值）
    const realized = sells.reduce(
      (sum, s) => sum + Math.floor((s.price_x100 * s.qty) / 100) - s.fee - s.tax + Math.round(s.cost_x100 / 100),
      0,
    );
    const feesTax = this.db
      .prepare('SELECT COALESCE(SUM(fee + tax), 0) FROM fills WHERE ts >= ?')
      .pluck()
      .get(dayStart) as number;
    const cost = getPositions(this.db).reduce((sum, p) => sum + p.cost_x100, 0);
    const unrealized = v.market_value - Math.round(cost / 100);

    const prevPeak = Number(getState(this.db, 'peak_equity') ?? 0);
    const peak = Math.max(prevPeak, v.equity);
    setState(this.db, 'peak_equity', String(peak), this.clock);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO daily_snapshots
           (date, cash, reserved, market_value, equity, peak_equity, realized_pnl, unrealized_pnl, fees_tax)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(today, v.cash, v.reserved, v.market_value, v.equity, peak, realized, unrealized, feesTax);
    this.log(`每日快照：權益 ${v.equity} 元，已實現 ${realized} 元，未實現 ${unrealized} 元`);
  }

  /** 備份到 backup/YYYY-MM-DD/<mode>.db，保留 30 天（規格第 12 節）。 */
  async backup(today: string): Promise<void> {
    const dir = join(this.root, 'backup', today);
    mkdirSync(dir, { recursive: true });
    await this.db.backup(join(dir, `${this.config.mode}.db`));

    const cutoff = addDays(today, -BACKUP_KEEP_DAYS);
    const base = join(this.root, 'backup');
    if (!existsSync(base)) return;
    for (const name of readdirSync(base)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) rmSync(join(base, name), { recursive: true, force: true });
    }
  }

  /** 用量預算（規格第 11 節）：達 80% 警示，達 100% 停止呼叫 Claude。回傳是否可以呼叫。 */
  checkBudget(): { ok: boolean; reason?: string } {
    const now = this.clock.now();
    const sum = (since: string) =>
      this.db
        .prepare('SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) FROM usage_log WHERE ts >= ?')
        .pluck()
        .get(since) as number;
    const daily = sum(twDayStartIso(now));
    const weekly = sum(toTwIso(new Date(now.getTime() - 7 * 24 * 3600_000)));
    const { daily_budget_tokens: dBudget, weekly_budget_tokens: wBudget } = this.config.usage;

    if (daily >= dBudget) return { ok: false, reason: `budget_daily：今日已用 ${daily} tokens，達每日預算 ${dBudget}` };
    if (weekly >= wBudget) return { ok: false, reason: `budget_weekly：近 7 日已用 ${weekly} tokens，達每週預算 ${wBudget}` };
    const warn = daily >= dBudget * 0.8 || weekly >= wBudget * 0.8;
    setState(this.db, 'usage_warning', warn ? `今日 ${daily}/${dBudget}、近 7 日 ${weekly}/${wBudget} tokens` : null, this.clock);
    return { ok: true };
  }
}
