import type { Bar, DailyIndicators, IntradayIndicators } from './indicators.js';

/**
 * ctrade indicators 的欄位目錄：輸出格式、ctrade indicators --list、Web UI 的指標面板、
 * 策略檔引用檢查都以這份為準。新增指標時在這裡登記，並在 indicatorsReport 輸出。
 */

export interface IndicatorField {
  /** 欄位路徑；<n> 代表均線週期（由 --sma 指定） */
  path: string;
  group: 'daily' | 'intraday' | 'meta';
  unit: string;
  description: string;
}

export const DEFAULT_SMA_PERIODS = [20, 60];

const barFields = (prefix: string, which: string): IndicatorField[] => [
  { path: `${prefix}.start`, group: 'intraday', unit: '時間', description: `${which}的起始時間` },
  { path: `${prefix}.open`, group: 'intraday', unit: '元', description: `${which}的開盤價` },
  { path: `${prefix}.high`, group: 'intraday', unit: '元', description: `${which}的最高價` },
  { path: `${prefix}.low`, group: 'intraday', unit: '元', description: `${which}的最低價` },
  { path: `${prefix}.close`, group: 'intraday', unit: '元', description: `${which}的收盤價` },
  { path: `${prefix}.volume_lots`, group: 'intraday', unit: '張', description: `${which}的成交量` },
];

export const INDICATOR_FIELDS: IndicatorField[] = [
  { path: 'symbol', group: 'meta', unit: '', description: '代號' },
  { path: 'as_of', group: 'meta', unit: '時間', description: '計算時間' },
  { path: 'last_price', group: 'meta', unit: '元', description: '最後成交價' },

  { path: 'daily.prev_date', group: 'daily', unit: '日期', description: '最近一根日 K（不含今天）的日期' },
  { path: 'daily.prev_close', group: 'daily', unit: '元', description: '最近一根日 K（不含今天）的收盤＝昨收' },
  { path: 'daily.sma.<n>.value', group: 'daily', unit: '元', description: '最近 n 根日 K 收盤的平均（不含今天）＝昨日的 MA' },
  { path: 'daily.sma.<n>.prev_day', group: 'daily', unit: '元', description: '前一天的 MA（再往前一根）' },
  { path: 'daily.sma.<n>.including_today', group: 'daily', unit: '元', description: '前 n−1 根收盤加上最後成交價的平均＝「若現在收盤」的 MA' },
  { path: 'daily.rsi14', group: 'daily', unit: '0–100', description: 'RSI（Wilder 平滑，14 日，不含今天）' },
  { path: 'daily.atr14', group: 'daily', unit: '元', description: 'ATR 真實波幅（Wilder 平滑，14 日，不含今天）' },
  { path: 'daily.high20', group: 'daily', unit: '元', description: '近 20 日最高價（不含今天）' },
  { path: 'daily.low20', group: 'daily', unit: '元', description: '近 20 日最低價（不含今天）' },

  { path: 'intraday.bars_completed', group: 'intraday', unit: '根', description: '今天已收完的 5 分 K 根數' },
  { path: 'intraday.vwap', group: 'intraday', unit: '元', description: '今天已收完的 5 分 K，以典型價格（高＋低＋收）/3 依量加權（與回測相同）' },
  { path: 'intraday.below_vwap_pct', group: 'intraday', unit: '%', description: '(VWAP − 最後成交價) ÷ VWAP；正值代表低於均價' },
  { path: 'intraday.day_high', group: 'intraday', unit: '元', description: '今天的最高價' },
  { path: 'intraday.day_low', group: 'intraday', unit: '元', description: '今天的最低價' },
  { path: 'intraday.above_day_low_pct', group: 'intraday', unit: '%', description: '最後成交價相對當日最低價的漲幅' },
  ...barFields('intraday.last_bar', '最近一根已收完的 5 分 K'),
  { path: 'intraday.last_bar.volume_vs_avg', group: 'intraday', unit: '倍', description: '最近一根已收完 5 分 K 的量 ÷ 今天已收完 5 分 K 的平均量' },
  { path: 'intraday.last_bar.close_above_prev_close', group: 'intraday', unit: 'true／false', description: '最近一根已收完 5 分 K 的收盤是否高於前一根收盤' },
  ...barFields('intraday.prev_bar', '倒數第二根已收完的 5 分 K'),
  { path: 'intraday.avg_bar_lots', group: 'intraday', unit: '張', description: '今天已收完 5 分 K 的平均成交量' },
  { path: 'intraday.today_lots', group: 'intraday', unit: '張', description: '今天已收完 5 分 K 的成交量加總' },
  { path: 'intraday.avg20_daily_lots', group: 'intraday', unit: '張', description: '近 20 個交易日每日成交量平均（以 5 分 K 加總）' },
  { path: 'intraday.today_vs_avg20', group: 'intraday', unit: '倍', description: 'today_lots ÷ avg20_daily_lots' },
];

export const INDICATOR_NOTES = [
  '日線指標不含今天；including_today 以最後成交價代入今天的收盤。',
  '盤中指標只計已收完的 5 分 K；量的單位為張；欄位名稱以 _pct 結尾的單位為 %。',
  '開盤前或非交易日，intraday 的欄位為 null。',
  `均線週期預設 ${DEFAULT_SMA_PERIODS.join('、')}；其他週期要加 --sma，例如 --sma 20,60,120。`,
];

