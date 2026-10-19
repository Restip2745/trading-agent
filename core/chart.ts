import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Bar } from './indicators.js';
import { type Clock, toTwIso, twDate } from './time.js';

/**
 * 決策日誌的盤勢圖：一個交易日的 5 分 K，疊上當天的決策時間點、成交點、停損停利、價格觸發帶，
 * 下方附等效曝險（市值 × 槓桿倍數 ÷ 權益）。
 *
 * 多標的的呈現：主圖只畫一檔基準標的（預設為槓桿 1 倍的 0050）。其他標的追蹤同一個指數，
 * 成交點仍標在基準標的的時間軸上，實際成交價放在說明裡；曝險則換算成等效基準曝險後疊加。
 * 槓桿型 ETF 每日重新平衡，等效曝險只是近似值。
 *
 * 只讀帳本；唯一的寫入是 bar_cache（市場資料快取，與帳本無關）。
 */

export type FetchBars = (symbol: string, date: string) => Promise<Bar[]>;

export interface DayBars {
  bars: Bar[];
  source: 'cache' | 'daemon' | 'none';
  error?: string;
}

const BAR_MIN = 5;

/** 預設的基準標的：設定檔中第一檔槓桿 1 倍的標的。 */
export function defaultChartSymbol(config: Config): string {
  const symbols = Object.keys(config.symbols);
  return symbols.find((s) => config.symbols[s]?.leverage === 1) ?? symbols[0] ?? '0050';
}

/**
 * 取一檔標的某一天的 5 分 K：過去的交易日先查快取，沒有才向 daemon 取並存入快取。
 * 取不到時回傳空陣列與錯誤訊息，讓圖表仍能顯示決策與成交。
 */
export async function loadDayBars(cache: DB, symbol: string, date: string, clock: Clock, fetch: FetchBars): Promise<DayBars> {
  const past = date < twDate(clock.now());
  if (past) {
    const row = cache.prepare(`SELECT bars_json FROM bar_cache WHERE symbol = ? AND timeframe = '5m' AND date = ?`).pluck().get(symbol, date) as
      | string
      | undefined;
    if (row) return { bars: JSON.parse(row) as Bar[], source: 'cache' };
  }
  try {
    const bars = (await fetch(symbol, date)).filter((b) => b.date.startsWith(date)).sort((a, b) => a.date.localeCompare(b.date));
    if (past && bars.length) {
      cache
        .prepare(`INSERT OR REPLACE INTO bar_cache (symbol, timeframe, date, bars_json, fetched_at) VALUES (?, '5m', ?, ?, ?)`)
        .run(symbol, date, JSON.stringify(bars), toTwIso(clock.now()));
    }
    return { bars, source: 'daemon' };
  } catch (e) {
    return { bars: [], source: 'none', error: (e as Error).message };
  }
}

/** 這一天開盤時有持股、或當天有持股變動的標的（等效曝險需要它們的價格）。 */
export function involvedSymbols(db: DB, date: string): string[] {
  return db
    .prepare(
      `SELECT symbol FROM position_movements WHERE substr(ts, 1, 10) < ? GROUP BY symbol HAVING SUM(qty) <> 0
       UNION SELECT symbol FROM position_movements WHERE substr(ts, 1, 10) = ?`,
    )
    .pluck()
    .all(date, date) as string[];
}

export interface DecisionOrderSummary {
  orders: number;
  /** 依這次決策送出的委託方向分類：只買、只賣、買賣都有、沒有下單 */
  action: 'buy' | 'sell' | 'both' | 'none';
  /** 委託是否有任何成交（沒有下單時為 false） */
  filled: boolean;
}

export interface ChartDecision extends DecisionOrderSummary {
  id: number;
  ts: string;
  kind: string | null;
  actions: string;
}

/**
 * 決策的委託摘要（盤勢圖的決策標記與決策日誌卡片共用）。
 * 分類看委託方向，不看標的：買進反向 ETF 也算「買入」，看空或看多請對照等效曝險。
 */
