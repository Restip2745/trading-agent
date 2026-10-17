import type { Config, Session } from './config.js';
import type { DB } from './db.js';
import { CtradeError, ExitCode, invalidArgs, riskRejected } from './errors.js';
import { getBalance, getPosition, getPositions } from './ledger.js';
import { type QuoteSource, valuate } from './market.js';
import { buyReservation, formatPrice, isOnTick, nearestTicks, tradeValue } from './money.js';
import { getFeeSchedule, getMarketRules, getRiskParams } from './settings.js';
import { getPause, getState, sessionStatus, setState } from './state.js';
import { type Clock, toTwIso, twDate, twDayStartIso } from './time.js';

export type Side = 'buy' | 'sell';
export type Origin = 'claude' | 'stop' | 'emergency';

export interface OrderRequest {
  symbol: string;
  side: Side;
  session: Session;
  priceX100: number;
  qty: number;
  origin: Origin;
}

export interface RiskContext {
  config: Config;
  quotes: QuoteSource;
  clock: Clock;
}

const OPEN_STATUSES = `('pending_submit', 'submitted', 'partial', 'unknown')`;

/** 每股數量規則：整股以張為單位（1–499 張），零股 1–999 股（券商 API 限制，見 doc/broker-api-notes.md）。 */
export function validateQty(session: Session, qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0) throw invalidArgs('INVALID_QTY', `股數必須是正整數，目前為 ${qty}`);
  if (session === 'regular') {
    if (qty % 1000 !== 0) {
      throw invalidArgs('INVALID_QTY', `整股委託股數須為 1000 的倍數，${qty} 股不符；零股請改用 odd_intraday 或 odd_after`);
    }
    if (qty > 499_000) throw invalidArgs('INVALID_QTY', `整股委託上限 499 張（499000 股），目前為 ${qty} 股`);
  } else if (qty > 999) {
    throw invalidArgs('INVALID_QTY', `零股委託上限 999 股，目前為 ${qty} 股；1000 股以上請改用 regular`);
  }
}

/**
 * 送單前的風控檢查（規格第 6 節）。任何一項不通過就丟出 CtradeError，訊息寫明原因與限制值。
 *
 * 風險應對單（origin = stop、emergency）只能賣出，不受暫停、第 9、10、12 條與白名單限制，
 * 但仍須通過第 4 條（可賣股數）與第 5 條（價格合法）。
 *
 * 呼叫端必須在與寫入委託相同的 IMMEDIATE 交易中呼叫，避免兩個程序同時通過檢查。
 */
