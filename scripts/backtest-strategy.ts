/**
 * 盤中反轉策略（.claude/skills/trading-strategy）的歷史回測。
 *
 *   npx tsx scripts/backtest-strategy.ts [--from 2025-10-20] [--to 2026-10-16] [--equity 200000]
 *     [--confirm prev-close|prev-high|green] [--range-filter on|off] [--change-filter on|off]
 *     [--grid]     以 6 折比較各種止跌確認與波動過濾的組合
 *     [--funnel]   列出 0050 訊號在各條件被擋下的天數
 *
 * 從玉山行情 API 取 5 分 K 與日 K（需已匯入 esun-marketdata 或 esun-live 金鑰），
 * 依策略規則以元模擬：盤勢判斷、偏離 VWAP、止跌確認、成本門檻、停損距離上限、部位大小、
 * 回到 VWAP 賣一半、保本、硬停損停利、13:20 時間出場、單日虧損 2% 停止開倉、每日最多 3 次。
 * 手續費 = 價金 × 0.1425% × 折扣（無條件捨去，零股最低 1 元、整股最低 20 元），ETF 證交稅 0.1%。
 *
 * 簡化（結果偏樂觀的部分）：以 5 分 K 收盤價進場且立即成交；停損以停損價成交（不計跳空滑價）；
 * 每根 K 線結束時都評估一次（實際由觸發條件決定何時叫醒 Claude）；不留倉過夜。
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
const MAX_ORDER = Number(arg('max-order', '60000'));
const DISCOUNTS = arg('discounts', '1,0.6,0.38,0.28').split(',').map(Number);

/**
 * 可比較的規則變體。預設值即目前策略（SKILL.md）：
 *   confirm      止跌確認：prev-close 收盤高於前一根收盤；prev-high 收盤高於前一根最高價（v1-draft 最初版本）；green 收紅 K
 *   rangeFilter  當日振幅超過 3% 不交易（與偏離條件矛盾，已移除）
 *   changeFilter 0050 相對昨收漲跌超過 ±3% 不交易
 */
type Confirm = 'prev-close' | 'prev-high' | 'green';
interface Variant { confirm: Confirm; rangeFilter: boolean; changeFilter: boolean; stopOut?: boolean }
const DEFAULT_VARIANT: Variant = {
  confirm: arg('confirm', 'prev-close') as Confirm,
  rangeFilter: arg('range-filter', 'off') === 'on',
  changeFilter: arg('change-filter', 'on') === 'on',
  // 當天被停損一次後不再進場（對應趨勢日連續停損）
  stopOut: arg('stop-out', 'off') === 'on',
};

function confirmed(v: Variant, bar: Bar, prev: Bar): boolean {
  if (v.confirm === 'prev-high') return bar.close > prev.high;
  if (v.confirm === 'prev-close') return bar.close > prev.close;
  return bar.close > bar.open;
}

type Sym = '0050' | '00631L' | '00632R';
interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

/** 各標的的策略參數（SKILL.md 第 2、3、6 節）。 */
const P: Record<Sym, { X: number; stopCap: number; tp: number; be: number; riskPct: number; odd: boolean }> = {
  '0050': { X: 0.008, stopCap: 0.012, tp: 0.015, be: 0.006, riskPct: 0.01, odd: true },
  '00631L': { X: 0.016, stopCap: 0.024, tp: 0.03, be: 0.012, riskPct: 0.005, odd: true },
  '00632R': { X: 0.008, stopCap: 0.012, tp: 0.015, be: 0.006, riskPct: 0.01, odd: false },
};
const tick = (p: number) => (p >= 50 ? 0.05 : 0.01);

// ---------------------------------------------------------------- 取資料

const md = await resolveMarketCredentials(keyringStore);
if (!md) throw new Error('沒有行情金鑰，請先 ctrade-admin secrets import');
const api = new EsunMarketDataApi(md.creds);
await api.login();
const rest = (api as unknown as { sdk: { restClient: { stock: any } } }).sdk.restClient.stock;