export function decisionOrderSummary(db: DB, ids: number[]): Map<number, DecisionOrderSummary> {
  const out = new Map<number, DecisionOrderSummary>(ids.map((id) => [id, { orders: 0, action: 'none', filled: false }]));
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT decision_id, COUNT(*) AS orders, SUM(side = 'buy') AS buys, SUM(side = 'sell') AS sells, SUM(filled_qty) AS filled_qty
       FROM orders WHERE decision_id IN (${ids.map(() => '?').join(', ')}) GROUP BY decision_id`,
    )
    .all(...ids) as { decision_id: number; orders: number; buys: number; sells: number; filled_qty: number }[];
  for (const r of rows) {
    out.set(r.decision_id, {
      orders: r.orders,
      action: r.buys && r.sells ? 'both' : r.buys ? 'buy' : 'sell',
      filled: r.filled_qty > 0,
    });
  }
  return out;
}

export interface ChartFill {
  id: number;
  ts: string;
  symbol: string;
  side: 'buy' | 'sell';
  session: string;
  origin: string;
  price: number;
  qty: number;
  decision_id: number | null;
}

export interface ExposurePart {
  symbol: string;
  qty: number;
  /** 等效基準曝險（元）：市值 × 槓桿倍數，帶正負號 */
  value: number;
  /** value ÷ 權益 */
  pct: number | null;
}

export interface ExposurePoint {
  t: string;
  equity: number;
  net_pct: number | null;
  parts: ExposurePart[];
}

export interface DayChart {
  date: string;
  symbol: string;
  name: string | null;
  bars: Bar[];
  /** 與 bars 對齊的當日累計 VWAP（典型價格依量加權，與 ctrade indicators 相同） */
  vwap: (number | null)[];
  decisions: ChartDecision[];
  fills: ChartFill[];
  /** 基準標的的停損停利，第一筆可能是前一天以前設定、延續到今天的值 */
  stops: { ts: string; stop: number | null; take_profit: number | null }[];
  /** 基準標的的價格觸發帶：參考價 ×（1 ± 門檻） */
  triggers: { ts: string; ref: number | null; upper: number | null; lower: number | null }[];
  exposure: ExposurePoint[];
  exposure_symbols: { symbol: string; leverage: number }[];
}

const yuan = (x100: number | null | undefined) => (x100 === null || x100 === undefined ? null : x100 / 100);
const barEnd = (b: Bar) => new Date(Date.parse(b.date) + BAR_MIN * 60_000);

export function buildDayChart(db: DB, config: Config, date: string, symbol: string, barsBySymbol: Map<string, Bar[]>): DayChart {
  const bars = barsBySymbol.get(symbol) ?? [];
  const leverage = (s: string) => config.symbols[s]?.leverage ?? 1;

  let pv = 0;
  let v = 0;
  const vwap = bars.map((b) => {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    return v > 0 ? pv / v : null;
  });

  const decisionRows = (
    db
      .prepare(
        `SELECT d.id, d.ts, d.actions_json, t.kind
         FROM decisions d LEFT JOIN trigger_events t ON t.id = d.trigger_event_id
         WHERE substr(d.ts, 1, 10) = ? ORDER BY d.ts, d.id`,
      )
      .all(date) as { id: number; ts: string; actions_json: string; kind: string | null }[]
  ).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, actions: actionsText(r.actions_json) }));
  const summary = decisionOrderSummary(db, decisionRows.map((d) => d.id));
  const decisions = decisionRows.map((d) => ({ ...d, ...summary.get(d.id)! }));

  const fills = (
    db
      .prepare(
        `SELECT f.id, f.ts, f.price_x100, f.qty, o.symbol, o.side, o.session, o.origin, o.decision_id
         FROM fills f JOIN orders o ON o.id = f.order_id WHERE substr(f.ts, 1, 10) = ? ORDER BY f.ts, f.id`,
      )
      .all(date) as (Omit<ChartFill, 'price'> & { price_x100: number })[]
  ).map(({ price_x100, ...f }) => ({ ...f, price: price_x100 / 100 }));

  // 前一天以前最後一筆（延續到今天的狀態）＋當天的每一筆
  const carried = (table: string, tsCol: string, extra = '') =>
    `id >= COALESCE((SELECT MAX(id) FROM ${table} WHERE substr(${tsCol}, 1, 10) < ?${extra}), 0)`;

  const stops = (
    db
      .prepare(
        `SELECT ts, stop_x100, take_profit_x100 FROM protective_stops
         WHERE symbol = ? AND ${carried('protective_stops', 'ts', ' AND symbol = ?')} AND substr(ts, 1, 10) <= ? ORDER BY id`,
      )
      .all(symbol, date, symbol, date) as { ts: string; stop_x100: number | null; take_profit_x100: number | null }[]
  ).map((r) => ({ ts: r.ts, stop: yuan(r.stop_x100), take_profit: yuan(r.take_profit_x100) }));

  const refs = db
    .prepare(
      `SELECT set_at AS ts, price_x100 FROM price_refs
       WHERE symbol = ? AND ${carried('price_refs', 'set_at', ' AND symbol = ?')} AND substr(set_at, 1, 10) <= ? ORDER BY id`,
    )
    .all(symbol, date, symbol, date) as { ts: string; price_x100: number }[];
  const configs = db
    .prepare(
      `SELECT set_at AS ts, up_pct, down_pct FROM trigger_config
       WHERE ${carried('trigger_config', 'set_at')} AND substr(set_at, 1, 10) <= ? ORDER BY id`,
    )
    .all(date, date) as { ts: string; up_pct: number | null; down_pct: number | null }[];
  const triggers: DayChart['triggers'] = [];
  {
    let ref: number | null = null;
    let up: number | null = null;
    let down: number | null = null;
    const events = [
      ...refs.map((r) => ({ ts: r.ts, apply: () => void (ref = r.price_x100 / 100) })),
      ...configs.map((c) => ({ ts: c.ts, apply: () => void ((up = c.up_pct), (down = c.down_pct)) })),
    ].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const e of events) {
      e.apply();
      // 價格觸發需要同時設定漲跌門檻（daemon/scheduler.ts）
      const on = ref !== null && up !== null && down !== null;
      triggers.push({ ts: e.ts, ref, upper: on ? ref! * (1 + up! / 100) : null, lower: on ? ref! * (1 - down! / 100) : null });
    }
  }

  const symbols = involvedSymbols(db, date);
  const exposure = bars.length ? exposureSeries(db, date, symbols, bars, barsBySymbol, fills, leverage) : [];

  return {
    date,
    symbol,
    name: config.symbols[symbol]?.name ?? null,
    bars,
    vwap,
    decisions,
    fills,
    stops,
    triggers,
    exposure,
    exposure_symbols: symbols.map((s) => ({ symbol: s, leverage: leverage(s) })),
  };
}

function exposureSeries(
  db: DB,
  date: string,
  symbols: string[],
  bars: Bar[],
  barsBySymbol: Map<string, Bar[]>,
  fills: ChartFill[],
  leverage: (s: string) => number,
): ExposurePoint[] {
  const qty = new Map<string, number>();
  const cost = new Map<string, number>();
  for (const r of db
    .prepare(`SELECT symbol, SUM(qty) AS qty, SUM(cost_x100) AS cost FROM position_movements WHERE substr(ts, 1, 10) < ? GROUP BY symbol`)
    .all(date) as { symbol: string; qty: number; cost: number }[]) {
    qty.set(r.symbol, r.qty);
    cost.set(r.symbol, r.cost);
  }
  let cash = db.prepare('SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE substr(ts, 1, 10) < ?').pluck().get(date) as number;
  const moves = db
    .prepare('SELECT ts, symbol, qty FROM position_movements WHERE substr(ts, 1, 10) = ? ORDER BY ts, id')
    .all(date) as { ts: string; symbol: string; qty: number }[];
  const cashMoves = db.prepare('SELECT ts, amount FROM cash_movements WHERE substr(ts, 1, 10) = ? ORDER BY ts, id').all(date) as {
    ts: string;
    amount: number;
  }[];

  // 估值價格：該標的已收完的最後一根 5 分 K 收盤；沒有 K 線時用當時以前最後一筆成交價，再沒有就用持有成本
  const priceAt = (s: string, t: Date): number | null => {
    const own = barsBySymbol.get(s) ?? [];
    let p: number | null = null;
    for (const b of own) {
      if (barEnd(b) <= t) p = b.close;
      else break;
    }
    if (p === null && own.length) p = own[0]!.open;
    if (p !== null) return p;
    for (const f of fills) if (f.symbol === s && Date.parse(f.ts) <= t.getTime()) p = f.price;
    if (p !== null) return p;
    const q = qty.get(s) ?? 0;
    if (q !== 0) return (cost.get(s) ?? 0) / q / 100;
    return fills.find((f) => f.symbol === s)?.price ?? null;
  };

  const times = bars.map(barEnd);
  // 收盤後（盤後零股、復盤時調整）還有變動時，多一個點
  const lastMove = [...moves, ...cashMoves].map((m) => Date.parse(m.ts)).reduce((a, b) => Math.max(a, b), 0);
  if (lastMove > times[times.length - 1]!.getTime()) times.push(new Date(lastMove));

  let mi = 0;
  let ci = 0;
  return times.map((t) => {
    for (; mi < moves.length && Date.parse(moves[mi]!.ts) <= t.getTime(); mi++) {
      const m = moves[mi]!;
      qty.set(m.symbol, (qty.get(m.symbol) ?? 0) + m.qty);
    }
    for (; ci < cashMoves.length && Date.parse(cashMoves[ci]!.ts) <= t.getTime(); ci++) cash += cashMoves[ci]!.amount;
    const held = symbols.map((s) => {
      const q = qty.get(s) ?? 0;
      const p = q === 0 ? 0 : (priceAt(s, t) ?? 0);
      return { symbol: s, qty: q, market: q * p, value: q * p * leverage(s) };
    });
    const equity = cash + held.reduce((sum, h) => sum + h.market, 0);
    const pct = (x: number) => (equity > 0 ? x / equity : null);
    return {
      t: toTwIso(t),
      equity: Math.round(equity),
      net_pct: pct(held.reduce((sum, h) => sum + h.value, 0)),
      parts: held.map((h) => ({ symbol: h.symbol, qty: h.qty, value: Math.round(h.value), pct: pct(h.value) })),
    };
  });
}

function actionsText(json: string): string {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return json;
  }
}