export function checkOrder(db: DB, req: OrderRequest, ctx: RiskContext): void {
  const { config, quotes, clock } = ctx;
  const now = clock.now();
  const risk = getRiskParams(db);
  const isClaude = req.origin === 'claude';
  const symbolConfig = config.symbols[req.symbol];

  if (!isClaude && req.side !== 'sell') {
    throw invalidArgs('RISK_ORDER_MUST_SELL', `風險應對單只能賣出`);
  }
  validateQty(req.session, req.qty);

  // 1. 系統未暫停，且目前時段允許該盤別
  if (isClaude) {
    const p = getPause(db);
    if (p.paused) throw new CtradeError('PAUSED', `系統暫停中：${p.reason ?? '未提供原因'}`, ExitCode.PAUSED, { ...p });
  }
  const status = sessionStatus(db, clock);
  if (!status.open[req.session]) {
    const rules = getMarketRules(db, twDate(now));
    const [start, end] = rules.sessions[req.session].accept;
    throw new CtradeError(
      'OUT_OF_SESSION',
      status.tradingDay
        ? `${req.session} 只在 ${start} 至 ${end} 接受委託，現在是 ${status.time}`
        : `今天不是交易日`,
      ExitCode.OUT_OF_SESSION,
      { session: req.session, window: [start, end], now: status.time },
    );
  }

  // 6. 股票白名單（空白名單視為全部禁止）
  if (isClaude && !risk.symbols_allowlist.includes(req.symbol)) {
    throw riskRejected('SYMBOL_NOT_ALLOWED', `${req.symbol} 不在白名單 [${risk.symbols_allowlist.join(', ')}] 內`, {
      allowlist: risk.symbols_allowlist,
    });
  }
  if (!symbolConfig) {
    throw riskRejected('SYMBOL_NOT_CONFIGURED', `${req.symbol} 沒有標的設定（類別與槓桿倍數），無法計算稅率與曝險`);
  }

  const quote = quotes.getQuote(req.symbol);
  if (!quote) throw riskRejected('NO_QUOTE', `取不到 ${req.symbol} 的報價，無法檢查價格是否合法`);

  // 15. 非特殊狀態股票
  if (isClaude) {
    const flags = [
      quote.is_disposition && '處置股',
      quote.is_full_delivery && '全額交割股',
      quote.is_halted && '暫停交易',
      quote.is_attention && '注意股',
    ].filter(Boolean);
    if (flags.length > 0) {
      throw riskRejected('SPECIAL_STATUS', `${req.symbol} 目前為${flags.join('、')}，不允許委託`, { flags });
    }
  }

  // 5. 價格合法：漲跌停範圍內且符合升降單位
  const rules = getMarketRules(db, twDate(now));
  if (req.priceX100 > quote.limit_up_x100 || req.priceX100 < quote.limit_down_x100) {
    throw riskRejected(
      'PRICE_OUT_OF_LIMIT',
      `價格 ${formatPrice(req.priceX100)} 超出今日漲跌停範圍 ${formatPrice(quote.limit_down_x100)} 至 ${formatPrice(quote.limit_up_x100)}`,
      { limit_down: formatPrice(quote.limit_down_x100), limit_up: formatPrice(quote.limit_up_x100) },
    );
  }
  if (!isOnTick(req.priceX100, symbolConfig.category, rules)) {
    const { below, above } = nearestTicks(req.priceX100, symbolConfig.category, rules);
    throw riskRejected(
      'PRICE_NOT_ON_TICK',
      `價格 ${formatPrice(req.priceX100)} 不符合升降單位，最近的合法價格為 ${formatPrice(below)} 或 ${formatPrice(above)}`,
      { nearest: [formatPrice(below), formatPrice(above)] },
    );
  }

  // 14. 該代號沒有 unknown 委託
  if (isClaude) {
    const unknown = db
      .prepare(`SELECT COUNT(*) FROM orders WHERE symbol = ? AND status = 'unknown'`)
      .pluck()
      .get(req.symbol) as number;
    if (unknown > 0) {
      throw riskRejected('UNKNOWN_ORDER_PENDING', `${req.symbol} 有 ${unknown} 筆送出結果未確認的委託，確認前不得再委託`);
    }
  }

  if (isClaude) checkFrequency(db, req, risk.max_orders_per_day, risk.max_orders_per_minute, now);

  if (req.side === 'sell') {
    // 4. 賣出股數 ≤ 帳本可賣股數。防止賣到使用者持股的關鍵檢查；也涵蓋第 11 條的先賣後買。
    const pos = getPosition(db, req.symbol);
    if (req.qty > pos.sellable_qty) {
      throw riskRejected(
        'SELL_EXCEEDS_SELLABLE',
        `賣出 ${req.qty} 股超過可賣股數 ${pos.sellable_qty} 股（持股 ${pos.qty}，未完成賣單 ${pos.pending_sell_qty}）`,
        { qty: req.qty, sellable: pos.sellable_qty },
      );
    }
    return;
  }

  // ---------------------------------------------------------------- 以下為買進檢查

  // 7. 單筆上限
  const value = tradeValue(req.priceX100, req.qty);
  if (value > risk.max_order_amount) {
    throw riskRejected('ORDER_AMOUNT_EXCEEDED', `委託金額 ${value} 元超過單筆上限 ${risk.max_order_amount} 元`, {
      amount: value,
      limit: risk.max_order_amount,
    });
  }

  // 3. 委託金額加預估手續費 ≤ 可用資金
  const schedule = getFeeSchedule(db, twDate(now));
  const reservation = buyReservation(req.priceX100, req.qty, req.session, schedule);
  const { available } = getBalance(db);
  if (reservation > available) {
    throw riskRejected(
      'INSUFFICIENT_FUNDS',
      `買進需 ${reservation} 元（價金 ${value} + 預估手續費 ${reservation - value}），超過可用資金 ${available} 元`,
      { required: reservation, available },
    );
  }

  // 10. 限制高頻進出：每日回合數與再進場冷卻
  checkReentry(db, req.symbol, risk.max_round_trips_per_day, risk.reentry_cooldown_min, now);

  const valuation = valuate(db, quotes, config.symbols);
  const openBuys = db
    .prepare(`SELECT symbol, price_x100, qty - filled_qty AS remaining FROM orders WHERE side = 'buy' AND status IN ${OPEN_STATUSES}`)
    .all() as { symbol: string; price_x100: number; remaining: number }[];

  // 禁止同時持有正向與反向標的
  if (!risk.allow_opposite_positions) {
    const sign = Math.sign(symbolConfig.leverage);
    const holding = new Set([
      ...getPositions(db).filter((p) => p.qty > 0).map((p) => p.symbol),
      ...openBuys.map((o) => o.symbol),
    ]);
    const opposite = [...holding].filter((s) => Math.sign(config.symbols[s]?.leverage ?? 1) === -sign);
    if (opposite.length > 0) {
      throw riskRejected(
        'OPPOSITE_POSITION',
        `持有或掛單中的 ${opposite.join('、')} 與 ${req.symbol} 方向相反，須先出清一方（allow_opposite_positions = false）`,
        { opposite },
      );
    }
  }

  // 8. 單一持股上限：買進後該股市值 ≤ 總權益 × max_position_pct
  const lastPrice = quote.last_x100;
  const heldQty = getPosition(db, req.symbol).qty;
  const pendingBuyValue = openBuys
    .filter((o) => o.symbol === req.symbol)
    .reduce((sum, o) => sum + tradeValue(o.price_x100, o.remaining), 0);
  const positionAfter = tradeValue(lastPrice, heldQty) + pendingBuyValue + value;
  const positionLimit = Math.floor((valuation.equity * risk.max_position_pct) / 100);
  if (positionAfter > positionLimit) {
    throw riskRejected(
      'POSITION_LIMIT_EXCEEDED',
      `買進後 ${req.symbol} 市值約 ${positionAfter} 元，超過總權益 ${valuation.equity} 元 × ${risk.max_position_pct}% = ${positionLimit} 元`,
      { after: positionAfter, limit: positionLimit },
    );
  }

  // 13. 總曝險上限：Σ 市值 × |槓桿倍數|，含未完成買單
  const pendingExposure = openBuys.reduce(
    (sum, o) => sum + tradeValue(o.price_x100, o.remaining) * Math.abs(config.symbols[o.symbol]?.leverage ?? 1),
    0,
  );
  const exposureAfter = valuation.gross_exposure + pendingExposure + value * Math.abs(symbolConfig.leverage);
  const exposureLimit = Math.floor((valuation.equity * risk.max_exposure_pct) / 100);
  if (exposureAfter > exposureLimit) {
    throw riskRejected(
      'EXPOSURE_LIMIT_EXCEEDED',
      `買進後總曝險約 ${exposureAfter} 元，超過總權益 ${valuation.equity} 元 × ${risk.max_exposure_pct}% = ${exposureLimit} 元`,
      { after: exposureAfter, limit: exposureLimit },
    );
  }
}

