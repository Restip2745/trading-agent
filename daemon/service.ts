import type { Server } from 'node:net';
import type { Config, Session } from '../core/config.js';
import { SESSIONS } from '../core/config.js';
import type { DB } from '../core/db.js';
import { CtradeError, ExitCode, invalidArgs } from '../core/errors.js';
import { serve } from '../core/ipc.js';
import type { Quote } from '../core/market.js';
import { type MarketEvent, QuoteCache } from '../core/marketdata.js';
import { formatPrice } from '../core/money.js';
import { expireOpenOrders, expireStaleOrders, listFills } from '../core/orders.js';
import { PaperMatcher } from '../core/paper.js';
import { getMarketRules, getRiskParams } from '../core/settings.js';
import { getState, isTradingDay, recordRiskEvent, setState } from '../core/state.js';
import { type Clock, toTwIso, twDate, twHhmm } from '../core/time.js';
import { type BrokerAdapter, PaperBroker } from './broker.js';
import { type ClaudeInvoker, ClaudeCliInvoker } from './claude.js';
import { DailyJobs } from './daily.js';
import type { MarketFeed } from './feeds.js';
import { TriggerScheduler } from './scheduler.js';
import { StopExecutor } from './stops.js';
import { TriggerLoop } from './trigger-loop.js';

export interface DaemonOptions {
  config: Config;
  db: DB;
  root: string;
  clock: Clock;
  feed: MarketFeed;
  ipcPath: string;
  /** 不指定時依模式建立；live 模式在券商轉接層完成前無法啟動。 */
  broker?: BrokerAdapter;
  /** 不指定時使用 Claude Code CLI；false 代表不叫醒 Claude（只提供行情與送單）。 */
  claude?: ClaudeInvoker | false;
  /** 維護工作（心跳、到期、清理、觸發）的間隔，測試時可設為 0 停用、改為手動呼叫 tick()。 */
  tickMs?: number;
  log?: (msg: string) => void;
}

/** 時段結束後保留的緩衝，讓收盤與零股的最後一次撮合回報先到。 */
const EXPIRY_GRACE_MIN = 2;

/**
 * daemon 核心（規格第 8 節）：
 *   - 持有行情來源與送單轉接層，透過 IPC 提供報價、送單、刪單。
 *   - 模擬撮合、硬停損停利、委託到期，不經過 Claude，暫停中照常執行。
 *   - 每日重設、盤中停機檢查、收盤對帳快照備份。
 *   - 依固定、定時、價格觸發叫醒 Claude。
 */
export class Daemon {
  readonly quotes = new QuoteCache();
  readonly matcher: PaperMatcher;
  readonly broker: BrokerAdapter;
  readonly scheduler: TriggerScheduler;
  readonly daily: DailyJobs;
  readonly stops: StopExecutor;
  readonly triggers?: TriggerLoop;
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private readonly startedAt: string;
  private readonly expiredOn = new Map<Session, string>();
  private readonly log: (msg: string) => void;
  private stopsRunning = false;

  constructor(private readonly opts: DaemonOptions) {
    const { config, db, clock, root } = opts;
    this.log = opts.log ?? ((msg) => console.log(`${toTwIso(clock.now())} ${msg}`));
    this.startedAt = toTwIso(clock.now());
    this.matcher = new PaperMatcher(db, config, clock, (s, b) => this.quotes.book(s, b), {
      fillAtTouch: config.paper.fill_at_touch,
      maxVolumeSharePct: config.paper.max_volume_share_pct,
    });
    if (opts.broker) this.broker = opts.broker;
    else if (config.mode === 'paper') this.broker = new PaperBroker(db, this.matcher, clock, config.paper.submit_delay_ms);
    else {
      throw new CtradeError(
        'BROKER_NOT_IMPLEMENTED',
        'live 模式需要玉山券商轉接層，請先把 SDK 放進 vendor/ 並完成串接',
        ExitCode.BROKER_ERROR,
      );
    }

    this.scheduler = new TriggerScheduler(db, config, clock, this.quotes);
    this.daily = new DailyJobs(db, config, root, clock, this.quotes, this.log);
    this.stops = new StopExecutor(db, config, clock, this.quotes, this.broker, this.log);
    if (opts.claude !== false) {
      this.triggers = new TriggerLoop({
        db,
        config,
        root,
        clock,
        quotes: this.quotes,
        scheduler: this.scheduler,
        daily: this.daily,
        invoker: opts.claude ?? new ClaudeCliInvoker(config),
        env: { CTRADE_IPC_PATH: opts.ipcPath },
        log: this.log,
      });
    }
  }

