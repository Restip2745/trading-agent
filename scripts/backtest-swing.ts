/**
 * 0050 波段策略回測：順著日線趨勢分批買進、跨日持有、趨勢轉弱才出場，並以成交量確認進出場。
 *
 *   npx tsx scripts/backtest-swing.ts [--from 2025-10-20] [--to 2026-10-16] [--equity 200000] [--discount 0.6]
 *
 * 比較的版本（不做參數最佳化，只比較結構）：
 *   買進持有        第一天以 90% 權益買進並持有到最後（基準）
 *   盤勢持有        多頭盤勢時持有 90% 權益，盤勢轉弱（13:20 價格跌破 MA20 且 MA20 下彎，或跌破 MA60）出清
 *   拉回分批        多頭或中性盤勢中，盤中偏離 VWAP ≥ 0.5% 並止跌時分批買進（每批 30% 權益），出場同上
 *   拉回分批＋量    同上，但止跌 K 線的成交量要高於當日 5 分 K 平均（承接買盤），
 *                   且 13:20 若當日爆量長黑（跌幅 ≥ 1.5%、成交量 ≥ 20 日均量 1.5 倍）先賣一半
 *
 * 所有版本都有距平均成本 −8% 的硬停損（daemon 執行）；隔夜跳空低於停損時以開盤價成交。
 * 13:20 的決策以 13:15 那根 5 分 K 的收盤價代表（實際收盤競價可能略有差異）。
 * 手續費 = 價金 × 0.1425% × 折扣（無條件捨去，零股最低 1 元），ETF 證交稅 0.1%；單筆上限 60,000 元，零股 999 股。
 */
import { keyringStore, resolveMarketCredentials } from '../core/secrets.js';
import { EsunMarketDataApi } from '../daemon/esun/api.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const FROM = arg('from', '2025-10-20');
const TO = arg('to', '2026-10-16');
const EQUITY = Number(arg('equity', '200000'));
const DISCOUNT = Number(arg('discount', '0.6'));
const MAX_ORDER = 60_000;
const TRANCHE = 0.3; // 每批占權益比例
const MAX_ALLOC = 0.9; // 最高投入比例
const HARD_STOP = 0.08;
const SYM = '0050';

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

// ---------------------------------------------------------------- 資料

const md = await resolveMarketCredentials(keyringStore);
if (!md) throw new Error('沒有行情金鑰，請先 ctrade-admin secrets import');
const api = new EsunMarketDataApi(md.creds);
await api.login();
const rest = (api as unknown as { sdk: { restClient: { stock: any } } }).sdk.restClient.stock;