/** 第 9、12 條：每日委託次數與每分鐘送單次數（只計 Claude 的委託）。 */
function checkFrequency(db: DB, req: OrderRequest, perDay: number, perMinute: number, now: Date): void {
  const today = db
    .prepare(`SELECT COUNT(*) FROM orders WHERE origin = 'claude' AND created_at >= ?`)
    .pluck()
    .get(twDayStartIso(now)) as number;
  if (today >= perDay) {
    throw riskRejected('DAILY_ORDER_LIMIT', `今日已委託 ${today} 次，達每日上限 ${perDay} 次`, { today, limit: perDay });
  }
  const recent = countRecentRequests(db, now);
  if (recent >= perMinute) {
    throw riskRejected('RATE_LIMIT', `最近一分鐘已送出 ${recent} 筆新單或刪單，達每分鐘上限 ${perMinute} 筆，請稍後再試`, {
      recent,
      limit: perMinute,
    });
  }
}

/** 最近 60 秒內 Claude 的新單加刪單數。 */
export function countRecentRequests(db: DB, now: Date): number {
  const since = toTwIso(new Date(now.getTime() - 60_000));
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM orders WHERE origin = 'claude' AND created_at >= ?)
            + (SELECT COUNT(*) FROM orders WHERE origin = 'claude' AND cancel_requested_at >= ?)`,
    )
    .pluck()
    .get(since, since) as number;
}

/**
 * 第 10 條：同一標的每日完整買賣回合數 ≤ 上限，且賣出成交後冷卻期間不得再買進。
 * 只限制再進場，不限制減碼或出場。
 * 回合數 = min(今日有成交的買單數, 今日有成交的賣單數)。
 */
function checkReentry(db: DB, symbol: string, maxRoundTrips: number, cooldownMin: number, now: Date): void {
  const dayStart = twDayStartIso(now);
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys,
         SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells
       FROM orders WHERE symbol = ? AND filled_qty > 0 AND created_at >= ?`,
    )
    .get(symbol, dayStart) as { buys: number | null; sells: number | null };
  const roundTrips = Math.min(counts.buys ?? 0, counts.sells ?? 0);
  if (roundTrips >= maxRoundTrips) {
    throw riskRejected(
      'ROUND_TRIP_LIMIT',
      `${symbol} 今日已完成 ${roundTrips} 個買賣回合，達每日上限 ${maxRoundTrips}，今日不得再買進（賣出不受限）`,
      { roundTrips, limit: maxRoundTrips },
    );
  }

  const lastSell = db
    .prepare(
      `SELECT f.ts FROM fills f JOIN orders o ON o.id = f.order_id
       WHERE o.symbol = ? AND o.side = 'sell' ORDER BY f.ts DESC LIMIT 1`,
    )
    .pluck()
    .get(symbol) as string | undefined;
  if (lastSell) {
    const elapsedMin = (now.getTime() - Date.parse(lastSell)) / 60_000;
    if (elapsedMin < cooldownMin) {
      const until = toTwIso(new Date(Date.parse(lastSell) + cooldownMin * 60_000));
      throw riskRejected(
        'REENTRY_COOLDOWN',
        `${symbol} 於 ${lastSell} 賣出成交，冷卻 ${cooldownMin} 分鐘內不得再買進，${until} 後可買`,
        { lastSell, cooldownMin, until },
      );
    }
  }
}

