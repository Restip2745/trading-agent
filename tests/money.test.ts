import { describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config.js';
import {
  type FeeSchedule,
  buyReservation,
  calcFee,
  calcTax,
  formatPrice,
  isOnTick,
  nearestTicks,
  parsePrice,
  tickSize,
  tradeValue,
} from '../core/money.js';

const rules = loadConfig().market;

const schedule: FeeSchedule = {
  id: 1,
  effective_date: '1970-01-01',
  fee_rate_ppm: 1425,
  fee_discount_bp: 10_000,
  rebate_mode: 'instant',
  min_fee_regular: 20,
  min_fee_odd: 1,
  tax_stock_ppm: 3000,
  tax_daytrade_ppm: 1500,
  tax_etf_ppm: 1000,
};

describe('價格解析與格式', () => {
  it('解析為整數分，不經過浮點', () => {
    expect(parsePrice('55.2')).toBe(5520);
    expect(parsePrice('55.20')).toBe(5520);
    expect(parsePrice('0.01')).toBe(1);
    expect(parsePrice(195.5)).toBe(19550);
    expect(parsePrice('100')).toBe(10000);
  });

  it('拒絕超過兩位小數、負數與零', () => {
    expect(() => parsePrice('55.123')).toThrow(/最多兩位小數/);
    expect(() => parsePrice('-1')).toThrow();
    expect(() => parsePrice('0')).toThrow(/大於 0/);
    expect(() => parsePrice('abc')).toThrow();
  });

  it('格式化', () => {
    expect(formatPrice(5520)).toBe('55.20');
    expect(formatPrice(5)).toBe('0.05');
    expect(formatPrice(-150)).toBe('-1.50');
  });
});

describe('升降單位', () => {
  it('ETF：50 元以下 0.01，50 元以上 0.05', () => {
    expect(tickSize(4999, 'etf', rules)).toBe(1);
    expect(tickSize(5000, 'etf', rules)).toBe(5);
    expect(isOnTick(5003, 'etf', rules)).toBe(false);
    expect(isOnTick(5005, 'etf', rules)).toBe(true);
    expect(isOnTick(4999, 'etf', rules)).toBe(true);
  });

  it('股票級距', () => {
    expect(tickSize(999, 'stock', rules)).toBe(1);
    expect(tickSize(1000, 'stock', rules)).toBe(5);
    expect(tickSize(10000, 'stock', rules)).toBe(50);
    expect(tickSize(100000, 'stock', rules)).toBe(500);
  });

  it('回報最近的合法價格，跨級距時對齊上一級距', () => {
    expect(nearestTicks(5003, 'etf', rules)).toEqual({ below: 5000, above: 5005 });
    expect(nearestTicks(1003, 'stock', rules)).toEqual({ below: 1000, above: 1005 });
  });
});

describe('費用', () => {
  it('價金無條件捨去到元', () => {
    expect(tradeValue(4567, 3)).toBe(137); // 137.01
    expect(tradeValue(5520, 100)).toBe(5520);
  });

  it('手續費：費率 × 折扣，無條件捨去，套最低手續費', () => {
    expect(calcFee(100_000, 'regular', schedule)).toBe(142); // 142.5
    expect(calcFee(5_000, 'regular', schedule)).toBe(20); // 7 → 最低 20
    expect(calcFee(5_000, 'odd_intraday', schedule)).toBe(7);
    expect(calcFee(100, 'odd_intraday', schedule)).toBe(1); // 0 → 最低 1
    expect(calcFee(100_000, 'regular', { ...schedule, fee_discount_bp: 2800 })).toBe(39); // 39.9
  });

  it('月退制成交當下收全額', () => {
    expect(calcFee(100_000, 'regular', { ...schedule, fee_discount_bp: 2800, rebate_mode: 'monthly' })).toBe(142);
  });

  it('證交稅：ETF 0.1%、股票 0.3%、股票當沖 0.15%，ETF 當沖仍為 0.1%', () => {
    expect(calcTax(100_000, 'etf', false, schedule)).toBe(100);
    expect(calcTax(100_000, 'etf', true, schedule)).toBe(100);
    expect(calcTax(100_000, 'stock', false, schedule)).toBe(300);
    expect(calcTax(100_000, 'stock', true, schedule)).toBe(150);
  });

  it('買單圈存 = 價金 + 預估手續費', () => {
    expect(buyReservation(5000, 200, 'odd_intraday', schedule)).toBe(10_000 + 14);
  });
});
