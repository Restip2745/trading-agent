import { describe, expect, it } from 'vitest';
import {
  type Bar,
  atr,
  completedBars,
  dailyIndicators,
  dailyLotsFromIntraday,
  ema,
  intradayIndicators,
  rsi,
  sma,
  smaIncludingToday,
  vwap,
} from '../core/indicators.js';

const bar = (date: string, o: number, h: number, l: number, c: number, v = 1): Bar => ({ date, open: o, high: h, low: l, close: c, volume: v });

describe('均線', () => {
  it('SMA 取最後 n 個，資料不足回 null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2], 3)).toBeNull();
  });

  it('含今天的 SMA：前 n−1 天加上目前價格', () => {
    expect(smaIncludingToday([10, 20, 30, 40], 50, 3)).toBe(40); // (30 + 40 + 50) / 3
    expect(smaIncludingToday([10], 50, 3)).toBeNull();
  });

  it('EMA 以前 n 個的 SMA 起算', () => {
    // k = 2/3；起點 (1+2)/2 = 1.5；下一個 3×2/3 + 1.5×1/3 = 2.5
    expect(ema([1, 2, 3], 2)).toBeCloseTo(2.5);
  });
});

describe('RSI 與 ATR（Wilder）', () => {
  it('只漲不跌時 RSI 為 100；Wilder 平滑逐步手算', () => {
    expect(rsi([1, 2, 3, 4, 5], 3)).toBe(100);
    // n=2：起始漲 0.5／跌 0.5，之後依序 +1 −1 +1 −1 平滑為漲 0.34375／跌 0.65625，RS = 0.5238
    expect(rsi([10, 11, 10, 11, 10, 11, 10], 2)).toBeCloseTo(34.375, 6);
  });

  it('ATR 取真實波幅（含跳空）', () => {
    const bars = [bar('d1', 10, 11, 9, 10), bar('d2', 12, 13, 12, 12.5), bar('d3', 12, 12.5, 11.5, 12)];
    // TR：d2 = max(1, |13−10|, |12−10|) = 3；d3 = max(1, |12.5−12.5|, |11.5−12.5|) = 1；ATR(2) = 2
    expect(atr(bars, 2)).toBe(2);
    expect(atr(bars, 3)).toBeNull();
  });
});

describe('VWAP 與已完成 K 線', () => {
  it('以典型價格依量加權', () => {
    const bars = [bar('t1', 10, 12, 9, 9, 1), bar('t2', 20, 20, 20, 20, 3)]; // 典型價 10 與 20
    expect(vwap(bars)).toBe((10 * 1 + 20 * 3) / 4);
    expect(vwap([bar('t', 1, 1, 1, 1, 0)])).toBeNull();
  });

  it('只保留已收完的 K 線', () => {
    const bars = [bar('2026-10-19T09:00:00.000+08:00', 1, 1, 1, 1), bar('2026-10-19T09:05:00.000+08:00', 1, 1, 1, 1)];
    expect(completedBars(bars, new Date('2026-10-19T09:07:00.000+08:00'), 5)).toHaveLength(1);
    expect(completedBars(bars, new Date('2026-10-19T09:10:00.000+08:00'), 5)).toHaveLength(2);
  });

  it('依交易日加總 5 分 K 的量', () => {
    const bars = [bar('2026-10-15T09:00:00.000+08:00', 1, 1, 1, 1, 5), bar('2026-10-15T09:05:00.000+08:00', 1, 1, 1, 1, 7), bar('2026-10-16T09:00:00.000+08:00', 1, 1, 1, 1, 3)];
    expect(dailyLotsFromIntraday(bars)).toEqual([
      { date: '2026-10-15', lots: 12 },
      { date: '2026-10-16', lots: 3 },
    ]);
  });
});

describe('彙整', () => {
  it('日線：昨收、各週期 SMA（不含今天、昨日、含今天）', () => {
    const daily = Array.from({ length: 25 }, (_, i) => bar(`2026-09-${String(i + 1).padStart(2, '0')}`, i + 1, i + 1.5, i + 0.5, i + 1));
    const d = dailyIndicators(daily, 30, [20]);
    expect(d.prev_close).toBe(25);
    expect(d.sma['20']).toEqual({
      value: 15.5, // 收盤 6..25 的平均
      prev_day: 14.5, // 收盤 5..24 的平均
      including_today: 16.7, // (7..25 的總和 304 + 今天 30) / 20
    });
  });

  it('盤中：偏離 VWAP、離日低、止跌 K 線與量', () => {
    const t = (hhmm: string) => `2026-10-19T${hhmm}:00.000+08:00`;
    const today = [
      bar(t('09:00'), 110, 110, 109, 109, 100),
      bar(t('09:05'), 109, 109, 108, 108.2, 50),
      bar(t('09:10'), 108.2, 108.6, 108.1, 108.5, 80), // 收盤高於前一根收盤，量 80
      bar(t('09:15'), 108.5, 108.6, 108.4, 108.5, 10), // 尚未收完
    ];
    const past = [bar('2026-10-16T09:00:00.000+08:00', 1, 1, 1, 1, 200), bar('2026-10-15T09:00:00.000+08:00', 1, 1, 1, 1, 260)];
    const r = intradayIndicators(today, past, 108.5, new Date(t('09:17')));
    expect(r.bars_completed).toBe(3);
    expect(r.vwap).toBeCloseTo(((109.333333 * 100) + (108.4 * 50) + (108.4 * 80)) / 230, 3);
    expect(r.below_vwap_pct).toBeCloseTo((108.806 - 108.5) / 108.806, 4); // VWAP 約 108.806
    expect(r.day_low).toBe(108);
    expect(r.above_day_low_pct).toBeCloseTo(0.5 / 108, 6);
    expect(r.last_bar).toMatchObject({ close: 108.5, close_above_prev_close: true });
    expect(r.last_bar?.volume_vs_avg).toBeCloseTo(80 / (230 / 3), 6);
    expect(r.today_lots).toBe(230); // 不含尚未收完的 09:15
    expect(r.avg20_daily_lots).toBe(230);
    expect(r.today_vs_avg20).toBe(1);
  });

  it('沒有今天的資料時回傳 null，不會出錯', () => {
    const r = intradayIndicators([], [], null, new Date());
    expect(r).toMatchObject({ vwap: null, last_price: null, below_vwap_pct: null, last_bar: null, today_lots: null });
  });
});