/** 單次請求跨度須小於一年（evalis 實測），分段抓取；非交易日區段回 404 時略過。 */
async function candles(symbol: string, timeframe: string, from: string, to: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = new Date(Math.min(Date.parse(cursor) + 179 * 86_400_000, Date.parse(to))).toISOString().slice(0, 10);
    const r = await rest.historical.candles({ symbol, from: cursor, to: end, timeframe });
    if (r.statusCode && r.statusCode !== 404) throw new Error(`${symbol} ${timeframe}: HTTP ${r.statusCode} ${r.message}`);
    out.push(...((r.data as Bar[] | undefined) ?? []));
    cursor = new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10);
    await new Promise((res) => setTimeout(res, 1100)); // 歷史行情每分鐘 60 次
  }
  const unique = new Map(out.map((b) => [b.date, b]));
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const dailyFrom = new Date(Date.parse(FROM) - 120 * 86_400_000).toISOString().slice(0, 10);
const daily0050 = await candles('0050', 'D', dailyFrom, TO);
const intraday: Record<Sym, Map<string, Bar[]>> = { '0050': new Map(), '00631L': new Map(), '00632R': new Map() };
for (const s of Object.keys(intraday) as Sym[]) {
  for (const b of await candles(s, '5', FROM, TO)) {
    const d = b.date.slice(0, 10);
    (intraday[s].get(d) ?? intraday[s].set(d, []).get(d)!).push(b);
  }
}
const days = [...intraday['0050'].keys()].sort();

// 分割或除權會讓日 K 出現大缺口、使均線失真，先檢查
for (let i = 1; i < daily0050.length; i++) {
  const ratio = daily0050[i]!.close / daily0050[i - 1]!.close;
  if (ratio < 0.7 || ratio > 1.3) console.warn(`注意：0050 日 K 在 ${daily0050[i]!.date} 有 ${((ratio - 1) * 100).toFixed(1)}% 的缺口，可能是分割或除權`);
}

// ---------------------------------------------------------------- 模擬

function regime(day: string): '多頭' | '中性' | '空頭' {
  const prior = daily0050.filter((b) => b.date.slice(0, 10) < day);
  const ma = (n: number) => prior.slice(-n).reduce((s, b) => s + b.close, 0) / n;
  const close = prior.at(-1)!.close;
  const [m20, m60] = [ma(20), ma(60)];
  if (close >= m60 && m20 >= m60) return '多頭';
  if (close < m60 && m20 < m60) return '空頭';
  return '中性';
}

interface DayState { pv: number; vol: number; low: number; high: number; open: number; prevClose: number }

