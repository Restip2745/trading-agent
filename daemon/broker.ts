import type { DB } from '../core/db.js';
import { invalidArgs } from '../core/errors.js';
import {
  type OrderRow,
  getOrder,
  markCancelled,
  markRejected,
  markSubmitted,
} from '../core/orders.js';
import type { PaperMatcher } from '../core/paper.js';
import { type Clock, toTwIso } from '../core/time.js';

/**
 * 送單轉接層。paper 與 live 只差在這一層（規格第 3 節）：
 * PaperBroker 交給本地模擬撮合，EsunBroker（daemon/esun/broker.ts）送到玉山。
 *
 * 呼叫端（ctrade）已在帳本寫入 pending_submit 並完成圈存，轉接層只負責送出與更新狀態。
 */
export interface BrokerAdapter {
  readonly name: string;
  submit(orderId: number): Promise<OrderRow>;
  cancel(orderId: number): Promise<OrderRow>;
  /** 定期維護：處理卡住的委託、同步券商狀態。 */
  sweep(): void;
  /** 啟動程序：登入、同步、快速對帳（規格第 17 節）。 */
  start?(): Promise<void>;
  /** 券商實際庫存（live 模式轉入持股前檢查用）。 */
  holdings?(): Promise<{ symbol: string; qty: number }[]>;
}

export class PaperBroker implements BrokerAdapter {
  readonly name = 'paper';

  constructor(
    private readonly db: DB,
    private readonly matcher: PaperMatcher,
    private readonly clock: Clock,
    /** 模擬送單延遲 [最小, 最大] 毫秒，貼近真實下單的時間差 */
    private readonly delayMs: [number, number],
  ) {}

  async submit(orderId: number): Promise<OrderRow> {
    const order = getOrder(this.db, orderId);
    if (order.status !== 'pending_submit') return order; // 重複送出時直接回目前狀態，不重送
    const [min, max] = this.delayMs;
    const delay = min + Math.random() * Math.max(0, max - min);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const current = getOrder(this.db, orderId);
    if (current.status !== 'pending_submit') return current;
    markSubmitted(this.db, orderId, `P${orderId}`, this.clock);
    this.matcher.onSubmitted(orderId);
    return getOrder(this.db, orderId);
  }

  async cancel(orderId: number): Promise<OrderRow> {
    const order = getOrder(this.db, orderId);
    if (order.status === 'submitted' || order.status === 'partial') {
      return markCancelled(this.db, orderId, this.clock);
    }
    if (order.status === 'pending_submit') {
      return markRejected(this.db, orderId, '送出前已刪單', this.clock);
    }
    throw invalidArgs('ORDER_NOT_CANCELLABLE', `委託 ${orderId} 目前為 ${order.status}，無法刪單`);
  }

  /**
   * pending_submit 超過一分鐘：代表 ctrade 寫入委託後沒有把它交給 daemon（例如程序中斷）。
   * paper 模式確定沒有送出，直接標為 rejected 並釋放圈存。
   * live 模式不能這樣處理，必須向券商查詢（規格第 17 節）。
   */
  sweep(): void {
    const cutoff = toTwIso(new Date(this.clock.now().getTime() - 60_000));
    const stuck = this.db
      .prepare(`SELECT id FROM orders WHERE status = 'pending_submit' AND created_at < ?`)
      .pluck()
      .all(cutoff) as number[];
    for (const id of stuck) markRejected(this.db, id, '送出前中斷，委託未送出', this.clock);
  }
}
