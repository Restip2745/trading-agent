import type { DB } from './db.js';
import { type Clock, toTwIso, twDate } from './time.js';

export interface ReconDiff {
  check: string;
  severity: 'error' | 'warning';
  detail: Record<string, unknown>;
}

/**
 * 帳本內部一致性檢查（規格第 12 節 paper 模式）。live 模式另外比對券商資料，
 * 那部分在券商轉接層完成後加入。
 */
export function checkLedgerConsistency(db: DB): ReconDiff[] {
  const diffs: ReconDiff[] = [];

  // 委託的已成交股數 = 成交明細加總
  const fillMismatch = db
    .prepare(
      `SELECT o.id, o.filled_qty, COALESCE(SUM(f.qty), 0) AS fills_qty
       FROM orders o LEFT JOIN fills f ON f.order_id = o.id
       GROUP BY o.id HAVING o.filled_qty <> COALESCE(SUM(f.qty), 0)`,
    )
    .all();
  for (const row of fillMismatch) diffs.push({ check: 'order_filled_qty', severity: 'error', detail: row as Record<string, unknown> });

  // 每筆成交都有對應的資金與持股流水
  const orphanFills = db
    .prepare(
      `SELECT f.id FROM fills f
       WHERE NOT EXISTS (SELECT 1 FROM cash_movements c WHERE c.fill_id = f.id AND c.type IN ('buy', 'sell'))
          OR NOT EXISTS (SELECT 1 FROM position_movements p WHERE p.fill_id = f.id)`,
    )
    .pluck()
    .all();
  if (orphanFills.length > 0) diffs.push({ check: 'fill_without_movements', severity: 'error', detail: { fill_ids: orphanFills } });

  // 持股不可為負，出清後不可殘留成本
  const badPositions = db
    .prepare(
      `SELECT symbol, SUM(qty) AS qty, SUM(cost_x100) AS cost_x100 FROM position_movements
       GROUP BY symbol HAVING SUM(qty) < 0 OR (SUM(qty) = 0 AND SUM(cost_x100) <> 0)`,
    )
    .all();
  for (const row of badPositions) diffs.push({ check: 'position_invalid', severity: 'error', detail: row as Record<string, unknown> });

  // 圈存與可賣股數不可為負
  const balance = db.prepare('SELECT cash, reserved, available FROM v_balance').get() as Record<string, number>;
  if ((balance.reserved ?? 0) < 0) diffs.push({ check: 'reserved_negative', severity: 'error', detail: balance });
  if ((balance.cash ?? 0) < 0) diffs.push({ check: 'cash_negative', severity: 'warning', detail: balance });
  const oversold = db.prepare('SELECT symbol, qty, sellable_qty FROM v_positions WHERE sellable_qty < 0').all();
  for (const row of oversold) diffs.push({ check: 'sellable_negative', severity: 'error', detail: row as Record<string, unknown> });

  // 已結束的買單不應保留圈存：v_reserved 只計未完成委託，這裡確認沒有未完成卻已全部成交的委託
  const stuck = db
    .prepare(`SELECT id, status, qty, filled_qty FROM orders WHERE status IN ('submitted', 'partial') AND filled_qty = qty`)
    .all();
  for (const row of stuck) diffs.push({ check: 'order_status_stale', severity: 'error', detail: row as Record<string, unknown> });

  return diffs;
}

export function recordReconciliation(db: DB, diffs: ReconDiff[], clock: Clock): 'ok' | 'warning' | 'error' {
  const status = diffs.some((d) => d.severity === 'error') ? 'error' : diffs.length > 0 ? 'warning' : 'ok';
  db.prepare('INSERT INTO reconciliation_runs (date, ts, status, diffs_json) VALUES (?, ?, ?, ?)').run(
    twDate(clock.now()),
    toTwIso(clock.now()),
    status,
    JSON.stringify(diffs),
  );
  return status;
}