  async start(): Promise<void> {
    const { db, clock, config } = this.opts;
    const today = twDate(clock.now());
    const stale = expireStaleOrders(db, today, clock);
    if (stale > 0) this.log(`前一交易日留下的 ${stale} 筆未完成委託已到期`);
    // 啟動前已存在的停損成交不再通知 Claude
    if (getState(db, 'last_notified_stop_fill') === null) {
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) FROM fills').pluck().get() as number;
      setState(db, 'last_notified_stop_fill', String(max), clock);
    }

    await this.opts.feed.start((e) => this.onMarketEvent(e));
    await this.opts.feed.subscribe?.(this.scheduler.watchSymbols());
    this.server = await serve(this.opts.ipcPath, (method, params) => this.handle(method, params));

    const tickMs = this.opts.tickMs ?? 5_000;
    if (tickMs > 0) this.timer = setInterval(() => void this.tick(), tickMs);
    void this.tick();
    this.log(
      `daemon 啟動：mode=${config.mode} feed=${this.opts.feed.name} broker=${this.broker.name} ` +
        `claude=${this.triggers ? 'on' : 'off'} ipc=${this.opts.ipcPath}`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.opts.feed.stop();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  onMarketEvent(e: MarketEvent): void {
    this.quotes.apply(e);
    if (this.broker.name === 'paper') {
      try {
        for (const r of this.matcher.onEvent(e)) {
          this.log(`模擬成交：委託 ${r.order.id} ${r.order.symbol} ${r.order.side} ${r.order.filled_qty}/${r.order.qty} 股`);
        }
      } catch (err) {
        // 撮合錯誤不能讓 daemon 當掉；記錄後繼續處理後續行情
        recordRiskEvent(this.opts.db, 'paper_match_error', { event: e, error: (err as Error).message }, 'warn', this.opts.clock);
        this.log(`模擬撮合錯誤：${(err as Error).message}`);
      }
    }
    if (e.type === 'trade' && e.board === 'regular') void this.runStops();
  }

  /** 硬停損停利檢查；避免同時有兩次檢查在送單。 */
  async runStops(): Promise<void> {
    if (this.stopsRunning) return;
    this.stopsRunning = true;
    try {
      await this.stops.check();
      this.notifyStopFills();
    } catch (err) {
      this.log(`硬停損停利檢查錯誤：${(err as Error).message}`);
    } finally {
      this.stopsRunning = false;
    }
  }

  /** 停損停利單有新的成交時，觸發一次 Claude 告知結果（規格第 8 節）。 */
  notifyStopFills(): void {
    const { db } = this.opts;
    const last = Number(getState(db, 'last_notified_stop_fill') ?? 0);
    const fills = db
      .prepare(
        `SELECT f.id, f.price_x100, f.qty, o.symbol, o.id AS order_id FROM fills f JOIN orders o ON o.id = f.order_id
         WHERE o.origin = 'stop' AND f.id > ? ORDER BY f.id`,
      )
      .all(last) as { id: number; price_x100: number; qty: number; symbol: string; order_id: number }[];
    if (fills.length === 0) return;
    setState(db, 'last_notified_stop_fill', String(fills[fills.length - 1]!.id), this.opts.clock);
    const desc = fills.map((f) => `${f.symbol} ${f.qty} 股 @ ${formatPrice(f.price_x100)}`).join('、');
    this.triggers?.enqueue({ kind: 'stop_triggered', fixed: false, reason: `硬停損停利成交：${desc}`, detail: { fills } });
  }

  /** 定期工作。觸發 Claude 的部分不等待（工作階段可能持續數分鐘），避免卡住停損與到期處理。 */
  async tick(): Promise<void> {
    const { db, clock } = this.opts;
    const now = clock.now();
    try {
      setState(db, 'daemon_heartbeat', toTwIso(now), clock);
      this.broker.sweep();
      this.expireSessions(now);
      this.daily.maybeDailyReset();
      this.daily.checkHalts();
    } catch (err) {
      this.log(`維護工作錯誤：${(err as Error).message}`);
    }
    await this.runStops();
    if (this.triggers) {
      this.triggers.tick().catch((err) => this.log(`觸發處理錯誤：${(err as Error).message}`));
    } else {
      // 不叫醒 Claude 時，收盤後的對帳快照備份仍要執行
      const rules = getMarketRules(db, twDate(now));
      const review = (rules.fixed_triggers as Record<string, string>).review ?? '14:35';
      if (isTradingDay(db, now) && twHhmm(now) >= review) await this.daily.closeOfDay();
    }
  }

  private expireSessions(now: Date): void {
    const { db, clock } = this.opts;
    if (!isTradingDay(db, now)) return;
    const today = twDate(now);
    const rules = getMarketRules(db, today);
    const time = twHhmm(now);
    for (const session of SESSIONS) {
      if (this.expiredOn.get(session) === today) continue;
      const end = addMinutes(rules.sessions[session].accept[1], EXPIRY_GRACE_MIN);
      if (time >= end) {
        const n = expireOpenOrders(db, session, clock);
        if (n > 0) this.log(`${session} 時段結束，${n} 筆未成交委託到期`);
        this.expiredOn.set(session, today);
      }
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ping':
        return {
          mode: this.opts.config.mode,
          pid: process.pid,
          started_at: this.startedAt,
          feed: this.opts.feed.name,
          broker: this.broker.name,
          claude: this.triggers ? (this.triggers.busy ? 'running' : 'idle') : 'off',
          watch: this.scheduler.watchSymbols(),
          allowlist: getRiskParams(this.opts.db).symbols_allowlist,
        };
      case 'quotes':
        return symbolsParam(p).map((s) => this.quotes.getQuote(s)).filter((q): q is Quote => !!q);
      case 'quote_detail':
        return symbolsParam(p).map((s) => ({ symbol: s, ...this.quotes.detail(s) }));
      case 'submit': {
        const id = orderIdParam(p);
        const order = await this.broker.submit(id);
        return { order, fills: listFills(this.opts.db, { orderId: id }) };
      }
      case 'cancel': {
        const id = orderIdParam(p);
        const order = await this.broker.cancel(id);
        return { order, fills: listFills(this.opts.db, { orderId: id }) };
      }
      case 'candles': {
        if (!this.opts.feed.candles) {
          throw new CtradeError('FEED_UNSUPPORTED', `行情來源 ${this.opts.feed.name} 不提供 K 線`, ExitCode.BROKER_ERROR);
        }
        return this.opts.feed.candles(String(p.symbol), String(p.interval), Number(p.count));
      }
      default:
        throw invalidArgs('UNKNOWN_METHOD', `daemon 不支援 ${method}`);
    }
  }
}

function symbolsParam(p: Record<string, unknown>): string[] {
  if (!Array.isArray(p.symbols) || p.symbols.some((s) => typeof s !== 'string')) {
    throw invalidArgs('INVALID_ARGS', 'symbols 必須是代號陣列');
  }
  return p.symbols as string[];
}

function orderIdParam(p: Record<string, unknown>): number {
  const id = p.orderId;
  if (typeof id !== 'number' || !Number.isInteger(id)) throw invalidArgs('INVALID_ARGS', 'orderId 必須是整數');
  return id;
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
