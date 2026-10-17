import type { Config, Session } from '../../core/config.js';
import type { DB } from '../../core/db.js';
import { invalidArgs } from '../../core/errors.js';
import { getPositions } from '../../core/ledger.js';
import {
  type OrderRow,
  applyFill,
  getOrder,
  isDayTradeSell,
  markCancelled,
  markRejected,
  markSubmitted,
  markUnknown,
} from '../../core/orders.js';
import { getRiskParams } from '../../core/settings.js';
import { getPause, getState, pause, recordRiskEvent, setState } from '../../core/state.js';
import { type Clock, toTwIso } from '../../core/time.js';
import type { BrokerAdapter } from '../broker.js';
import { type ApCode, BrokerApiError, type BrokerHolding, type BrokerOrder, type TradeApi, toBrokerError } from './api.js';

/**
 * 玉山券商轉接層（live 模式送單，規格第 3、12、17 節）。
 *
 * 帳本仍是 Claude 的資金與持倉來源；券商回報只用來更新委託狀態與寫入成交。
 *
 *   送單：pending_submit → 送出 → submitted；券商明確拒絕 → rejected；結果不明 → unknown。
 *         同一筆委託永不重送。
 *   同步：以券商當日委託（getOrders）為準，依已成交股數與均價補寫成交、更新刪單與拒單狀態，
 *         並以代號、方向、價格、數量比對 unknown 委託。主動回報到達時提前同步。
 *   啟動：先同步，再確認券商庫存 ≥ 帳本持股，不符則暫停（規格第 17 節）。
 *
 * 費用與稅先依費率估算入帳；與券商實際收取的差異由每日對帳以調整記錄補正。
 */

const AP_CODE: Record<Session, ApCode> = { regular: '1', odd_intraday: '5', odd_after: '3' };

/** 委託查詢上限每分鐘 12 次（doc/broker-api-notes.md），定期同步間隔不低於 10 秒。 */
const MIN_SYNC_INTERVAL_MS = 10_000;
/** unknown 委託在券商查不到超過這個時間，確認未送出。 */
const UNKNOWN_GIVE_UP_MS = 60_000;

export interface EsunBrokerOptions {
  syncIntervalMs?: number;
  log: (msg: string) => void;
}