async function candles(symbol: string, timeframe: string, from: string, to: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = new Date(Math.min(Date.parse(cursor) + 179 * 86_400_000, Date.parse(to))).toISOString().slice(0, 10);
    const r = await rest.historical.candles({ symbol, from: cursor, to: end, timeframe });
    if (r.statusCode && r.statusCode !== 404) throw new Error(`${symbol} ${timeframe}: HTTP ${r.statusCode} ${r.message}`);
    out.push(...((r.data as Bar[] | undefined) ?? []));
    cursor = new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10);
    await new Promise((res) => setTimeout(res, 1100));
  }
  return [...new Map(out.map((b) => [b.date, b])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

const daily = await candles(SYM, 'D', new Date(Date.parse(FROM) - 130 * 86_400_000).toISOString().slice(0, 10), TO);
const intraday = new Map<string, Bar[]>();
for (const b of await candles(SYM, '5', FROM, TO)) {
  const d = b.date.slice(0, 10);
  (intraday.get(d) ?? intraday.set(d, []).get(d)!).push(b);
}
const days = [...intraday.keys()].sort();
/**
 * 分割調整：日 K 出現 > 30% 的缺口時視為分割（例如 0050 於 2025-06-18 一拆四），
 * 把缺口之前的日 K 與 5 分 K 價格除以倍數、成交量乘以倍數，讓均線與報酬連續。
 */
for (let i = 1; i < daily.length; i++) {
  const r = daily[i]!.close / daily[i - 1]!.close;
  if (r >= 0.7 && r <= 1.3) continue;
  const factor = Math.round(r < 1 ? 1 / r : r);
  const splitDate = daily[i]!.date.slice(0, 10);
  const adj = (b: Bar) => {
    const k = r < 1 ? 1 / factor : factor;
    b.open *= k;
    b.high *= k;
    b.low *= k;
    b.close *= k;
    b.volume /= k;
  };
  for (let j = 0; j < i; j++) adj(daily[j]!);
  for (const [d, bars] of intraday) if (d < splitDate) bars.forEach(adj);
  console.warn(`分割調整：${SYM} 於 ${splitDate} 有 ${((r - 1) * 100).toFixed(1)}% 缺口，視為 1:${factor}，已調整之前的價格與成交量`);
}

const priorDaily = (day: string) => daily.filter((b) => b.date.slice(0, 10) < day);

/**
 * 20 日均量（張）。日 K 的成交量單位是「股」且含零股與鉅額交易（約為 5 分 K 加總的 1.1 倍），
 * 5 分 K 與報價累計量的單位是「張」、只含整股，兩者不能直接比較。
 * 以前 20 天 5 分 K 的每日加總計算；回測起點前資料不足時以日 K ÷ 1100 近似。
 */
function avgLots20(day: string): number {
  const prior = days.filter((d) => d < day).slice(-20);
  const fromIntraday = prior.map((d) => intraday.get(d)!.reduce((s, b) => s + b.volume, 0));
  const missing = 20 - fromIntraday.length;
  const fromDaily = priorDaily(day).slice(-20, -20 + missing || undefined).slice(0, missing).map((b) => b.volume / 1100);
  const all = [...fromDaily, ...fromIntraday];
  return all.reduce((x, y) => x + y, 0) / all.length;
}
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---------------------------------------------------------------- 模擬

type Mode = 'hold' | 'regime' | 'pullback' | 'pullback-volume';
/** 出場規則：ma20slope 跌破下彎的 MA20 或跌破 MA60；ma20x2 連續兩天收在 MA20 之下或跌破 MA60；ma60 只看 MA60 */
type Exit = 'ma20slope' | 'ma20x2' | 'ma60';
interface Opts { exit: Exit; seed: boolean }

function simulate(mode: Mode, o: Opts = { exit: 'ma20slope', seed: false }) {
  const fee = (value: number) => Math.max(1, Math.floor(value * 0.001425 * DISCOUNT));
  let cash = EQUITY;
  let qty = 0;
  let costBasis = 0; // 含手續費的總成本
  let peak = EQUITY;
  let maxDD = 0;
  let daysInMarket = 0;
  let buys = 0;
  let sells = 0;
  let feesTax = 0;
  const realized: number[] = [];

  const buy = (price: number, budget: number) => {
    let q = Math.min(999, Math.floor(Math.min(budget, MAX_ORDER, cash) / price));
    while (q > 0 && Math.floor(price * q) + fee(Math.floor(price * q)) > cash) q--;
    if (q <= 0) return;
    const value = Math.floor(price * q);
    const f = fee(value);
    cash -= value + f;
    qty += q;
    costBasis += value + f;
    feesTax += f;
    buys++;
  };
  const sell = (price: number, q: number) => {
    q = Math.min(q, qty);
    if (q <= 0) return;
    const value = Math.floor(price * q);
    const f = fee(value);
    const tax = Math.floor(value * 0.001);
    const removed = (costBasis * q) / qty;
    cash += value - f - tax;
    realized.push(value - f - tax - removed);
    costBasis -= removed;
    qty -= q;
    feesTax += f + tax;
    sells++;
  };
  /** 拆成多筆委託直到達到目標投入比例（單筆上限 60,000、零股 999 股）。 */
  const buyTo = (price: number, targetValue: number) => {
    let guard = 0;
    while (qty * price < targetValue - price && cash > price * 2 && guard++ < 10) buy(price, targetValue - qty * price);
  };

  for (const day of days) {
    const bars = intraday.get(day)!;
    const prior = priorDaily(day);
    const closes = prior.map((b) => b.close);
    const ma20 = mean(closes.slice(-20));
    const ma60 = mean(closes.slice(-60));
    const ma20Prev = mean(closes.slice(-21, -1));
    const prevClose = closes.at(-1)!;
    const regime = prevClose >= ma60 && ma20 >= ma60 ? '多頭' : prevClose < ma60 && ma20 < ma60 ? '空頭' : '中性';
    const vol20 = avgLots20(day);

    let pv = 0;
    let vsum = 0;
    let low = Infinity;
    let dayVol = 0;
    let entriesToday = 0;
    if (qty > 0) daysInMarket++;
    const belowMa20Yesterday = prevClose < ma20;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const t = b.date.slice(11, 16);
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vsum += b.volume;
      dayVol += b.volume;
      low = Math.min(low, b.low);
      const vwap = pv / vsum;

      // 硬停損：距平均成本 −8%；開盤跳空低於停損以開盤價成交（買進持有基準不設停損）
      if (qty > 0 && mode !== 'hold') {
        const stop = (costBasis / qty) * (1 - HARD_STOP);
        if (b.low <= stop) sell(Math.min(stop, b.open), qty);
      }

      if (mode === 'hold') {
        if (day === days[0] && i === 0) buyTo(b.open, EQUITY * MAX_ALLOC);
        continue;
      }

      // 進場
      const equityNow = cash + qty * b.close;
      const allocated = qty * b.close;
      if (mode === 'regime') {
        // 13:20 盤勢為多頭時補到目標比例
        // 13:20 盤勢為多頭時補到目標比例；只在差距超過半批時補，避免每天小額補單
        if (t === '13:15' && regime === '多頭' && allocated < equityNow * (MAX_ALLOC - TRANCHE / 2)) buyTo(b.close, equityNow * MAX_ALLOC);
      } else if (o.seed && t === '13:15' && regime === '多頭' && qty === 0) {
        // 盤勢為多頭且空手：13:20 先買第一批，之後逢拉回加碼
        buyTo(b.close, equityNow * TRANCHE);
        entriesToday++;
      } else if (regime !== '空頭' && t >= '09:30' && t <= '13:10' && entriesToday < 1 && allocated < equityNow * (MAX_ALLOC - TRANCHE / 2) && i > 0) {
        const prev = bars[i - 1]!;
        const dev = (vwap - b.close) / vwap;
        const reversal = b.close > prev.close && b.close >= low * 1.002;
        const avgBarVol = vsum / (i + 1);
        const volumeOk = mode !== 'pullback-volume' || b.volume >= avgBarVol;
        if (dev >= 0.005 && reversal && volumeOk) {
          buyTo(b.close, Math.min(equityNow * MAX_ALLOC, allocated + equityNow * TRANCHE * (regime === '中性' ? 0.5 : 1)));
          entriesToday++;
        }
      }

      // 13:20 出場判斷（以 13:15 那根收盤代表）
      if (t === '13:15' && qty > 0) {
        const px = b.close;
        const ma20Today = mean([...closes.slice(-19), px]);
        const ma60Today = mean([...closes.slice(-59), px]);
        const trendBroken =
          px < ma60Today ||
          (o.exit === 'ma20slope' && px < ma20Today && ma20Today < ma20Prev) ||
          (o.exit === 'ma20x2' && px < ma20Today && belowMa20Yesterday);
        if (trendBroken) sell(px, qty);
        else if (mode === 'pullback-volume') {
          const chg = px / prevClose - 1;
          const heavy = dayVol >= vol20 * 1.5 * 0.95; // 13:20 時約已成交全日 95% 的量
          if (chg <= -0.015 && heavy) sell(px, Math.floor(qty / 2));
        }
      }
    }

    const equity = cash + qty * bars.at(-1)!.close;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  const last = intraday.get(days.at(-1)!)!.at(-1)!.close;
  const equity = cash + qty * last;
  return {
    mode,
    ret: equity / EQUITY - 1,
    maxDD,
    exposure: daysInMarket / days.length,
    buys,
    sells,
    feesTax,
    trades: realized.length,
    winRate: realized.length ? realized.filter((x) => x > 0).length / realized.length : 0,
    openQty: qty,
  };
}

/**
 * 核心＋衛星：兩個部位分開記帳、共用現金。
 *   核心 60%：13:20 盤勢為多頭時建到 60%，價格跌破 MA60 才出清（吃趨勢）。
 *   衛星 30%：盤中偏離 VWAP ≥ 0.5%、止跌且止跌 K 線量高於當日平均時買進一批（30%）；
 *            13:20 爆量長黑（跌幅 ≥ 1.5%、量 ≥ 20 日均量 1.5 倍）或跌破下彎的 MA20 時賣出（短波段）。
 *   兩者共用 −8% 硬停損（各自以自己的平均成本計算）。
 */
function simulateCoreSatellite(coreAlloc = 0.6, satAlloc = 0.3) {
  const fee = (value: number) => Math.max(1, Math.floor(value * 0.001425 * DISCOUNT));
  let cash = EQUITY;
  const sleeves = { core: { qty: 0, cost: 0 }, sat: { qty: 0, cost: 0 } };
  let peak = EQUITY;
  let maxDD = 0;
  let inMarket = 0;
  let buys = 0;
  let sells = 0;
  let feesTax = 0;
  const realized = { core: [] as number[], sat: [] as number[] };

  const buy = (sl: keyof typeof sleeves, price: number, budget: number) => {
    let guard = 0;
    while (budget > price && cash > price && guard++ < 10) {
      let q = Math.min(999, Math.floor(Math.min(budget, MAX_ORDER, cash) / price));
      while (q > 0 && Math.floor(price * q) + fee(Math.floor(price * q)) > cash) q--;
      if (q <= 0) return;
      const value = Math.floor(price * q);
      const f = fee(value);
      cash -= value + f;
      sleeves[sl].qty += q;
      sleeves[sl].cost += value + f;
      feesTax += f;
      budget -= value;
      buys++;
    }
  };
  const sell = (sl: keyof typeof sleeves, price: number, q: number) => {
    const s = sleeves[sl];
    q = Math.min(q, s.qty);
    if (q <= 0) return;
    const value = Math.floor(price * q);
    const f = fee(value);
    const tax = Math.floor(value * 0.001);
    const removed = (s.cost * q) / s.qty;
    cash += value - f - tax;
    realized[sl].push(value - f - tax - removed);
    s.cost -= removed;
    s.qty -= q;
    feesTax += f + tax;
    sells++;
  };

  for (const day of days) {
    const bars = intraday.get(day)!;
    const prior = priorDaily(day);
    const closes = prior.map((b) => b.close);
    const ma20 = mean(closes.slice(-20));
    const ma60 = mean(closes.slice(-60));
    const ma20Prev = mean(closes.slice(-21, -1));
    const prevClose = closes.at(-1)!;
    const regime = prevClose >= ma60 && ma20 >= ma60 ? '多頭' : prevClose < ma60 && ma20 < ma60 ? '空頭' : '中性';
    const vol20 = avgLots20(day);
    let pv = 0;
    let vsum = 0;
    let low = Infinity;
    let dayVol = 0;
    let satEntered = false;
    if (sleeves.core.qty + sleeves.sat.qty > 0) inMarket++;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const t = b.date.slice(11, 16);
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vsum += b.volume;
      dayVol += b.volume;
      low = Math.min(low, b.low);
      const vwap = pv / vsum;
      const equityNow = cash + (sleeves.core.qty + sleeves.sat.qty) * b.close;

      for (const sl of ['core', 'sat'] as const) {
        const s = sleeves[sl];
        if (s.qty > 0 && b.low <= (s.cost / s.qty) * (1 - HARD_STOP)) sell(sl, Math.min((s.cost / s.qty) * (1 - HARD_STOP), b.open), s.qty);
      }

      // 衛星進場：拉回 + 止跌 + 量
      if (regime !== '空頭' && !satEntered && sleeves.sat.qty === 0 && t >= '09:30' && t <= '13:10' && i > 0) {
        const prev = bars[i - 1]!;
        const dev = (vwap - b.close) / vwap;
        if (dev >= 0.005 && b.close > prev.close && b.close >= low * 1.002 && b.volume >= vsum / (i + 1)) {
          buy('sat', b.close, equityNow * satAlloc * (regime === '中性' ? 0.5 : 1));
          satEntered = true;
        }
      }

      if (t === '13:15') {
        const px = b.close;
        const ma20Today = mean([...closes.slice(-19), px]);
        const ma60Today = mean([...closes.slice(-59), px]);
        // 核心
        if (sleeves.core.qty > 0 && px < ma60Today) sell('core', px, sleeves.core.qty);
        else if (regime === '多頭' && px >= ma60Today && sleeves.core.qty * px < equityNow * (coreAlloc - 0.15)) {
          buy('core', px, equityNow * coreAlloc - sleeves.core.qty * px);
        }
        // 衛星
        if (sleeves.sat.qty > 0) {
          const heavyDown = px / prevClose - 1 <= -0.015 && dayVol >= vol20 * 1.5 * 0.95;
          const weak = (px < ma20Today && ma20Today < ma20Prev) || px < ma60Today;
          if (heavyDown || weak) sell('sat', px, sleeves.sat.qty);
        }
      }
    }
    const equity = cash + (sleeves.core.qty + sleeves.sat.qty) * bars.at(-1)!.close;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const last = intraday.get(days.at(-1)!)!.at(-1)!.close;
  const equity = cash + (sleeves.core.qty + sleeves.sat.qty) * last;
  const wr = (xs: number[]) => (xs.length ? xs.filter((x) => x > 0).length / xs.length : 0);
  return {
    ret: equity / EQUITY - 1,
    maxDD,
    exposure: inMarket / days.length,
    buys,
    sells,
    feesTax,
    coreTrades: realized.core.length,
    satTrades: realized.sat.length,
    satWin: wr(realized.sat),
    satPnl: realized.sat.reduce((a, b) => a + b, 0),
  };
}

console.log(`${SYM} 波段回測 ${FROM} ~ ${TO}，${days.length} 個交易日，起始權益 ${EQUITY.toLocaleString()} 元，手續費 ${DISCOUNT} 折`);
const label: Record<Mode, string> = { hold: '買進持有（基準）', regime: '盤勢持有', pullback: '拉回分批', 'pullback-volume': '拉回分批＋量' };
const exitLabel: Record<Exit, string> = { ma20slope: 'MA20下彎', ma20x2: 'MA20連2日', ma60: '只看MA60' };
console.log('版本              出場        先買第一批  報酬     最大回撤  報酬/回撤  持有天數  買進  賣出  已實現勝率  手續費與稅');
const runs: [Mode, Opts][] = [['hold', { exit: 'ma60', seed: false }]];
for (const exit of ['ma20slope', 'ma20x2', 'ma60'] as Exit[]) {
  runs.push(['regime', { exit, seed: false }]);
  for (const seed of [false, true]) runs.push(['pullback-volume', { exit, seed }]);
}
for (const [m, o] of runs) {
  const r = simulate(m, o);
  console.log(
    `${label[m].padEnd(14)} ${(m === 'hold' ? '-' : exitLabel[o.exit]).padEnd(10)} ${(m === 'pullback-volume' ? (o.seed ? '是' : '否') : '-').padEnd(9)} ` +
      `${(r.ret * 100).toFixed(1).padStart(6)}%  ${(r.maxDD * 100).toFixed(1).padStart(6)}%  ${(r.ret / Math.max(r.maxDD, 0.001)).toFixed(2).padStart(8)}  ` +
      `${(r.exposure * 100).toFixed(0).padStart(6)}%  ${String(r.buys).padStart(4)}  ${String(r.sells).padStart(4)}  ` +
      `${r.trades ? (r.winRate * 100).toFixed(0).padStart(8) + '%' : '        -'}  ${String(Math.round(r.feesTax)).padStart(9)}`,
  );
}

for (const [c, st] of [[0.6, 0.3], [0.9, 0]] as const) {
  const r = simulateCoreSatellite(c, st);
  console.log(
    `
核心 ${c * 100}%＋衛星 ${st * 100}%：報酬 ${(r.ret * 100).toFixed(1)}%、最大回撤 ${(r.maxDD * 100).toFixed(1)}%、報酬/回撤 ${(r.ret / r.maxDD).toFixed(2)}、` +
      `持有天數 ${(r.exposure * 100).toFixed(0)}%、買進 ${r.buys}／賣出 ${r.sells}、手續費與稅 ${Math.round(r.feesTax)} 元`,
  );
  if (st > 0) console.log(`  衛星：已實現 ${r.satTrades} 筆、勝率 ${(r.satWin * 100).toFixed(0)}%、已實現損益 ${Math.round(r.satPnl)} 元；核心出場 ${r.coreTrades} 次`);
}
