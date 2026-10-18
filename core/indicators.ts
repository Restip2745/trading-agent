/**
 * 技術指標（純函式）。ctrade indicators 與回測腳本共用同一份計算，確保實盤與回測的定義一致。
 *
 * 單位：價格為「元」（浮點，指標本身不涉及下單金額）；日 K 成交量為「股」（含零股與鉅額），
 * 5 分 K 成交量為「張」（只含整股）。量的比較一律在同一單位內進行，不跨單位換算。
 *
 * 指標的選用與參數由策略 skill 決定；這裡只負責「怎麼算」。
 */

export interface Bar {
  /** 日 K 為 YYYY-MM-DD；5 分 K 為該根的起始時間（ISO，含 +08:00） */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 簡單移動平均：最後 n 個值的平均。資料不足 n 個時回傳 null。 */
export function sma(values: number[], n: number): number | null {
  if (!Number.isInteger(n) || n <= 0 || values.length < n) return null;
  return mean(values.slice(-n));
}

/**
 * 「含今天」的移動平均：把目前價格當作今天的收盤，與前 n−1 天收盤一起平均。
 * 用於盤中（例如 13:20）判斷「若現在收盤，均線會在哪裡」。closes 不含今天。
 */
export function smaIncludingToday(closes: number[], todayPrice: number, n: number): number | null {
  if (n <= 0 || closes.length < n - 1) return null;
  return mean([...closes.slice(-(n - 1)), todayPrice]);
}

/** 指數移動平均，以前 n 個值的 SMA 作為起點。 */
export function ema(values: number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  const k = 2 / (n + 1);
  let e = mean(values.slice(0, n));
  for (const v of values.slice(n)) e = v * k + e * (1 - k);
  return e;
}

/** RSI（Wilder 平滑）。資料不足 n+1 個時回傳 null。 */
export function rsi(values: number[], n = 14): number | null {
  if (values.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** ATR（Wilder 平滑，真實波幅）。資料不足 n+1 根時回傳 null。 */
export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const tr = bars.slice(1).map((b, i) => {
    const prevClose = bars[i]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  let a = mean(tr.slice(0, n));
  for (const t of tr.slice(n)) a = (a * (n - 1) + t) / n;
  return a;
}

/**
 * 盤中累計成交均價（VWAP）：以每根 K 線的典型價格（高 + 低 + 收）/ 3 依成交量加權。
 * 歷史 5 分 K 沒有逐筆均價，所以實盤與回測都用這個近似值，確保一致。
 * 成交量為 0 時回傳 null。
 */
export function vwap(bars: Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/** 已完成的 K 線：起始時間 + 週期 ≤ 現在。盤中最新一根尚未收完時排除。 */
export function completedBars(bars: Bar[], now: Date, intervalMin: number): Bar[] {
  return bars.filter((b) => Date.parse(b.date) + intervalMin * 60_000 <= now.getTime());
}

/** 依交易日把 5 分 K 分組，回傳每日成交量加總（張），依日期排序。 */
export function dailyLotsFromIntraday(bars: Bar[]): { date: string; lots: number }[] {
  const byDay = new Map<string, number>();
  for (const b of bars) {
    const d = b.date.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + b.volume);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, lots]) => ({ date, lots }));
}

// ---------------------------------------------------------------- 給 ctrade indicators 的彙整

export interface DailyIndicators {
  /** 最近一根日 K（不含今天）的日期與收盤 */
  prev_date: string | null;
  prev_close: number | null;
  /** 各週期的 SMA：不含今天、昨日（往前一天）、含今天（以目前價格代入） */
  sma: Record<string, { value: number | null; prev_day: number | null; including_today: number | null }>;
  rsi14: number | null;
  atr14: number | null;
  /** 近 n 日最高、最低（不含今天） */
  high20: number | null;
  low20: number | null;
}

export function dailyIndicators(daily: Bar[], todayPrice: number | null, periods: number[]): DailyIndicators {
  const closes = daily.map((b) => b.close);
  const sma_: DailyIndicators['sma'] = {};
  for (const n of periods) {
    sma_[String(n)] = {
      value: sma(closes, n),
      prev_day: sma(closes.slice(0, -1), n),
      including_today: todayPrice === null ? null : smaIncludingToday(closes, todayPrice, n),
    };
  }
  const last20 = daily.slice(-20);
  return {
    prev_date: daily.at(-1)?.date.slice(0, 10) ?? null,
    prev_close: daily.at(-1)?.close ?? null,
    sma: sma_,
    rsi14: rsi(closes, 14),
    atr14: atr(daily, 14),
    high20: last20.length ? Math.max(...last20.map((b) => b.high)) : null,
    low20: last20.length ? Math.min(...last20.map((b) => b.low)) : null,
  };
}

export interface IntradayIndicators {
  bars_completed: number;
  vwap: number | null;
  last_price: number | null;
  /** (VWAP − 最後成交價) ÷ VWAP；正值代表低於均價 */
  below_vwap_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  /** 最後成交價相對當日最低價的漲幅 */
  above_day_low_pct: number | null;
  /** 最近一根已完成的 5 分 K 與前一根 */
  last_bar: (Bar & { volume_vs_avg: number | null; close_above_prev_close: boolean | null }) | null;
  prev_bar: Bar | null;
  /** 今天已完成 5 分 K 的平均成交量（張） */
  avg_bar_lots: number | null;
  /** 今天已完成 5 分 K 的成交量加總（張）、近 20 個交易日每日成交量平均（張，以 5 分 K 加總）、兩者比值 */
  today_lots: number | null;
  avg20_daily_lots: number | null;
  today_vs_avg20: number | null;
}

export function intradayIndicators(
  todayBars: Bar[],
  pastIntraday: Bar[],
  lastPrice: number | null,
  now: Date,
  intervalMin = 5,
): IntradayIndicators {
  const done = completedBars(todayBars, now, intervalMin);
  const v = vwap(done);
  const last = lastPrice ?? done.at(-1)?.close ?? null;
  const dayHigh = todayBars.length ? Math.max(...todayBars.map((b) => b.high)) : null;
  const dayLow = todayBars.length ? Math.min(...todayBars.map((b) => b.low)) : null;
  const avgBar = done.length ? mean(done.map((b) => b.volume)) : null;
  const lastBar = done.at(-1) ?? null;
  const prevBar = done.at(-2) ?? null;
  // 只計已完成的 K 線，與回測（以 13:15 那根收完時的累計量判斷）一致
  const todayLots = done.length ? done.reduce((s, b) => s + b.volume, 0) : null;
  const past = dailyLotsFromIntraday(pastIntraday).slice(-20);
  const avg20 = past.length ? mean(past.map((d) => d.lots)) : null;
  return {
    bars_completed: done.length,
    vwap: v,
    last_price: last,
    below_vwap_pct: v !== null && last !== null ? (v - last) / v : null,
    day_high: dayHigh,
    day_low: dayLow,
    above_day_low_pct: dayLow !== null && last !== null ? last / dayLow - 1 : null,
    last_bar: lastBar && {
      ...lastBar,
      volume_vs_avg: avgBar ? lastBar.volume / avgBar : null,
      close_above_prev_close: prevBar ? lastBar.close > prevBar.close : null,
    },
    prev_bar: prevBar,
    avg_bar_lots: avgBar,
    today_lots: todayLots,
    avg20_daily_lots: avg20,
    today_vs_avg20: todayLots !== null && avg20 ? todayLots / avg20 : null,
  };
}
