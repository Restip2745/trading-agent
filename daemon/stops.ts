import { getStops } from '../core/claude-ops.js';
import type { Config, Session } from '../core/config.js';
import type { DB } from '../core/db.js';
import { getPositions } from '../core/ledger.js';
import type { QuoteSource } from '../core/market.js';
import { formatPrice, tickSize } from '../core/money.js';
import { createOrder } from '../core/orders.js';
import { getMarketRules } from '../core/settings.js';
import { recordRiskEvent, sessionStatus } from '../core/state.js';
import { type Clock, twDate } from '../core/time.js';
import type { BrokerAdapter } from './broker.js';

/**
 * 硬停損停利（規格第 6、8 節）：daemon 偵測到觸價時直接送出限價賣單，不經過 Claude，
 * 暫停中也照常執行。成交後由 daemon 觸發一次 Claude（stop_triggered）告知結果。
 *
 * 賣單以 origin = stop 送出：不受頻率限制，但仍須通過可賣股數與價格合法檢查。
 * 同一時間每檔只保留一筆停損單，重送至少間隔 resend_interval_sec 秒。
 */

export interface StopHit {
  symbol: string;
  kind: 'stop' | 'take_profit';
  trigger_x100: number;
  last_x100: number;
  orderIds: number[];
}

export class StopExecutor {
  private readonly lastAttempt = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly quotes: QuoteSource,
    private readonly broker: BrokerAdapter,
    private readonly log: (msg: string) => void,
  ) {}

  /** 檢查所有設有停損停利的持股，觸價者送出賣單。回傳本次觸發的項目。 */
  async check(): Promise<StopHit[]> {
    const hits: StopHit[] = [];
    for (const stop of getStops(this.db)) {
      const q = this.quotes.getQuote(stop.symbol);
      if (!q) continue;
      let kind: StopHit['kind'] | undefined;
      let trigger = 0;
      if (stop.stop_x100 !== null && q.last_x100 <= stop.stop_x100) [kind, trigger] = ['stop', stop.stop_x100];
      else if (stop.take_profit_x100 !== null && q.last_x100 >= stop.take_profit_x100) {
        [kind, trigger] = ['take_profit', stop.take_profit_x100];
      }
      if (!kind) continue;
      const hit = await this.execute(stop.symbol, kind, trigger, q.last_x100, q.limit_down_x100);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  private async execute(
    symbol: string,
    kind: StopHit['kind'],
    trigger: number,
    last: number,
    limitDown: number,
  ): Promise<StopHit | undefined> {
    const openStop = this.db
      .prepare(`SELECT COUNT(*) FROM orders WHERE symbol = ? AND origin = 'stop' AND status IN ('pending_submit', 'submitted', 'partial', 'unknown')`)
      .pluck()
      .get(symbol) as number;
    if (openStop > 0) return undefined;

    const now = this.clock.now().getTime();
    const prev = this.lastAttempt.get(symbol);
    if (prev !== undefined && now - prev < this.config.stops.resend_interval_sec * 1000) return undefined;

    const pos = getPositions(this.db).find((p) => p.symbol === symbol);
    if (!pos || pos.sellable_qty <= 0) return undefined;

    const status = sessionStatus(this.db, this.clock);
    const category = this.config.symbols[symbol]?.category ?? 'stock';
    const rules = getMarketRules(this.db, twDate(this.clock.now()));
    // 以最後成交價減若干檔的限價賣出，對齊升降單位，不低於跌停價
    const tick = tickSize(last, category, rules);
    const price = Math.max(limitDown, Math.floor((last - tick * this.config.stops.order_ticks) / tick) * tick);

    // 整股部分走整股盤，零頭走盤中零股；該盤別不在委託時段時略過，下次檢查再送
    const lots = Math.floor(pos.sellable_qty / 1000) * 1000;
    const odd = pos.sellable_qty - lots;
    const legs: [Session, number][] = [];
    if (lots > 0 && status.open.regular) legs.push(['regular', lots]);
    if (odd > 0 && status.open.odd_intraday) legs.push(['odd_intraday', odd]);
    if (legs.length === 0) return undefined;

    this.lastAttempt.set(symbol, now);
    const orderIds: number[] = [];
    for (const [session, qty] of legs) {
      try {
        const order = createOrder(
          this.db,
          { symbol, side: 'sell', session, priceX100: price, qty, origin: 'stop' },
          { config: this.config, quotes: this.quotes, clock: this.clock },
        );
        orderIds.push(order.id);
        await this.broker.submit(order.id);
      } catch (e) {
        this.log(`硬${kind === 'stop' ? '停損' : '停利'}送單失敗 ${symbol} ${session}：${(e as Error).message}`);
        recordRiskEvent(this.db, `${kind}_failed`, { symbol, session, qty, price: formatPrice(price), error: (e as Error).message }, 'warn', this.clock);
      }
    }
    if (orderIds.length === 0) return undefined;

    const detail = { symbol, trigger: formatPrice(trigger), last: formatPrice(last), price: formatPrice(price), orderIds };
    recordRiskEvent(this.db, kind === 'stop' ? 'hard_stop' : 'hard_take_profit', detail, 'order', this.clock);
    this.log(`硬${kind === 'stop' ? '停損' : '停利'}觸發 ${symbol}：最後成交 ${formatPrice(last)}，以 ${formatPrice(price)} 賣出`);
    return { symbol, kind, trigger_x100: trigger, last_x100: last, orderIds };
  }
}