// ---------------------------------------------------------------- 停機條件（規格第 6 節）

export interface HaltResult {
  rule: 'daily_loss_limit' | 'intraday_drawdown' | 'max_drawdown';
  reason: string;
  detail: Record<string, number>;
}

/**
 * 更新權益高點並檢查三個以權益計算的停機條件。
 * 對帳差異、API 連續失敗、連續拒單由各自的流程觸發，不在這裡。
 *
 * 依賴 system_state：day_start_equity（開盤前由 daemon 設定）、intraday_peak_equity、peak_equity。
 */
export function evaluateEquityHalts(db: DB, equity: number, clock: Clock): HaltResult | null {
  const risk = getRiskParams(db);
  const num = (key: string) => {
    const v = getState(db, key);
    return v === null ? null : Number(v);
  };

  const dayStart = num('day_start_equity');
  let intradayPeak = num('intraday_peak_equity');
  let peak = num('peak_equity');

  if (intradayPeak === null || equity > intradayPeak) {
    intradayPeak = Math.max(equity, dayStart ?? equity);
    setState(db, 'intraday_peak_equity', String(intradayPeak), clock);
  }
  if (peak === null) {
    // 歷史高點只在收盤快照時更新；尚未初始化時以目前權益起算
    peak = equity;
    setState(db, 'peak_equity', String(peak), clock);
  }

  if (dayStart !== null && dayStart > 0) {
    const loss = dayStart - equity;
    const limit = (dayStart * risk.daily_loss_limit_pct) / 100;
    if (loss >= limit) {
      return {
        rule: 'daily_loss_limit',
        reason: `當日虧損 ${loss} 元，達開盤前權益 ${dayStart} 元的 ${risk.daily_loss_limit_pct}%`,
        detail: { dayStart, equity, loss, limit },
      };
    }
  }
  if (intradayPeak > 0) {
    const ddPct = ((intradayPeak - equity) / intradayPeak) * 100;
    if (ddPct >= risk.intraday_drawdown_pct) {
      return {
        rule: 'intraday_drawdown',
        reason: `當日盤中自高點 ${intradayPeak} 元回撤 ${ddPct.toFixed(2)}%，達門檻 ${risk.intraday_drawdown_pct}%`,
        detail: { intradayPeak, equity, ddPct },
      };
    }
  }
  if (peak > 0) {
    const ddPct = ((peak - equity) / peak) * 100;
    if (ddPct >= risk.max_drawdown_pct) {
      return {
        rule: 'max_drawdown',
        reason: `自歷史權益高點 ${peak} 元回撤 ${ddPct.toFixed(2)}%，達門檻 ${risk.max_drawdown_pct}%`,
        detail: { peak, equity, ddPct },
      };
    }
  }
  return null;
}

/**
 * 資金或持股異動時，按比例縮放當日與歷史權益高點，讓回撤比例不因資金進出而改變（規格第 6 節）。
 */
export function scalePeaksForFlow(db: DB, equityBefore: number, equityAfter: number, clock: Clock): void {
  if (equityBefore <= 0) {
    // 從零開始撥入：高點直接以撥入後權益初始化
    setState(db, 'peak_equity', String(equityAfter), clock);
    setState(db, 'intraday_peak_equity', String(equityAfter), clock);
    if (getState(db, 'day_start_equity') !== null) setState(db, 'day_start_equity', String(equityAfter), clock);
    return;
  }
  const ratio = equityAfter / equityBefore;
  for (const key of ['peak_equity', 'intraday_peak_equity', 'day_start_equity']) {
    const v = getState(db, key);
    if (v !== null) setState(db, key, String(Math.round(Number(v) * ratio)), clock);
  }
}
