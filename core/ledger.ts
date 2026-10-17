import type { DB } from './db.js';
import { invalidArgs, riskRejected } from './errors.js';
import { formatPrice } from './money.js';
import type { Actor } from './state.js';
import { type Clock, toTwIso } from './time.js';

/**
 * 影子帳本：資金與持股流水。餘額與持倉一律由流水推導（規格第 4 節）。
 */

export interface Balance {
  cash: number;
  reserved: number;
  available: number;
}

export interface Position {
  symbol: string;
  qty: number;
  /** 總成本（分），含買進手續費 */
  cost_x100: number;
  /** 移動平均成本（分／股，四捨五入，僅供顯示） */
  avg_cost_x100: number;
  pending_sell_qty: number;
  sellable_qty: number;
}

export function getBalance(db: DB): Balance {
  return db.prepare('SELECT cash, reserved, available FROM v_balance').get() as Balance;
}

export function getPositions(db: DB): Position[] {
  const rows = db
    .prepare('SELECT symbol, qty, cost_x100, pending_sell_qty, sellable_qty FROM v_positions ORDER BY symbol')
    .all() as Omit<Position, 'avg_cost_x100'>[];
  return rows.map((r) => ({ ...r, avg_cost_x100: r.qty > 0 ? Math.round(r.cost_x100 / r.qty) : 0 }));
}

export function getPosition(db: DB, symbol: string): Position {
  return (
    getPositions(db).find((p) => p.symbol === symbol) ?? {
      symbol,
      qty: 0,
      cost_x100: 0,
      avg_cost_x100: 0,
      pending_sell_qty: 0,
      sellable_qty: 0,
    }
  );
}

/**
 * 賣出或轉出 qty 股時要扣除的成本（分）。移動平均法：依比例扣除，
 * 全部出清時扣除剩餘全部成本，避免留下捨入殘值。
 */
export function costToRemove(position: Position, qty: number): number {
  if (qty >= position.qty) return position.cost_x100;
  return Math.round((position.cost_x100 * qty) / position.qty);
}

function requirePositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw invalidArgs('INVALID_AMOUNT', `${name} 必須是正整數，目前為 ${v}`);
}

export function insertCash(
  db: DB,
  m: { ts: string; type: string; amount: number; actor: Actor; orderId?: number; fillId?: number; note?: string },
): number {
  const info = db
    .prepare(
      `INSERT INTO cash_movements (ts, type, amount, order_id, fill_id, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.ts, m.type, m.amount, m.orderId ?? null, m.fillId ?? null, m.actor, m.note ?? null);
  return Number(info.lastInsertRowid);
}

export function insertPosition(
  db: DB,
  m: { ts: string; symbol: string; type: string; qty: number; costX100: number; actor: Actor; fillId?: number; note?: string },
): number {
  const info = db
    .prepare(
      `INSERT INTO position_movements (ts, symbol, type, qty, cost_x100, fill_id, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.ts, m.symbol, m.type, m.qty, m.costX100, m.fillId ?? null, m.actor, m.note ?? null);
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------- 資金撥入撥出

export function allocate(db: DB, amount: number, actor: Actor, note: string | undefined, clock: Clock): Balance {
  requirePositiveInt('撥入金額', amount);
  insertCash(db, { ts: toTwIso(clock.now()), type: 'allocate_in', amount, actor, note });
  return getBalance(db);
}

export function withdraw(db: DB, amount: number, actor: Actor, note: string | undefined, clock: Clock): Balance {
  requirePositiveInt('撥出金額', amount);
  return db.transaction(() => {
    const { available } = getBalance(db);
    if (amount > available) {
      throw riskRejected('WITHDRAW_EXCEEDS_AVAILABLE', `撥出 ${amount} 元超過可用資金 ${available} 元`, {
        amount,
        available,
      });
    }
    insertCash(db, { ts: toTwIso(clock.now()), type: 'allocate_out', amount: -amount, actor, note });
    return getBalance(db);
  }).immediate();
}

// ---------------------------------------------------------------- 持股轉入轉出

export interface TransferInOptions {
  symbol: string;
  qty: number;
  /** 每股成本（分） */
  costPerShareX100: number;
  /**
   * 券商端該檔的實際持股。live 模式必須提供，確認「使用者持股 − 已轉入 Claude 的股數」
   * 足夠才允許轉入（規格第 5 節）。paper 模式可省略。
   */
  brokerHeldQty?: number;
  actor: Actor;
  note?: string;
}

export function transferIn(db: DB, o: TransferInOptions, clock: Clock): Position {
  requirePositiveInt('轉入股數', o.qty);
  requirePositiveInt('每股成本', o.costPerShareX100);
  return db.transaction(() => {
    const held = getPosition(db, o.symbol).qty;
    if (o.brokerHeldQty !== undefined) {
      const userQty = o.brokerHeldQty - held;
      if (o.qty > userQty) {
        throw riskRejected(
          'TRANSFER_EXCEEDS_USER_HOLDING',
          `轉入 ${o.symbol} ${o.qty} 股超過使用者可轉入股數 ${userQty} 股（券商持股 ${o.brokerHeldQty} − 帳本已有 ${held}）`,
          { qty: o.qty, brokerHeldQty: o.brokerHeldQty, ledgerQty: held },
        );
      }
    }
    insertPosition(db, {
      ts: toTwIso(clock.now()),
      symbol: o.symbol,
      type: 'transfer_in',
      qty: o.qty,
      costX100: o.costPerShareX100 * o.qty,
      actor: o.actor,
      note: o.note ?? `成本 ${formatPrice(o.costPerShareX100)} 元／股`,
    });
    return getPosition(db, o.symbol);
  }).immediate();
}

export function transferOut(
  db: DB,
  o: { symbol: string; qty: number; actor: Actor; note?: string },
  clock: Clock,
): Position {
  requirePositiveInt('轉出股數', o.qty);
  return db.transaction(() => {
    const pos = getPosition(db, o.symbol);
    if (o.qty > pos.sellable_qty) {
      throw riskRejected(
        'TRANSFER_EXCEEDS_SELLABLE',
        `轉出 ${o.symbol} ${o.qty} 股超過可轉出股數 ${pos.sellable_qty} 股（持股 ${pos.qty}，未完成賣單 ${pos.pending_sell_qty}）`,
        { qty: o.qty, sellable: pos.sellable_qty },
      );
    }
    insertPosition(db, {
      ts: toTwIso(clock.now()),
      symbol: o.symbol,
      type: 'transfer_out',
      qty: -o.qty,
      costX100: -costToRemove(pos, o.qty),
      actor: o.actor,
      note: o.note,
    });
    return getPosition(db, o.symbol);
  }).immediate();
}
