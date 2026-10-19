import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { internalError } from './errors.js';

export type Mode = 'paper' | 'live';
export type Session = 'regular' | 'odd_intraday' | 'odd_after';
export const SESSIONS: readonly Session[] = ['regular', 'odd_intraday', 'odd_after'];

export type SymbolCategory = 'stock' | 'etf';

export interface SymbolConfig {
  name: string;
  category: SymbolCategory;
  leverage: number;
}

export interface RiskParams {
  max_order_amount: number;
  max_position_pct: number;
  max_exposure_pct: number;
  allow_opposite_positions: boolean;
  max_orders_per_day: number;
  max_orders_per_minute: number;
  max_round_trips_per_day: number;
  reentry_cooldown_min: number;
  daily_loss_limit_pct: number;
  intraday_drawdown_pct: number;
  max_drawdown_pct: number;
  max_api_failures: number;
  max_broker_rejects: number;
  symbols_allowlist: string[];
  trigger_interval_min_range: [number, number];
  trigger_up_pct_range: [number, number];
  trigger_down_pct_range: [number, number];
}

export interface FeeConfig {
  fee_rate_pct: number;
  fee_discount: number;
  rebate_mode: 'instant' | 'monthly';
  min_fee_regular: number;
  min_fee_odd: number;
  tax_stock_pct: number;
  tax_daytrade_pct: number;
  tax_etf_pct: number;
}

export interface MarketRules {
  price_limit_pct: number;
  odd_intraday_match_interval_sec: number;
  /** 整股逐筆交易時段 [開始, 結束)，其餘委託時間為集合競價 */
  continuous: [string, string];
  sessions: Record<Session, { accept: [string, string] }>;
  /** [價格下限（元）, 升降單位（元）] */
  tick_sizes: Record<SymbolCategory, [number, number][]>;
  fixed_triggers: Record<string, string>;
}

export interface Config {
  mode: Mode;
  risk: RiskParams;
  trigger: { defaults: { interval_min: number; up_pct: number; down_pct: number } };
  symbols: Record<string, SymbolConfig>;
  fees: FeeConfig;
  market: MarketRules;
  paper: { fill_at_touch: boolean; max_volume_share_pct: number; submit_delay_ms: [number, number] };
  review: { min_days: number; min_trades: number };
  model: { intraday: string; review: string };
  claude: { bin: string; timeout_min: number; max_budget_usd: number; extra_args: string[] };
  stops: { order_ticks: number; resend_interval_sec: number };
  web?: { port: number };
  usage: { daily_budget_tokens: number; weekly_budget_tokens: number };
  /** 盤外資訊（規格第 14 節）：美股、台指期夜盤、匯率的抓取 */
  market_context?: { enabled: boolean; refresh_min: number };
}

/**
 * 專案根目錄。daemon 會設定 CTRADE_HOME，讓在復盤 worktree 內執行的 ctrade
 * 仍然讀寫專案目錄的同一份帳本（規格第 9 節）。
 */
export function projectRoot(): string {
  const fromEnv = process.env.CTRADE_HOME;
  if (fromEnv) return resolve(fromEnv);

  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'trading-agent') return dir;
    const parent = dirname(dir);
    if (parent === dir) throw internalError('ROOT_NOT_FOUND', '找不到專案根目錄，請設定 CTRADE_HOME');
    dir = parent;
  }
}

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k];
    out[k] = isPlain(prev) && isPlain(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

function readToml(path: string): Plain {
  try {
    return parse(readFileSync(path, 'utf8')) as Plain;
  } catch (e) {
    throw internalError('CONFIG_PARSE', `設定檔 ${path} 無法解析：${(e as Error).message}`);
  }
}

/**
 * 決定交易模式。CTRADE_MODE 只能用來宣告預期的模式：
 * 與設定檔不一致時拒絕執行，不以任一方為準（規格第 3 節）。
 */
export function resolveMode(configMode: unknown, envMode: string | undefined): Mode {
  if (configMode !== 'paper' && configMode !== 'live') {
    throw internalError('CONFIG_MODE', `設定檔的 mode 必須是 "paper" 或 "live"，目前為 ${JSON.stringify(configMode)}`);
  }
  if (envMode !== undefined && envMode !== '' && envMode.toLowerCase() !== configMode) {
    throw internalError(
      'MODE_MISMATCH',
      `環境變數 CTRADE_MODE=${envMode} 與設定檔 mode=${configMode} 不一致，拒絕執行`,
      { env: envMode, config: configMode },
    );
  }
  return configMode;
}

export function loadConfig(root = projectRoot()): Config {
  const mainPath = join(root, 'config', 'config.toml');
  if (!existsSync(mainPath)) throw internalError('CONFIG_MISSING', `找不到設定檔 ${mainPath}`);
  let raw = readToml(mainPath);
  const localPath = join(root, 'config', 'local.toml');
  if (existsSync(localPath)) raw = deepMerge(raw, readToml(localPath));

  const config = raw as unknown as Config;
  config.mode = resolveMode(raw.mode, process.env.CTRADE_MODE);
  validateConfig(config);
  return config;
}

function validateConfig(c: Config): void {
  for (const key of ['risk', 'trigger', 'symbols', 'fees', 'market'] as const) {
    if (!isPlain(c[key])) throw internalError('CONFIG_INVALID', `設定檔缺少 [${key}] 區段`);
  }
  for (const [symbol, s] of Object.entries(c.symbols)) {
    if (s.category !== 'stock' && s.category !== 'etf') {
      throw internalError('CONFIG_INVALID', `symbols.${symbol}.category 必須是 stock 或 etf`);
    }
    if (!Number.isInteger(s.leverage) || s.leverage === 0) {
      throw internalError('CONFIG_INVALID', `symbols.${symbol}.leverage 必須是非零整數`);
    }
  }
  for (const session of SESSIONS) {
    if (!c.market.sessions?.[session]?.accept) {
      throw internalError('CONFIG_INVALID', `設定檔缺少 market.sessions.${session}.accept`);
    }
  }
}

export function dbPath(root: string, mode: Mode): string {
  return join(root, 'data', `${mode}.db`);
}