// ---------------------------------------------------------------- 輸出

const round = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const pct = (v: number | null, d = 3) => round(v === null ? null : v * 100, d);
const bar = (b: Bar | null) => b && { start: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume_lots: b.volume };

/** ctrade indicators 的輸出。欄位必須與 INDICATOR_FIELDS 一致（測試會比對）。 */
export function indicatorsReport(symbol: string, asOf: string, lastPrice: number | null, d: DailyIndicators, i: IntradayIndicators) {
  const sma = Object.fromEntries(
    Object.entries(d.sma).map(([n, v]) => [n, { value: round(v.value), prev_day: round(v.prev_day), including_today: round(v.including_today) }]),
  );
  return {
    symbol,
    as_of: asOf,
    last_price: lastPrice,
    daily: {
      prev_date: d.prev_date,
      prev_close: d.prev_close,
      sma,
      rsi14: round(d.rsi14),
      atr14: round(d.atr14, 3),
      high20: d.high20,
      low20: d.low20,
    },
    intraday: {
      bars_completed: i.bars_completed,
      vwap: round(i.vwap, 3),
      below_vwap_pct: pct(i.below_vwap_pct),
      day_high: i.day_high,
      day_low: i.day_low,
      above_day_low_pct: pct(i.above_day_low_pct),
      last_bar: i.last_bar && { ...bar(i.last_bar), volume_vs_avg: round(i.last_bar.volume_vs_avg, 2), close_above_prev_close: i.last_bar.close_above_prev_close },
      prev_bar: bar(i.prev_bar),
      avg_bar_lots: round(i.avg_bar_lots, 1),
      today_lots: i.today_lots,
      avg20_daily_lots: round(i.avg20_daily_lots, 0),
      today_vs_avg20: round(i.today_vs_avg20, 3),
    },
    notes: INDICATOR_NOTES,
  };
}

// ---------------------------------------------------------------- 策略檔引用檢查

export interface IndicatorRef {
  token: string;
  /** 對應的目錄欄位；null 代表看起來像指標欄位但目錄裡沒有 */
  field: string | null;
}

export interface RefCheck {
  refs: IndicatorRef[];
  unknown: string[];
  /** 策略引用的均線週期 */
  sma_periods: number[];
  /** 策略以 --sma 指定的週期；沒寫時為預設值 */
  requested_periods: number[];
  /** 引用了、卻不在 requested_periods 裡的週期 */
  missing_periods: number[];
  ok: boolean;
}

/** 每個欄位的每個尾段都是合法的引用：daily.sma.<n>.value、sma.<n>.value 都對應同一個欄位 */
const LEAVES = INDICATOR_FIELDS.filter((f) => f.group !== 'meta').map((f) => f.path);
/** 物件節點（例如 intraday.last_bar、daily.sma.<n>）也可以被引用 */
const NODES = [...new Set(LEAVES.flatMap((p) => p.split('.').slice(0, -1).map((_, k, a) => a.slice(0, k + 1).join('.'))))];
const FIELD_PATTERNS = [...LEAVES, ...NODES].flatMap((path) => {
  const parts = path.split('.');
  return parts
    .map((_, k) => parts.slice(k))
    .filter((suffix) => suffix[0] !== '<n>')
    .map((suffix) => ({ path, re: new RegExp(`^${suffix.join('\\.').replace('<n>', '(\\d+)')}$`) }));
});
/** 欄位路徑的各個片段（daily.sma.<n>.value → sma、value…），用來判斷反引號裡的文字是不是指標引用 */
const SEGMENTS = new Set(FIELD_PATTERNS.flatMap((f) => f.path.split('.').slice(1)).filter((s) => s !== '<n>'));
const GENERIC = new Set(['value', 'open', 'high', 'low', 'close', 'start']);

function looksLikeRef(token: string): boolean {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(token)) return false;
  const parts = token.split('.');
  if (parts[0] === 'daily' || parts[0] === 'intraday') return true;
  return SEGMENTS.has(parts[0]!) && !GENERIC.has(parts[0]!) && (parts.length > 1 || parts[0]!.includes('_'));
}

/**
 * 找出策略文字中以反引號標示的指標欄位（例如 `daily.sma.20.value`、`below_vwap_pct`），
 * 檢查每個都對得到目錄欄位，且用到的均線週期都有被要求計算。
 */
export function checkIndicatorRefs(text: string): RefCheck {
  const refs: IndicatorRef[] = [];
  const periods = new Set<number>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1]!.trim();
    if (!looksLikeRef(token)) continue;
    let field: string | null = null;
    for (const f of FIELD_PATTERNS) {
      const hit = f.re.exec(token);
      if (!hit) continue;
      field = f.path;
      if (hit[1]) periods.add(Number(hit[1]));
      break;
    }
    if (!refs.some((r) => r.token === token)) refs.push({ token, field });
  }
  const sma = /--sma[ =]([\d,]+)/.exec(text);
  const requested = sma ? sma[1]!.split(',').filter(Boolean).map(Number) : DEFAULT_SMA_PERIODS;
  const smaPeriods = [...periods].sort((a, b) => a - b);
  const missing = smaPeriods.filter((n) => !requested.includes(n));
  const unknown = refs.filter((r) => !r.field).map((r) => r.token);
  return { refs, unknown, sma_periods: smaPeriods, requested_periods: requested, missing_periods: missing, ok: unknown.length === 0 && missing.length === 0 };
}
