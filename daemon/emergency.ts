import type { Config, Session } from '../core/config.js';
import type { DB } from '../core/db.js';
import { getPositions } from '../core/ledger.js';
import type { QuoteSource } from '../core/market.js';
import type { BookEvent } from '../core/marketdata.js';
import { formatPrice, tickSize } from '../core/money.js';
import { type OrderRow, createOrder, getOrder } from '../core/orders.js';
import { getMarketRules } from '../core/settings.js';
import { pause, recordRiskEvent, sessionStatus } from '../core/state.js';
import { type Clock, twDate } from '../core/time.js';
import type { BrokerAdapter } from './broker.js';

/**
 * 緊急操作（規格第 18 節）：不經過 Claude、不受頻率限制，執行後系統自動暫停。
 * 風險應對單（origin = emergency）仍須通過可賣股數與價格合法檢查。
 */

export interface EmergencyResult {
  cancelled: number[];
  failed: { order_id: number; error: string }[];
  orders?: { order_id: number; symbol: string; session: Session; qty: number; price: string; status: string }[];
  skipped?: { symbol: string; reason: string }[];
}

/** 刪除帳本中所有未完成委託（含 daemon 的停損單），釋放圈存，並暫停。 */
export async function cancelAll(db: DB, broker: BrokerAdapter, clock: Clock, reason = '緊急操作：刪除所有未完成委託'): Promise<EmergencyResult> {
  const open = db
    .prepare(`SELECT id FROM orders WHERE status IN ('pending_submit', 'submitted', 'partial') ORDER BY id`)
    .pluck()
    .all() as number[];
  const cancelled: number[] = [];
  const failed: EmergencyResult['failed'] = [];
  for (const id of open) {
    try {
      await broker.cancel(id);
      cancelled.push(id);
    } catch (e) {
      failed.push({ order_id: id, error: (e as Error).message });
    }
  }
  pause(db, 'emergency', reason, clock);
  recordRiskEvent(db, 'emergency_cancel_all', { cancelled, failed }, 'cancel', clock);
  return { cancelled, failed };
}

/**
 * 全部平倉：先刪除所有未完成委託，再以對手價（最佳買價）賣出帳本全部持股。
 * 整股部分走整股盤、零頭走盤中零股；該盤別不在委託時段時略過並回報。
 */
export async function flatten(
  db: DB,
  config: Config,
  clock: Clock,
  quotes: QuoteSource,
  books: (symbol: string, board: 'regular' | 'odd') => BookEvent | undefined,
  broker: BrokerAdapter,
): Promise<EmergencyResult> {
  const cancel = await cancelAll(db, broker, clock, '緊急操作：全部平倉');
  const status = sessionStatus(db, clock);
  const rules = getMarketRules(db, twDate(clock.now()));
  const orders: NonNullable<EmergencyResult['orders']> = [];
  const skipped: NonNullable<EmergencyResult['skipped']> = [];

  for (const pos of getPositions(db).filter((p) => p.sellable_qty > 0)) {
    const q = quotes.getQuote(pos.symbol);
    if (!q) {
      skipped.push({ symbol: pos.symbol, reason: '沒有報價' });
      continue;
    }
    const category = config.symbols[pos.symbol]?.category ?? 'stock';
    const lots = Math.floor(pos.sellable_qty / 1000) * 1000;
    const legs: [Session, number, 'regular' | 'odd'][] = [];
    if (lots > 0) legs.push(['regular', lots, 'regular']);
    if (pos.sellable_qty - lots > 0) legs.push(['odd_intraday', pos.sellable_qty - lots, 'odd']);

    for (const [session, qty, board] of legs) {
      if (!status.open[session]) {
        skipped.push({ symbol: pos.symbol, reason: `${session} 不在委託時段（${qty} 股）` });
        continue;
      }
      // 對手價：該盤的最佳買價；沒有買盤時以最後成交價減 5 檔，不低於跌停價
      const tick = tickSize(q.last_x100, category, rules);
      const bid = books(pos.symbol, board)?.bids[0]?.price_x100;
      const price = Math.max(q.limit_down_x100, bid ?? Math.floor((q.last_x100 - tick * 5) / tick) * tick);
      try {
        const order: OrderRow = createOrder(
          db,
          { symbol: pos.symbol, side: 'sell', session, priceX100: price, qty, origin: 'emergency' },
          { config, quotes, clock },
        );
        await broker.submit(order.id);
        const after = getOrder(db, order.id);
        orders.push({ order_id: order.id, symbol: pos.symbol, session, qty, price: formatPrice(price), status: after.status });
      } catch (e) {
        skipped.push({ symbol: pos.symbol, reason: `${session} 送單失敗：${(e as Error).message}` });
      }
    }
  }
  recordRiskEvent(db, 'emergency_flatten', { orders, skipped }, 'order', clock);
  return { ...cancel, orders, skipped };
}
