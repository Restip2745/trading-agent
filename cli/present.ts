import type { ProtectiveStop, TriggerConfig } from '../core/claude-ops.js';
import type { Position } from '../core/ledger.js';
import type { FeeSchedule } from '../core/money.js';
import { formatPrice, ppmToPct, tickSize } from '../core/money.js';
import type { MarketRules, SymbolCategory } from '../core/config.js';
import type { Level, QuoteDetail } from '../core/marketdata.js';
import type { OrderRow } from '../core/orders.js';

/** 把帳本的整數（分、ppm）轉成給人與 Claude 讀的格式。價格一律輸出為字串，避免浮點表示。 */

const price = (x100: number | null | undefined) => (x100 == null ? null : formatPrice(x100));

export function presentPosition(p: Position) {
  return {
    symbol: p.symbol,
    qty: p.qty,
    sellable_qty: p.sellable_qty,
    pending_sell_qty: p.pending_sell_qty,
    avg_cost: price(p.avg_cost_x100),
    total_cost: Math.round(p.cost_x100 / 100),
  };
}

export function presentOrder(o: OrderRow) {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    session: o.session,
    origin: o.origin,
    price: price(o.price_x100),
    qty: o.qty,
    filled_qty: o.filled_qty,
    status: o.status,
    reserved_amount: o.reserved_amount,
    broker_order_id: o.broker_order_id,
    created_at: o.created_at,
    reject_reason: o.reject_reason,
  };
}

export function presentFill(f: Record<string, unknown>) {
  return {
    id: f.id,
    order_id: f.order_id,
    symbol: f.symbol,
    side: f.side,
    ts: f.ts,
    price: price(f.price_x100 as number),
    qty: f.qty,
    fee: f.fee,
    tax: f.tax,
    day_trade: f.day_trade === 1,
    settle_date: f.settle_date,
    simulated: f.simulated === 1,
  };
}

export function presentTrigger(t: TriggerConfig) {
  return {
    interval_min: t.interval_min ?? 'off',
    up_pct: t.up_pct ?? 'off',
    down_pct: t.down_pct ?? 'off',
    set_by: t.set_by,
    set_at: t.set_at,
  };
}

export function presentStop(s: ProtectiveStop) {
  return { symbol: s.symbol, stop: price(s.stop_x100), take_profit: price(s.take_profit_x100), set_by: s.set_by, ts: s.ts };
}

export function presentQuoteDetail(d: QuoteDetail, category: SymbolCategory, rules: MarketRules) {
  const q = d.quote;
  if (!q) return { symbol: d.symbol, available: false, note: '沒有報價（行情來源未提供此代號，或尚未收到參考價與漲跌停）' };
  const levels = (ls: Level[] | undefined) => ls?.map((l) => ({ price: formatPrice(l.price_x100), size: l.size }));
  const change = q.prev_close_x100 ? q.last_x100 - q.prev_close_x100 : null;
  return {
    symbol: d.symbol,
    available: true,
    last: formatPrice(q.last_x100),
    prev_close: price(q.prev_close_x100),
    change: change === null ? null : formatPrice(change),
    change_pct: change === null || !q.prev_close_x100 ? null : Number(((change / q.prev_close_x100) * 100).toFixed(2)),
    limit_up: formatPrice(q.limit_up_x100),
    limit_down: formatPrice(q.limit_down_x100),
    tick_size: formatPrice(tickSize(q.last_x100, category, rules)),
    best_bid: price(q.best_bid_x100),
    best_ask: price(q.best_ask_x100),
    bids: levels(d.book?.bids),
    asks: levels(d.book?.asks),
    odd_last: d.odd_last ? { price: formatPrice(d.odd_last.price_x100), volume: d.odd_last.volume, ts: d.odd_last.ts } : null,
    flags: { attention: !!q.is_attention, disposition: !!q.is_disposition, full_delivery: !!q.is_full_delivery, halted: !!q.is_halted },
    ts: q.ts,
    note: '五檔數量單位為股',
  };
}

export function presentFees(s: FeeSchedule) {
  return {
    schedule_id: s.id,
    effective_date: s.effective_date,
    fee_rate_pct: ppmToPct(s.fee_rate_ppm),
    fee_discount: s.fee_discount_bp / 10_000,
    rebate_mode: s.rebate_mode,
    min_fee_regular: s.min_fee_regular,
    min_fee_odd: s.min_fee_odd,
    tax_stock_pct: ppmToPct(s.tax_stock_ppm),
    tax_daytrade_pct: ppmToPct(s.tax_daytrade_ppm),
    tax_etf_pct: ppmToPct(s.tax_etf_ppm),
  };
}