function run(discount: number, v: Variant = DEFAULT_VARIANT) {
  const feeOf = (value: number, odd: boolean) => Math.max(odd ? 1 : 20, Math.floor(value * 0.001425 * discount));
  const roundTrip = 0.001425 * discount * 2 + 0.001;
  let equity = EQUITY;
  let peak = EQUITY;
  let maxDD = 0;
  const trades: { day: string; sym: Sym; regime: string; qty: number; net: number; outcome: string }[] = [];
  const regimes = { 多頭: 0, 中性: 0, 空頭: 0 };

  for (const day of days) {
    const reg = regime(day);
    regimes[reg]++;
    const candidates: Sym[] = reg === '空頭' ? ['00632R'] : reg === '多頭' ? ['0050', '00631L'] : ['0050'];
    const state = new Map<Sym, DayState>();
    const prevClose0050 = daily0050.filter((b) => b.date.slice(0, 10) < day).at(-1)!.close;
    let entries = 0;
    let stoppedToday = false;
    let dayPnl = 0;
    const startEquity = equity;
    let pos:
      | { sym: Sym; qty: number; entry: number; stop: number; tpPrice: number; half: boolean; cost: number; odd: boolean; realized: number }
      | undefined;

    const bars0050 = intraday['0050'].get(day) ?? [];
    for (let i = 0; i < bars0050.length; i++) {
      const t = bars0050[i]!.date.slice(11, 16);
      // 更新各標的的 VWAP 與當日高低
      const now: Partial<Record<Sym, { bar: Bar; prev?: Bar; vwap: number; st: DayState }>> = {};
      for (const s of ['0050', '00631L', '00632R'] as Sym[]) {
        const bars = intraday[s].get(day) ?? [];
        const bar = bars.find((b) => b.date === bars0050[i]!.date);
        if (!bar) continue;
        const st = state.get(s) ?? { pv: 0, vol: 0, low: Infinity, high: -Infinity, open: bar.open, prevClose: 0 };
        st.pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
        st.vol += bar.volume;
        st.low = Math.min(st.low, bar.low);
        st.high = Math.max(st.high, bar.high);
        state.set(s, st);
        now[s] = { bar, prev: bars[bars.indexOf(bar) - 1], vwap: st.pv / st.vol, st };
      }

      // ---- 持倉管理
      if (pos) {
        const n = now[pos.sym];
        if (n) {
          const sell = (qty: number, price: number) => {
            const value = Math.floor(price * qty);
            pos!.realized += value - feeOf(value, pos!.odd) - Math.floor(value * 0.001);
            pos!.qty -= qty;
          };
          const hitStop = n.bar.low <= pos.stop;
          if (hitStop) sell(pos.qty, pos.stop);
          else if (n.bar.high >= pos.tpPrice) sell(pos.qty, pos.tpPrice);
          else {
            if (!pos.half && n.bar.high >= n.vwap) {
              sell(Math.floor(pos.qty / 2), n.vwap);
              pos.half = true;
            } else if (pos.half && (n.bar.high >= n.vwap * (1 + P[pos.sym].X / 2) || n.bar.close < n.vwap)) {
              sell(pos.qty, n.bar.high >= n.vwap * (1 + P[pos.sym].X / 2) ? n.vwap * (1 + P[pos.sym].X / 2) : n.bar.close);
            }
            if (pos.qty > 0 && n.bar.high >= pos.entry * (1 + P[pos.sym].be)) pos.stop = Math.max(pos.stop, pos.entry * (1 + roundTrip));
            if (pos.qty > 0 && t >= '13:15') sell(pos.qty, n.bar.close); // 13:20 時間出場
          }
          if (pos.qty === 0) {
            const net = pos.realized - pos.cost;
            equity += net;
            dayPnl += net;
            trades.push({ day, sym: pos.sym, regime: reg, qty: 0, net, outcome: hitStop ? '停損' : net > 0 ? '獲利' : '其他' });
            if (hitStop && net < 0) stoppedToday = true;
            pos = undefined;
            peak = Math.max(peak, equity);
            maxDD = Math.max(maxDD, (peak - equity) / peak);
          }
        }
        continue;
      }

      // ---- 進場判斷（第 2、5 節）
      if (t < '09:25' || t > '12:25' || entries >= 3 || dayPnl <= -0.02 * startEquity) continue;
      if (v.stopOut && stoppedToday) continue;
      const s0050 = now['0050'];
      if (!s0050) continue;
      const chg = s0050.bar.close / prevClose0050 - 1;
      if (v.changeFilter && Math.abs(chg) > 0.03) continue;
      if (v.rangeFilter && (s0050.st.high - s0050.st.low) / s0050.st.low > 0.03) continue;

      const signal = (s: Sym) => {
        const n = now[s];
        if (!n?.prev) return undefined;
        const entry = n.bar.close;
        const dev = (n.vwap - entry) / n.vwap;
        const confirm = confirmed(v, n.bar, n.prev) && entry >= n.st.low * 1.002;
        const stop = n.st.low - 2 * tick(entry);
        if (dev < P[s].X || !confirm) return undefined;
        if ((n.vwap - entry) / entry < 2 * roundTrip) return undefined;
        if ((entry - stop) / entry > P[s].stopCap) return undefined;
        return { entry, stop, vwap: n.vwap };
      };

      let sym: Sym | undefined;
      let sig: ReturnType<typeof signal>;
      if (reg === '多頭') {
        const a = signal('0050');
        const b = signal('00631L');
        if (a && b) [sym, sig] = ['00631L', b];
        else if (a) [sym, sig] = ['0050', a];
      } else {
        sym = candidates[0];
        sig = signal(sym!);
      }
      if (!sym || !sig) continue;

      const risk = equity * P[sym].riskPct * (reg === '中性' ? 0.5 : 1);
      let qty = Math.floor(risk / (sig.entry - sig.stop));
      qty = Math.min(qty, Math.floor(MAX_ORDER / sig.entry));
      if (P[sym].odd) qty = Math.min(qty, 999);
      else qty = qty >= 1000 ? Math.floor(qty / 1000) * 1000 : qty; // 00632R：夠一張就用整股
      if (qty <= 0) continue;
      const odd = P[sym].odd || qty < 1000;
      const value = Math.floor(sig.entry * qty);
      pos = { sym, qty, entry: sig.entry, stop: sig.stop, tpPrice: sig.entry * (1 + P[sym].tp), half: false, cost: value + feeOf(value, odd), odd, realized: 0 };
      entries++;
    }
  }

  const wins = trades.filter((x) => x.net > 0);
  const losses = trades.filter((x) => x.net <= 0);
  const sum = trades.reduce((s, x) => s + x.net, 0);
  return { discount, roundTrip, trades, wins: wins.length, losses: losses.length, sum, equity, maxDD, regimes,
    avgWin: wins.length ? wins.reduce((s, x) => s + x.net, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, x) => s + x.net, 0) / losses.length : 0 };
}

/**
 * 漏斗分析：0050 在進場時段內，有多少天出現「偏離達門檻」，又分別被哪一條條件擋下。
 * 每天只記錄最接近成立的一根（通過最多層條件者）。
 */
