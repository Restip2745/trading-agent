import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { invalidArgs, riskRejected } from './errors.js';
import { costToRemove, getPosition, insertCash, insertPosition } from './ledger.js';
import { buyReservation, calcFee, calcTax, tradeValue } from './money.js';
import { type OrderRequest, type RiskContext, checkOrder, countRecentRequests } from './risk.js';
import { getFeeSchedule, getRiskParams } from './settings.js';
import { type Actor, isHoliday } from './state.js';
import { type Clock, addDays, toTwIso, twDate, twDayStartIso } from './time.js';

export type OrderStatus =
  | 'pending_submit'
  | 'submitted'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'unknown';

export interface OrderRow {
  id: number;
  client_order_id: string;
  broker_order_id: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  session: OrderRequest['session'];
  origin: OrderRequest['origin'];
  price_x100: number;
  qty: number;
  filled_qty: number;
  status: OrderStatus;
  reserved_amount: number;
  decision_id: number | null;
  strategy_version: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  reject_reason: string | null;
}

export const OPEN_STATUSES: readonly OrderStatus[] = ['pending_submit', 'submitted', 'partial', 'unknown'];
const FINAL_STATUSES: readonly OrderStatus[] = ['filled', 'cancelled', 'rejected', 'expired'];

export function getOrder(db: DB, id: number): OrderRow {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  if (!row) throw invalidArgs('ORDER_NOT_FOUND', `找不到委託編號 ${id}`);
  return row;
}

export function listOrders(db: DB, opts: { open?: boolean; date?: string }): OrderRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.open) where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), params.push(...OPEN_STATUSES);
  if (opts.date) where.push('substr(created_at, 1, 10) = ?'), params.push(opts.date);
  const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  return db.prepare(sql).all(...params) as OrderRow[];
}

/**
 * 建立委託：在同一個 IMMEDIATE 交易中完成風控檢查、寫入 pending_submit 與圈存（規格第 12、17 節）。
 * 送單由呼叫端（daemon 的券商或模擬撮合轉接層）完成後，再呼叫 markSubmitted 等函式更新狀態。
 */
