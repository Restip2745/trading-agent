import type { MarketRules, Session, SymbolCategory } from './config.js';
import { invalidArgs } from './errors.js';

/**
 * 金額與價格計算。價格一律以整數「分」表示（price_x100），金額一律是整數「元」，
 * 全程不經過浮點數（規格第 4 節）。
 */

/** "55.2"、"55.20"、55.2 → 5520。超過兩位小數就拒絕，不偷偷四捨五入。 */
export function parsePrice(input: string | number): number {
  const s = typeof input === 'number' ? String(input) : input.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw invalidArgs('INVALID_PRICE', `價格 ${JSON.stringify(input)} 格式錯誤，須為正數且最多兩位小數`);
  const x100 = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (x100 <= 0) throw invalidArgs('INVALID_PRICE', `價格必須大於 0`);
  return x100;
}

/** 5520 → "55.20" */
export function formatPrice(x100: number): string {
  const sign = x100 < 0 ? '-' : '';
  const abs = Math.abs(x100);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 元為單位的設定值 → 分，例如 0.05 → 5。 */
export const yuanToX100 = (yuan: number) => Math.round(yuan * 100);

/** 該價位的升降單位（分）。 */
export function tickSize(priceX100: number, category: SymbolCategory, rules: MarketRules): number {
  const table = rules.tick_sizes[category];
  let tick = yuanToX100(table[0]?.[1] ?? 0.01);
  for (const [floor, size] of table) {
    if (priceX100 >= yuanToX100(floor)) tick = yuanToX100(size);
  }
  return tick;
}

/** 價格是否落在升降單位上。跨級距時以該價格所在級距判斷。 */
export function isOnTick(priceX100: number, category: SymbolCategory, rules: MarketRules): boolean {
  return priceX100 % tickSize(priceX100, category, rules) === 0;
}

/** 不合法價格的上下最近合法價。 */
export function nearestTicks(priceX100: number, category: SymbolCategory, rules: MarketRules): { below: number; above: number } {
  const tick = tickSize(priceX100, category, rules);
  const below = Math.floor(priceX100 / tick) * tick;
  let above = below + tick;
  // 往上可能跨進較大的級距，要對齊新級距
  const upperTick = tickSize(above, category, rules);
  if (above % upperTick !== 0) above = Math.ceil(above / upperTick) * upperTick;
  return { below, above };
}

/** 價金（元，無條件捨去）。 */
export function tradeValue(priceX100: number, qty: number): number {
  return Math.floor((priceX100 * qty) / 100);
}

export interface FeeSchedule {
  id: number;
  effective_date: string;
  fee_rate_ppm: number;
  fee_discount_bp: number;
  rebate_mode: 'instant' | 'monthly';
  min_fee_regular: number;
  min_fee_odd: number;
  tax_stock_ppm: number;
  tax_daytrade_ppm: number;
  tax_etf_ppm: number;
}

/**
 * 手續費（元，無條件捨去，再套最低手續費）。
 * 月退制在成交當下收全額，折扣日後以 fee_rebate 入帳（規格第 7 節）。
 */
export function calcFee(value: number, session: Session, schedule: FeeSchedule): number {
  const discountBp = schedule.rebate_mode === 'instant' ? schedule.fee_discount_bp : 10_000;
  const raw = Math.floor((value * schedule.fee_rate_ppm * discountBp) / 1_000_000 / 10_000);
  const min = session === 'regular' ? schedule.min_fee_regular : schedule.min_fee_odd;
  return Math.max(raw, min);
}

/** 證交稅（元，無條件捨去），只在賣出時收取。ETF 不論是否當沖都是 ETF 稅率。 */
export function calcTax(value: number, category: SymbolCategory, dayTrade: boolean, schedule: FeeSchedule): number {
  const ppm =
    category === 'etf' ? schedule.tax_etf_ppm : dayTrade ? schedule.tax_daytrade_ppm : schedule.tax_stock_ppm;
  return Math.floor((value * ppm) / 1_000_000);
}

/** 買單圈存金額：價金 + 預估手續費。 */
export function buyReservation(priceX100: number, qty: number, session: Session, schedule: FeeSchedule): number {
  const value = tradeValue(priceX100, qty);
  return value + calcFee(value, session, schedule);
}

export const pctToPpm = (pct: number) => Math.round(pct * 10_000);
export const ppmToPct = (ppm: number) => ppm / 10_000;