function funnel(discount: number) {
  const roundTrip = 0.001425 * discount * 2 + 0.001;
  const v = DEFAULT_VARIANT;
  const stages = ['偏離 ≥ 0.8%', `止跌確認（${v.confirm}）`, '報酬 ≥ 2 倍成本', '停損距離 ≤ 1.2%', '波動過濾', '盤勢允許 0050'];
  const counts = stages.map(() => 0);
  for (const day of days) {
    const bars = intraday['0050'].get(day) ?? [];
    const prevClose = daily0050.filter((b) => b.date.slice(0, 10) < day).at(-1)!.close;
    let pv = 0;
    let vol = 0;
    let low = Infinity;
    let high = -Infinity;
    let best = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vol += b.volume;
      low = Math.min(low, b.low);
      high = Math.max(high, b.high);
      const t = b.date.slice(11, 16);
      if (t < '09:25' || t > '12:25' || i === 0) continue;
      const vwap = pv / vol;
      const entry = b.close;
      const checks = [
        (vwap - entry) / vwap >= P['0050'].X,
        confirmed(v, b, bars[i - 1]!) && entry >= low * 1.002,
        (vwap - entry) / entry >= 2 * roundTrip,
        (entry - (low - 2 * tick(entry))) / entry <= P['0050'].stopCap,
        (!v.changeFilter || Math.abs(entry / prevClose - 1) <= 0.03) && (!v.rangeFilter || (high - low) / low <= 0.03),
        regime(day) !== '空頭',
      ];
      let passed = 0;
      while (passed < checks.length && checks[passed]) passed++;
      best = Math.max(best, passed);
    }
    for (let k = 0; k < best; k++) counts[k]!++;
  }
  console.log(`\n0050 訊號漏斗（折扣 ${discount}，${days.length} 天中有幾天通過到該層）：`);
  stages.forEach((s, k) => console.log(`  ${s.padEnd(14)} ${counts[k]} 天`));
}

console.log(`回測期間 ${FROM} ~ ${TO}，${days.length} 個交易日，起始權益 ${EQUITY.toLocaleString()} 元，單筆上限 ${MAX_ORDER.toLocaleString()} 元`);
console.log(`規則：止跌確認 ${DEFAULT_VARIANT.confirm}、振幅過濾 ${DEFAULT_VARIANT.rangeFilter ? 'on' : 'off'}、漲跌幅過濾 ${DEFAULT_VARIANT.changeFilter ? 'on' : 'off'}`);
if (process.argv.includes('--funnel')) funnel(0.6);
if (process.argv.includes('--grid')) {
  console.log('\n規則組合比較（折扣 0.6）：');
  console.log('止跌確認    振幅過濾  漲跌幅過濾  停損後停手  筆數  賺/賠   勝率   平均獲利  平均虧損  淨損益（報酬率）  最大回撤');
  for (const confirm of ['prev-high', 'prev-close', 'green'] as Confirm[]) {
    for (const [rangeFilter, changeFilter, stopOut] of [[true, true, false], [false, true, false], [false, false, false], [false, true, true]] as const) {
      const r = run(0.6, { confirm, rangeFilter, changeFilter, stopOut });
      const n = r.trades.length;
      console.log(
        `${confirm.padEnd(11)} ${(rangeFilter ? 'on' : 'off').padEnd(8)} ${(changeFilter ? 'on' : 'off').padEnd(10)} ${(stopOut ? 'on' : 'off').padEnd(8)} ${String(n).padStart(4)}  ` +
          `${r.wins}/${r.losses}`.padEnd(7) +
          ` ${n ? ((r.wins / n) * 100).toFixed(0).padStart(3) + '%' : '   -'}  ${String(Math.round(r.avgWin)).padStart(8)}  ${String(Math.round(r.avgLoss)).padStart(8)}  ` +
          `${String(Math.round(r.sum)).padStart(7)}（${((r.sum / EQUITY) * 100).toFixed(2)}%）  ${(r.maxDD * 100).toFixed(2)}%`,
      );
    }
  }
}
if (process.argv.includes('--grid')) process.exit(0);
for (const d of DISCOUNTS) {
  const r = run(d);
  console.log(
    `\n折扣 ${d}（來回成本 ${(r.roundTrip * 100).toFixed(3)}%）：交易 ${r.trades.length} 筆，賺 ${r.wins}／賠 ${r.losses}，` +
      `平均獲利 ${Math.round(r.avgWin)} 元、平均虧損 ${Math.round(r.avgLoss)} 元，淨損益 ${Math.round(r.sum)} 元` +
      `（${((r.sum / EQUITY) * 100).toFixed(2)}%），最大回撤 ${(r.maxDD * 100).toFixed(2)}%`,
  );
  if (d === DISCOUNTS[0]) console.log(`盤勢天數：${JSON.stringify(r.regimes)}`);
  for (const x of r.trades) console.log(`  ${x.day} ${x.regime} ${x.sym} ${x.outcome} ${Math.round(x.net)} 元`);
}