export class EsunBroker implements BrokerAdapter {
  readonly name = 'esun';
  private lastSync = 0;
  private syncing?: Promise<void>;
  private syncRequested = false;
  private readonly unknownSince = new Map<number, number>();
  private readonly syncIntervalMs: number;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly api: TradeApi,
    private readonly opts: EsunBrokerOptions,
  ) {
    this.syncIntervalMs = Math.max(MIN_SYNC_INTERVAL_MS, opts.syncIntervalMs ?? 15_000);
  }

  /** 登入、連線主動回報、啟動同步與快速對帳。 */
  async start(): Promise<void> {
    await this.api.login();
    this.api.onReport(() => {
      this.syncRequested = true;
    });
    this.api.connectStreamer();
    await this.sync();
    await this.checkHoldings('startup');
  }

  // ---------------------------------------------------------------- 送單

  async submit(orderId: number): Promise<OrderRow> {
    const order = getOrder(this.db, orderId);
    if (order.status !== 'pending_submit') return order;

    const quantity = order.session === 'regular' ? order.qty / 1000 : order.qty;
    const trade = order.side === 'sell' && isDayTradeSell(this.db, order.symbol, order.qty, toTwIso(this.clock.now())) ? 'A' : '0';
    try {
      const res = await this.api.placeOrder({
        symbol: order.symbol,
        side: order.side,
        apCode: AP_CODE[order.session],
        priceX100: order.price_x100,
        quantity,
        trade,
        // 自訂欄位只在正式環境有效，用來輔助比對 unknown 委託
        memo: `CT${order.id}`,
      });
      if (res.retCode && res.retCode !== '000000') {
        this.recordReject(order, `${res.retCode} ${res.retMsg}`);
        return markRejected(this.db, orderId, `券商拒絕：${res.retCode} ${res.retMsg}`.trim(), this.clock);
      }
      this.resetFailures();
      if (this.counter('broker_rejects') !== 0) setState(this.db, 'broker_rejects', '0', this.clock);
      const updated = markSubmitted(this.db, orderId, res.ordNo, this.clock);
      this.syncRequested = true;
      return updated;
    } catch (e) {
      const err = toBrokerError(e, '下單');
      this.recordApiFailure(err);
      if (err.definitelyNotSent) {
        this.recordReject(order, err.message);
        return markRejected(this.db, orderId, err.message, this.clock);
      }
      // 不確定是否送達：標為 unknown，由同步向券商確認，不重送（規格第 17 節）
      this.opts.log(`委託 ${orderId} 送出結果不明：${err.message}`);
      this.syncRequested = true;
      return markUnknown(this.db, orderId, this.clock);
    }
  }

  async cancel(orderId: number): Promise<OrderRow> {
    const order = getOrder(this.db, orderId);
    if (order.status === 'pending_submit') return markRejected(this.db, orderId, '送出前已刪單', this.clock);
    if (order.status !== 'submitted' && order.status !== 'partial') {
      throw invalidArgs('ORDER_NOT_CANCELLABLE', `委託 ${orderId} 目前為 ${order.status}，無法刪單`);
    }
    if (!order.broker_order_id) throw invalidArgs('NO_BROKER_ORDER_ID', `委託 ${orderId} 沒有券商委託編號，無法刪單`);
    try {
      await this.api.cancel(order.broker_order_id);
    } catch (e) {
      const err = toBrokerError(e, '刪單');
      // 單號不存在或不可刪除：委託狀態已變動（例如已成交），以同步結果為準
      if (err.brokerCode !== 'AG00003' && err.brokerCode !== 'AG00005') {
        this.recordApiFailure(err);
        throw err;
      }
    }
    await this.sync();
    return getOrder(this.db, orderId);
  }

  // ---------------------------------------------------------------- 同步

  /** daemon 每次 tick 呼叫：到期或有主動回報時同步。 */
  sweep(): void {
    const due = this.clock.now().getTime() - this.lastSync >= this.syncIntervalMs;
    if ((due || this.syncRequested) && !this.syncing) void this.sync().catch((e) => this.opts.log(`券商同步失敗：${(e as Error).message}`));
  }

  /** 以券商當日委託更新本地委託與成交。同時只會有一次同步在執行。 */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncRequested = false;
    this.lastSync = this.clock.now().getTime();
    this.syncing = this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    let remote: BrokerOrder[];
    try {
      remote = await this.api.getOrders();
      this.resetFailures();
    } catch (e) {
      this.recordApiFailure(toBrokerError(e, '查詢委託'));
      throw e;
    }
    const byOrdNo = new Map(remote.map((o) => [o.ordNo, o]));
    const local = this.db
      .prepare(`SELECT * FROM orders WHERE status IN ('submitted', 'partial', 'unknown') ORDER BY id`)
      .all() as OrderRow[];
    const claimed = new Set(local.map((o) => o.broker_order_id).filter(Boolean) as string[]);

    for (const order of local) {
      let r = order.broker_order_id ? byOrdNo.get(order.broker_order_id) : undefined;
      if (order.status === 'unknown') {
        r = this.matchUnknown(order, remote, claimed);
        if (!r) {
          this.giveUpUnknown(order);
          continue;
        }
        claimed.add(r.ordNo);
        this.unknownSince.delete(order.id);
        markSubmitted(this.db, order.id, r.ordNo, this.clock);
        this.opts.log(`unknown 委託 ${order.id} 已在券商找到（${r.ordNo}）`);
      }
      if (r) this.applyRemote(getOrder(this.db, order.id), r);
    }
  }

  /** 以自訂欄位，或代號、方向、價格、數量與委託時間比對 unknown 委託。 */
  private matchUnknown(order: OrderRow, remote: BrokerOrder[], claimed: Set<string>): BrokerOrder | undefined {
    const candidates = remote.filter((r) => !claimed.has(r.ordNo));
    const byMemo = candidates.find((r) => r.memo === `CT${order.id}`);
    if (byMemo) return byMemo;
    const matches = candidates.filter(
      (r) => r.symbol === order.symbol && r.side === order.side && r.priceX100 === order.price_x100 && r.orgQty === order.qty,
    );
    // 多筆條件相同時無法確定，保持 unknown 交給使用者處理
    return matches.length === 1 ? matches[0] : undefined;
  }

  private giveUpUnknown(order: OrderRow): void {
    const first = this.unknownSince.get(order.id) ?? this.clock.now().getTime();
    this.unknownSince.set(order.id, first);
    if (this.clock.now().getTime() - first >= UNKNOWN_GIVE_UP_MS) {
      this.unknownSince.delete(order.id);
      markRejected(this.db, order.id, '券商查無此委託，確認未送出', this.clock);
      recordRiskEvent(this.db, 'unknown_not_found', { order_id: order.id }, 'warn', this.clock);
      this.opts.log(`unknown 委託 ${order.id} 在券商查無資料，確認未送出`);
    }
  }

  /** 依券商的已成交股數與均價補寫成交，再更新刪單或拒單狀態。 */
  private applyRemote(order: OrderRow, r: BrokerOrder): void {
    const delta = r.matQty - order.filled_qty;
    if (delta > 0) {
      const filledValueX100 = this.db
        .prepare('SELECT COALESCE(SUM(price_x100 * qty), 0) FROM fills WHERE order_id = ?')
        .pluck()
        .get(order.id) as number;
      // 本次新增成交的均價 = 券商累計成交金額 − 已入帳金額，再除以新增股數；不得劣於限價
      let price = Math.round((r.avgPriceX100 * r.matQty - filledValueX100) / delta);
      if (!(price > 0)) price = order.price_x100;
      price = order.side === 'buy' ? Math.min(price, order.price_x100) : Math.max(price, order.price_x100);
      applyFill(
        this.db,
        {
          orderId: order.id,
          priceX100: price,
          qty: delta,
          ts: toTwIso(this.clock.now()),
          brokerFillId: `${r.ordNo}:${r.matQty}`,
          category: this.config.symbols[order.symbol]?.category ?? 'stock',
        },
        this.clock,
      );
      this.opts.log(`券商成交：委託 ${order.id} ${order.symbol} ${order.side} ${r.matQty}/${order.qty} 股`);
    }

    const current = getOrder(this.db, order.id);
    if (current.status === 'filled') return;
    const errored = r.errCode !== '' && r.errCode !== '00000000';
    if (errored && r.matQty === 0) {
      this.recordReject(current, `${r.errCode} ${r.errMsg}`);
      markRejected(this.db, order.id, `券商拒絕：${r.errCode} ${r.errMsg}`.trim(), this.clock);
    } else if (r.celQty > 0 && r.matQty + r.celQty >= r.orgQty) {
      markCancelled(this.db, order.id, this.clock);
    }
  }

  // ---------------------------------------------------------------- 庫存

  async holdings(): Promise<BrokerHolding[]> {
    return this.api.getHoldings();
  }

  /** 每檔：券商實際持股 ≥ 帳本持股，否則暫停（規格第 12、17 節）。 */
  async checkHoldings(context: string): Promise<{ ok: boolean; diffs: Record<string, unknown>[] }> {
    const remote = new Map((await this.api.getHoldings()).map((h) => [h.symbol, h.qty]));
    const diffs = getPositions(this.db)
      .filter((p) => p.qty > 0 && (remote.get(p.symbol) ?? 0) < p.qty)
      .map((p) => ({ symbol: p.symbol, ledger: p.qty, broker: remote.get(p.symbol) ?? 0 }));
    if (diffs.length > 0 && !getPause(this.db).paused) {
      pause(this.db, 'reconciliation', `券商持股少於帳本持股（${context}）：${JSON.stringify(diffs)}`, this.clock);
      this.opts.log(`券商持股少於帳本持股，系統暫停：${JSON.stringify(diffs)}`);
    }
    return { ok: diffs.length === 0, diffs };
  }

  // ---------------------------------------------------------------- 停機條件

  private counter(key: string): number {
    return Number(getState(this.db, key) ?? 0);
  }

  private resetFailures(): void {
    if (this.counter('broker_api_failures') !== 0) setState(this.db, 'broker_api_failures', '0', this.clock);
  }

  /** 券商 API 連續失敗 ≥ max_api_failures 次，或遇到無法重試的錯誤（白名單、密碼、憑證），系統暫停。 */
  private recordApiFailure(err: BrokerApiError): void {
    const n = this.counter('broker_api_failures') + 1;
    setState(this.db, 'broker_api_failures', String(n), this.clock);
    const limit = getRiskParams(this.db).max_api_failures;
    if ((err.fatal || n >= limit) && !getPause(this.db).paused) {
      pause(this.db, 'broker_api', err.fatal ? `券商 API 錯誤無法重試：${err.message}` : `券商 API 連續失敗 ${n} 次：${err.message}`, this.clock);
    }
  }

  /** 委託連續被券商拒絕 ≥ max_broker_rejects 次，系統暫停，避免連續送進錯誤指令。 */
  private recordReject(order: OrderRow, reason: string): void {
    const n = this.counter('broker_rejects') + 1;
    setState(this.db, 'broker_rejects', String(n), this.clock);
    recordRiskEvent(this.db, 'broker_reject', { order_id: order.id, reason, consecutive: n }, 'reject', this.clock);
    const limit = getRiskParams(this.db).max_broker_rejects;
    if (n >= limit && !getPause(this.db).paused) {
      pause(this.db, 'broker_rejects', `委託連續被券商拒絕 ${n} 次：${reason}`, this.clock);
    }
  }
}
