import { getTriggerConfig } from './claude-ops.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { getPositions } from './ledger.js';
import { type QuoteSource, valuate } from './market.js';
import { formatPrice } from './money.js';
import { getRiskParams } from './settings.js';
import { getPause, getState, sessionStatus } from './state.js';
import { type Clock, twDayStartIso } from './time.js';

/**
 * ctrade status 與 daemon 提示範本共用的狀態摘要（規格第 5、8 節）。
 */
export function buildStatus(db: DB, config: Config, clock: Clock, quotes: QuoteSource) {
  const now = clock.now();
  const dayStart = twDayStartIso(now);
  const valuation = valuate(db, quotes, config.symbols);
  const session = sessionStatus(db, clock);
  const pause = getPause(db);
  const trigger = getTriggerConfig(db);
  const ordersToday = db
    .prepare(`SELECT COUNT(*) FROM orders WHERE origin = 'claude' AND created_at >= ?`)
    .pluck()
    .get(dayStart) as number;
  const openOrders = db
    .prepare(`SELECT COUNT(*) FROM orders WHERE status IN ('pending_submit', 'submitted', 'partial', 'unknown')`)
    .pluck()
    .get() as number;
  const usage = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens FROM usage_log WHERE ts >= ?`,
    )
    .get(dayStart);
  const dayStartEquity = getState(db, 'day_start_equity');

  return {
    paused: pause.paused,
    pause_reason: pause.reason,
    claude_unavailable: getState(db, 'claude_unavailable'),
    trading_day: session.tradingDay,
    time: session.time,
    sessions_open: session.open,
    cash: valuation.cash,
    reserved: valuation.reserved,
    available: valuation.available,
    market_value: valuation.market_value,
    equity: valuation.equity,
    day_start_equity: dayStartEquity === null ? null : Number(dayStartEquity),
    pnl_today: dayStartEquity === null ? null : valuation.equity - Number(dayStartEquity),
    gross_exposure: valuation.gross_exposure,
    net_exposure: valuation.net_exposure,
    valued_at_cost: valuation.stale_symbols,
    positions: getPositions(db)
      .filter((p) => p.qty > 0)
      .map((p) => {
        const q = quotes.getQuote(p.symbol);
        return {
          symbol: p.symbol,
          qty: p.qty,
          sellable_qty: p.sellable_qty,
          avg_cost: formatPrice(p.avg_cost_x100),
          last: q ? formatPrice(q.last_x100) : null,
          unrealized_pnl: q ? Math.floor((q.last_x100 * p.qty - p.cost_x100) / 100) : null,
        };
      }),
    open_orders: openOrders,
    orders_today: ordersToday,
    max_orders_per_day: getRiskParams(db).max_orders_per_day,
    trigger: {
      interval_min: trigger.interval_min ?? 'off',
      up_pct: trigger.up_pct ?? 'off',
      down_pct: trigger.down_pct ?? 'off',
    },
    usage_today: usage,
  };
}

export type StatusSummary = ReturnType<typeof buildStatus>;