export function createOrder(
  db: DB,
  req: OrderRequest,
  ctx: RiskContext,
  meta: { decisionId?: number; strategyVersion?: string } = {},
): OrderRow {
  return db.transaction(() => {
    checkOrder(db, req, ctx);
    const now = toTwIso(ctx.clock.now());
    const reserved =
      req.side === 'buy'
        ? buyReservation(req.priceX100, req.qty, req.session, getFeeSchedule(db, twDate(ctx.clock.now())))
        : 0;
    const info = db
      .prepare(
        `INSERT INTO orders (client_order_id, symbol, side, session, origin, price_x100, qty, status,
           reserved_amount, decision_id, strategy_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_submit', ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        req.symbol,
        req.side,
        req.session,
        req.origin,
        req.priceX100,
        req.qty,
        reserved,
        meta.decisionId ?? null,
        meta.strategyVersion ?? null,
        now,
        now,
      );
    return getOrder(db, Number(info.lastInsertRowid));
  }).immediate();
}

function transition(db: DB, id: number, from: readonly OrderStatus[], to: OrderStatus, extra: Record<string, unknown>, clock: Clock): OrderRow {
  const order = getOrder(db, id);
  if (!from.includes(order.status)) {
    throw invalidArgs('INVALID_ORDER_STATE', `委託 ${id} 目前為 ${order.status}，不能改為 ${to}`);
  }
  const sets = ['status = ?', 'updated_at = ?', ...Object.keys(extra).map((k) => `${k} = ?`)];
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(
    to,
    toTwIso(clock.now()),
    ...Object.values(extra),
    id,
  );
  return getOrder(db, id);
}

export const markSubmitted = (db: DB, id: number, brokerOrderId: string | null, clock: Clock) =>
  transition(db, id, ['pending_submit', 'unknown'], 'submitted', { broker_order_id: brokerOrderId }, clock);

export const markRejected = (db: DB, id: number, reason: string, clock: Clock) =>
  transition(db, id, ['pending_submit', 'unknown', 'submitted'], 'rejected', { reject_reason: reason }, clock);

/** 送出逾時或連線中斷、無法確定結果（規格第 17 節）。同一 client_order_id 永不重送。 */
export const markUnknown = (db: DB, id: number, clock: Clock) =>
  transition(db, id, ['pending_submit'], 'unknown', {}, clock);

/** 記錄刪單請求的時間，計入每分鐘送單次數。實際狀態等券商回報後由 markCancelled 更新。 */
export function requestCancel(db: DB, id: number, clock: Clock): OrderRow {
  const order = getOrder(db, id);
  if (!OPEN_STATUSES.includes(order.status) || order.status === 'unknown') {
    throw invalidArgs('ORDER_NOT_CANCELLABLE', `委託 ${id} 目前為 ${order.status}，無法刪單`);
  }
  db.prepare('UPDATE orders SET cancel_requested_at = ?, updated_at = ? WHERE id = ?').run(
    toTwIso(clock.now()),
    toTwIso(clock.now()),
    id,
  );
  return getOrder(db, id);
}

/**
 * Claude 透過 ctrade 刪單：只能刪自己的委託（不能刪 daemon 的停損單），
 * 刪單計入每分鐘送單次數（規格第 6 節第 12 條），暫停中仍允許刪單。
 */
export function requestCancelByClaude(db: DB, id: number, clock: Clock): OrderRow {
  return db.transaction(() => {
    const order = getOrder(db, id);
    if (order.origin !== 'claude') {
      throw invalidArgs('ORDER_NOT_OWNED', `委託 ${id} 是 ${order.origin === 'stop' ? 'daemon 的硬停損停利單' : '使用者的緊急操作'}，不能由 ctrade 刪除`);
    }
    const limit = getRiskParams(db).max_orders_per_minute;
    const recent = countRecentRequests(db, clock.now());
    if (recent >= limit) {
      throw riskRejected('RATE_LIMIT', `最近一分鐘已送出 ${recent} 筆新單或刪單，達每分鐘上限 ${limit} 筆，請稍後再試`, {
        recent,
        limit,
      });
    }
    return requestCancel(db, id, clock);
  }).immediate();
}

/** 刪單成功或時段結束。剩餘數量不再成交，圈存由 v_reserved 依狀態自動釋放。 */
export const markCancelled = (db: DB, id: number, clock: Clock) =>
  transition(db, id, OPEN_STATUSES, 'cancelled', {}, clock);

/** 時段結束仍未成交的委託轉為 expired 並釋放圈存（規格第 7 節）。回傳轉換的筆數。 */
export function expireOpenOrders(db: DB, session: OrderRequest['session'], clock: Clock): number {
  const now = toTwIso(clock.now());
  return db
    .prepare(
      `UPDATE orders SET status = 'expired', updated_at = ?
       WHERE session = ? AND status IN ('submitted', 'partial')`,
    )
    .run(now, session).changes;
}

/** 前一交易日（或更早）留下的未完成委託一律到期。台股委託只在當日有效（ROD）。 */
export function expireStaleOrders(db: DB, today: string, clock: Clock): number {
  return db
    .prepare(
      `UPDATE orders SET status = 'expired', updated_at = ?
       WHERE status IN ('submitted', 'partial') AND substr(created_at, 1, 10) < ?`,
    )
    .run(toTwIso(clock.now()), today).changes;
}

// ---------------------------------------------------------------- 成交

/** T+N 交割日，跳過週末與休市日。 */
export function settleDate(db: DB, tradeDate: string, days = 2): string {
  let d = tradeDate;
  let n = 0;
  while (n < days) {
    d = addDays(d, 1);
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !isHoliday(db, d)) n++;
  }
  return d;
}

export interface FillInput {
  orderId: number;
  priceX100: number;
  qty: number;
  ts: string;
  brokerFillId?: string;
  /** live 模式以券商回報的費用為準；未提供時依費率計算 */
  fee?: number;
  tax?: number;
  simulated?: boolean;
  /** 標的類別，決定稅率 */
  category: 'stock' | 'etf';
}

export interface FillResult {
  fillId: number;
  fee: number;
  tax: number;
  dayTrade: boolean;
  order: OrderRow;
}

/**
 * 寫入一筆成交並更新帳本：fills、cash_movements（價金、手續費、稅）、position_movements、
 * orders.filled_qty 與狀態，全部在同一個交易中完成。
 */
export function applyFill(db: DB, input: FillInput, clock: Clock): FillResult {
  return db.transaction(() => {
    const order = getOrder(db, input.orderId);
    if (FINAL_STATUSES.includes(order.status) && order.status !== 'cancelled' && order.status !== 'expired') {
      throw invalidArgs('ORDER_CLOSED', `委託 ${order.id} 已是 ${order.status}，不能再寫入成交`);
    }
    if (!Number.isInteger(input.qty) || input.qty <= 0 || order.filled_qty + input.qty > order.qty) {
      throw invalidArgs(
        'FILL_EXCEEDS_ORDER',
        `成交 ${input.qty} 股超過委託剩餘 ${order.qty - order.filled_qty} 股（委託 ${order.id}）`,
      );
    }
    if (order.side === 'buy' && input.priceX100 > order.price_x100) {
      throw invalidArgs('FILL_PRICE_ABOVE_LIMIT', `買進成交價 ${input.priceX100} 高於委託限價 ${order.price_x100}`);
    }
    if (order.side === 'sell' && input.priceX100 < order.price_x100) {
      throw invalidArgs('FILL_PRICE_BELOW_LIMIT', `賣出成交價 ${input.priceX100} 低於委託限價 ${order.price_x100}`);
    }

    // 行情來源的時間可能是 UTC（Z）格式；一律轉成台灣時間再入帳，交易日與交割日才不會錯
    if (Number.isNaN(Date.parse(input.ts))) throw invalidArgs('INVALID_TS', `成交時間 ${input.ts} 格式錯誤`);
    const ts = toTwIso(new Date(input.ts));
    const tradeDate = twDate(new Date(input.ts));
    const schedule = getFeeSchedule(db, tradeDate);
    const value = tradeValue(input.priceX100, input.qty);
    const fee = input.fee ?? calcFee(value, order.session, schedule);
    const dayTrade = order.side === 'sell' && isDayTradeSell(db, order.symbol, input.qty, ts);
    const tax = order.side === 'sell' ? (input.tax ?? calcTax(value, input.category, dayTrade, schedule)) : 0;

    const fillInfo = db
      .prepare(
        `INSERT INTO fills (order_id, broker_fill_id, ts, price_x100, qty, fee, tax, day_trade, fee_schedule_id, settle_date, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        input.brokerFillId ?? null,
        ts,
        input.priceX100,
        input.qty,
        fee,
        tax,
        dayTrade ? 1 : 0,
        schedule.id,
        settleDate(db, tradeDate),
        input.simulated ? 1 : 0,
      );
    const fillId = Number(fillInfo.lastInsertRowid);
    const actor: Actor = order.origin === 'claude' ? 'claude' : 'system';
    const base = { ts, orderId: order.id, fillId, actor };

    if (order.side === 'buy') {
      insertCash(db, { ...base, type: 'buy', amount: -value });
      insertCash(db, { ...base, type: 'fee', amount: -fee });
      // 平均成本含買進手續費（規格第 4 節）
      insertPosition(db, {
        ts,
        symbol: order.symbol,
        type: 'buy',
        qty: input.qty,
        costX100: (value + fee) * 100,
        actor,
        fillId,
      });
    } else {
      const pos = getPosition(db, order.symbol);
      insertCash(db, { ...base, type: 'sell', amount: value });
      insertCash(db, { ...base, type: 'fee', amount: -fee });
      if (tax > 0) insertCash(db, { ...base, type: 'tax', amount: -tax });
      insertPosition(db, {
        ts,
        symbol: order.symbol,
        type: 'sell',
        qty: -input.qty,
        costX100: -costToRemove(pos, input.qty),
        actor,
        fillId,
      });
    }

    const filled = order.filled_qty + input.qty;
    const status: OrderStatus =
      filled === order.qty ? 'filled' : order.status === 'cancelled' || order.status === 'expired' ? order.status : 'partial';
    db.prepare('UPDATE orders SET filled_qty = ?, status = ?, updated_at = ? WHERE id = ?').run(
      filled,
      status,
      toTwIso(clock.now()),
      order.id,
    );

    return { fillId, fee, tax, dayTrade, order: getOrder(db, order.id) };
  }).immediate();
}

/**
 * 這筆賣出是否為現股當沖：當日買進成交、尚未於當日賣出的股數足以涵蓋這次賣出。
 * 部分涵蓋時保守視為非當沖（一般股票稅率較高，不會低估成本）。
 */
export function isDayTradeSell(db: DB, symbol: string, qty: number, ts: string): boolean {
  const dayStart = twDayStartIso(new Date(ts));
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN o.side = 'buy' THEN f.qty ELSE 0 END), 0) AS bought,
         COALESCE(SUM(CASE WHEN o.side = 'sell' THEN f.qty ELSE 0 END), 0) AS sold
       FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE o.symbol = ? AND f.ts >= ? AND f.ts <= ?`,
    )
    .get(symbol, dayStart, ts) as { bought: number; sold: number };
  return row.bought - row.sold >= qty;
}

export function listFills(db: DB, opts: { date?: string; orderId?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.date) where.push('substr(f.ts, 1, 10) = ?'), params.push(opts.date);
  if (opts.orderId !== undefined) where.push('f.order_id = ?'), params.push(opts.orderId);
  const sql = `SELECT f.*, o.symbol, o.side, o.session FROM fills f JOIN orders o ON o.id = f.order_id
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.ts, f.id`;
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

