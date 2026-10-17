import type { Config, Session } from './config.js';
import type { DB } from './db.js';
import type { Board, BookEvent, MarketEvent, TradeEvent } from './marketdata.js';
import { type FillResult, type OrderRow, applyFill, getOrder } from './orders.js';
import { getMarketRules } from './settings.js';
import { type Clock, toTwIso, twDate, twHhmm } from './time.js';

/**
 * 模擬撮合（規格第 7 節）。採保守假設：寧可少成交、成交價差一點，也不要高估績效。
 *
 * 整股
 *   - 送出時即可成交的限價單：買單限價 ≥ 最佳賣價，以最佳賣價成交，數量不超過該檔賣量，剩餘轉為掛單。
 *   - 掛單：後續成交價「嚴格穿越」限價才成交，成交價 = 限價；fill_at_touch 時等於限價也成交。
 *   - 集合競價（開盤、收盤）：限價優於或等於撮合價即成交，成交價 = 撮合價。
 * 零股
 *   - 盤中零股、盤後零股都是定期集合競價：每次撮合以撮合價判斷，規則同集合競價。
 * 數量上限
 *   - 每筆行情成交量最多分給模擬單 max_volume_share_pct，可能分多次部分成交。
 *
 * 帳本是唯一的狀態來源：撮合時直接查詢未完成委託、以 applyFill 入帳，daemon 重啟不會遺失掛單。
 */

export interface PaperOptions {
  fillAtTouch: boolean;
  maxVolumeSharePct: number;
}

const BOARD_SESSION: Record<Board, Session> = { regular: 'regular', odd: 'odd_intraday', odd_after: 'odd_after' };

type BookLookup = (symbol: string, board: Board) => BookEvent | undefined;

export class PaperMatcher {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly books: BookLookup,
    private readonly opts: PaperOptions,
  ) {}

  /** 整股是否在逐筆交易時段；之外的委託時間為集合競價，委託等待撮合價。 */
  isContinuous(now: Date): boolean {
    const [start, end] = getMarketRules(this.db, twDate(now)).continuous;
    const t = twHhmm(now);
    return t >= start && t < end;
  }

  /** 委託剛送出：整股逐筆時段內的可成交限價單立即以對手價成交。 */
  onSubmitted(orderId: number): FillResult[] {
    const order = getOrder(this.db, orderId);
    if (order.session !== 'regular' || !isMatchable(order)) return [];
    const now = this.clock.now();
    if (!this.isContinuous(now)) return [];

    const book = this.books(order.symbol, 'regular');
    const best = order.side === 'buy' ? book?.asks[0] : book?.bids[0];
    if (!best) return [];
    const crosses = order.side === 'buy' ? order.price_x100 >= best.price_x100 : order.price_x100 <= best.price_x100;
    if (!crosses) return [];

    const qty = Math.min(order.qty - order.filled_qty, roundLot(best.size));
    if (qty <= 0) return [];
    return [this.fill(order, best.price_x100, qty, toTwIso(now))];
  }

  onEvent(e: MarketEvent): FillResult[] {
    if (e.type !== 'trade') return [];
    return [...this.matchSide(e, 'buy'), ...this.matchSide(e, 'sell')];
  }

  private matchSide(e: TradeEvent, side: 'buy' | 'sell'): FillResult[] {
    const session = BOARD_SESSION[e.board];
    const auction = e.board !== 'regular' || e.auction !== undefined;
    // 買單限價高者優先，賣單限價低者優先，同價依委託先後
    const orders = this.db
      .prepare(
        `SELECT * FROM orders WHERE symbol = ? AND session = ? AND side = ? AND status IN ('submitted', 'partial')
         ORDER BY price_x100 ${side === 'buy' ? 'DESC' : 'ASC'}, id`,
      )
      .all(e.symbol, session, side) as OrderRow[];
    if (orders.length === 0) return [];

    let budget = Math.floor((e.volume * this.opts.maxVolumeSharePct) / 100);
    if (session === 'regular') budget = roundLot(budget);

    const results: FillResult[] = [];
    const eventTime = Date.parse(e.ts);
    for (const order of orders) {
      if (budget <= 0) break;
      // 委託送出前的成交不能拿來撮合
      if (Date.parse(order.created_at) > eventTime) continue;
      if (!this.eligible(order, e.price_x100, auction)) continue;
      const qty = Math.min(order.qty - order.filled_qty, budget);
      if (qty <= 0) continue;
      budget -= qty;
      results.push(this.fill(order, auction ? e.price_x100 : order.price_x100, qty, e.ts));
    }
    return results;
  }

  private eligible(order: OrderRow, price: number, auction: boolean): boolean {
    const touch = auction || this.opts.fillAtTouch;
    if (order.side === 'buy') return touch ? order.price_x100 >= price : order.price_x100 > price;
    return touch ? order.price_x100 <= price : order.price_x100 < price;
  }

  private fill(order: OrderRow, priceX100: number, qty: number, ts: string): FillResult {
    return applyFill(
      this.db,
      {
        orderId: order.id,
        priceX100,
        qty,
        ts,
        simulated: true,
        category: this.config.symbols[order.symbol]?.category ?? 'stock',
      },
      this.clock,
    );
  }
}

const isMatchable = (o: OrderRow) => o.status === 'submitted' || o.status === 'partial';

/** 整股成交以張為單位。 */
const roundLot = (shares: number) => Math.floor(shares / 1000) * 1000;
