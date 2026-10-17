import { getTriggerConfig } from '../core/claude-ops.js';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { getPositions } from '../core/ledger.js';
import type { QuoteSource } from '../core/market.js';
import { formatPrice } from '../core/money.js';
import { getMarketRules, getRiskParams } from '../core/settings.js';
import { getState, isTradingDay } from '../core/state.js';
import { type Clock, twDate, twHhmm } from '../core/time.js';

/**
 * 觸發排程（規格第 8 節）。判斷「要不要叫 Claude」全部用固定規則，不經過模型。
 * 這裡只負責決定哪些觸發到期；排隊、合併與執行由 TriggerLoop 處理。
 */

export type TriggerKind = 'pre_open' | 'open' | 'interval' | 'price_move' | 'pre_close' | 'stop_triggered' | 'review';

export const FIXED_KINDS = ['pre_open', 'open', 'pre_close', 'review'] as const;
export type FixedKind = (typeof FIXED_KINDS)[number];

export interface DueTrigger {
  kind: TriggerKind;
  fixed: boolean;
  reason: string;
  detail?: Record<string, unknown>;
  /** 固定觸發因系統中斷而延後執行 */
  missed?: boolean;
}

/** 錯過固定觸發超過這個時間，視為系統曾中斷，提示中要告知 Claude。 */
const MISSED_AFTER_MIN = 5;

export class TriggerScheduler {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly quotes: QuoteSource,
  ) {}

  /** 今天已執行（或已略過）的固定觸發。 */
  private firedToday(kind: string, today: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM trigger_events WHERE kind = ? AND substr(ts, 1, 10) = ? LIMIT 1`)
      .get(kind, today);
  }

  /**
   * 到期的固定觸發。重啟時錯過多個盤中固定觸發，只補跑最近的一個，較早的記為已略過；
   * 收盤後才發現錯過的 pre_close 不補跑（已無法下單），錯過的 review 一定補跑（規格第 17 節）。
   */
  dueFixed(): { run?: DueTrigger; superseded: FixedKind[] } {
    const now = this.clock.now();
    if (!isTradingDay(this.db, now)) return { superseded: [] };
    const today = twDate(now);
    const time = twHhmm(now);
    const rules = getMarketRules(this.db, today);
    const times = rules.fixed_triggers as Record<FixedKind, string>;
    const closeTime = rules.sessions.regular.accept[1];

    const due = FIXED_KINDS.filter((k) => times[k] && time >= times[k] && !this.firedToday(k, today));
    if (due.length === 0) return { superseded: [] };

    // review 獨立於盤中觸發：一定執行
    if (due.includes('review')) {
      return { run: this.fixed('review', times.review, time), superseded: due.filter((k) => k !== 'review') };
    }
    const intraday = due.filter((k) => !(k === 'pre_close' && time >= closeTime));
    const skipped = due.filter((k) => !intraday.includes(k));
    const latest = intraday[intraday.length - 1];
    if (!latest) return { superseded: skipped };
    return { run: this.fixed(latest, times[latest], time), superseded: [...skipped, ...intraday.slice(0, -1)] };
  }

  private fixed(kind: FixedKind, scheduled: string, now: string): DueTrigger {
    const missed = minutesBetween(scheduled, now) > MISSED_AFTER_MIN;
    return {
      kind,
      fixed: true,
      reason: missed ? `固定觸發 ${kind}（原定 ${scheduled}，系統中斷後於 ${now} 補跑）` : `固定觸發 ${kind}（${scheduled}）`,
      missed,
    };
  }

  /** 動態觸發只在整股盤中（開盤後第一次決策之後、收盤前）運作。 */
  inDynamicWindow(): boolean {
    const now = this.clock.now();
    if (!isTradingDay(this.db, now)) return false;
    const today = twDate(now);
    const rules = getMarketRules(this.db, today);
    const time = twHhmm(now);
    const open = (rules.fixed_triggers as Record<string, string>).open ?? '09:01';
    const close = rules.sessions.regular.accept[1];
    return time >= open && time < close && this.firedToday('open', today);
  }

  /** 定時觸發：距離上次 Claude 工作階段結束滿 interval_min 分鐘。 */
  dueInterval(): DueTrigger | undefined {
    if (!this.inDynamicWindow()) return undefined;
    const { interval_min } = getTriggerConfig(this.db);
    if (interval_min === null) return undefined;
    const last = getState(this.db, 'last_claude_end');
    if (!last) return undefined;
    const elapsed = (this.clock.now().getTime() - Date.parse(last)) / 60_000;
    if (elapsed < interval_min) return undefined;
    return { kind: 'interval', fixed: false, reason: `定時觸發（每 ${interval_min} 分鐘）` };
  }

  /**
   * 價格觸發：持股或觀察清單中任一檔，相對上次 Claude 決策時的價格（price_refs）
   * 漲幅 ≥ up_pct 或跌幅 ≥ down_pct。
   */
  duePriceMove(): DueTrigger | undefined {
    if (!this.inDynamicWindow()) return undefined;
    const { up_pct, down_pct } = getTriggerConfig(this.db);
    if (up_pct === null || down_pct === null) return undefined;

    const moves: Record<string, unknown>[] = [];
    for (const symbol of this.watchSymbols()) {
      const ref = this.db
        .prepare('SELECT price_x100 FROM price_refs WHERE symbol = ? ORDER BY id DESC LIMIT 1')
        .pluck()
        .get(symbol) as number | undefined;
      const q = this.quotes.getQuote(symbol);
      if (!ref || !q) continue;
      const pct = ((q.last_x100 - ref) / ref) * 100;
      if (pct >= up_pct || pct <= -down_pct) {
        moves.push({ symbol, ref: formatPrice(ref), last: formatPrice(q.last_x100), change_pct: Number(pct.toFixed(2)) });
      }
    }
    if (moves.length === 0) return undefined;
    const desc = moves.map((m) => `${m.symbol} ${m.ref}→${m.last}（${m.change_pct}%）`).join('、');
    return { kind: 'price_move', fixed: false, reason: `價格觸發：${desc}`, detail: { moves, up_pct, down_pct } };
  }

  /** 持股加上白名單（第一版的觀察清單即白名單）。 */
  watchSymbols(): string[] {
    const held = getPositions(this.db).filter((p) => p.qty > 0).map((p) => p.symbol);
    return [...new Set([...held, ...getRiskParams(this.db).symbols_allowlist])];
  }
}

function minutesBetween(a: string, b: string): number {
  const toMin = (s: string) => {
    const [h = 0, m = 0] = s.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(b) - toMin(a);
}
