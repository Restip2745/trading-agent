import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addJournal, getTriggerConfig, setStop, setTriggerConfig } from '../core/claude-ops.js';
import { projectRoot } from '../core/config.js';
import { allocate, getPosition, transferIn } from '../core/ledger.js';
import { QuoteCache } from '../core/marketdata.js';
import { applyFill } from '../core/orders.js';
import { PaperMatcher } from '../core/paper.js';
import { proposalEligibility, submitReview } from '../core/review.js';
import { getPause, getState, pause, setState } from '../core/state.js';
import { PaperBroker } from '../daemon/broker.js';
import { type ClaudeInvoker, type Invocation, type InvocationResult, buildClaudeArgs, childEnv, parseResultEvent } from '../daemon/claude.js';
import { DailyJobs } from '../daemon/daily.js';
import { TriggerScheduler } from '../daemon/scheduler.js';
import { StopExecutor } from '../daemon/stops.js';
import { TriggerLoop } from '../daemon/trigger-loop.js';
import { ManualFeed } from '../daemon/feeds.js';
import { Daemon } from '../daemon/service.js';
import { type TestEnv, errorCode, makeEnv } from './helpers.js';

const at = (hhmm: string) => `2026-10-19T${hhmm}:00.000+08:00`;

/** 假的 Claude：預設會寫入決策記錄並回報用量。 */
class FakeClaude implements ClaudeInvoker {
  calls: Invocation[] = [];
  respond: (inv: Invocation) => InvocationResult = (inv) => {
    addJournal(env.db, { reasoning: '測試決策', actions: '不動作', triggerEventId: inv.triggerEventId }, env.clock);
    return { status: 'ok', durationMs: 1000, usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cost_usd: 0.01 } };
  };
  async run(inv: Invocation): Promise<InvocationResult> {
    this.calls.push(inv);
    return this.respond(inv);
  }
}

let env: TestEnv;
let root: string;
let claude: FakeClaude;
let daily: DailyJobs;
let scheduler: TriggerScheduler;
let loop: TriggerLoop;

beforeEach(() => {
  env = makeEnv(at('08:00'));
  root = mkdtempSync(join(tmpdir(), 'ctrade-auto-'));
  cpSync(join(projectRoot(), 'prompts'), join(root, 'prompts'), { recursive: true });
  claude = new FakeClaude();
  daily = new DailyJobs(env.db, env.config, root, env.clock, env.quotes, () => {});
  scheduler = new TriggerScheduler(env.db, env.config, env.clock, env.quotes);
  loop = new TriggerLoop({
    db: env.db,
    config: env.config,
    root,
    clock: env.clock,
    quotes: env.quotes,
    scheduler,
    daily,
    invoker: claude,
    env: { CTRADE_IPC_PATH: 'test-pipe' },
    log: () => {},
  });
  allocate(env.db, 100_000, 'user', undefined, env.clock);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const events = () =>
  env.db.prepare('SELECT kind, invoked_claude, skip_reason FROM trigger_events ORDER BY id').all() as {
    kind: string;
    invoked_claude: number;
    skip_reason: string | null;
  }[];

describe('叫醒 Claude', () => {
  it('固定觸發：提示含觸發原因與狀態，傳入正確的權限設定檔與環境變數，記錄用量', async () => {
    env.clock.set(at('08:45'));
    await loop.tick();
    expect(claude.calls).toHaveLength(1);
    const inv = claude.calls[0]!;
    expect(inv.prompt.startsWith('[TRADING SESSION] 模式：PAPER')).toBe(true);
    expect(inv.prompt).toContain('固定觸發 pre_open');
    expect(inv.prompt).toContain('"equity": 100000');
    expect(inv.profile).toBe('trading');
    expect(inv.model).toBe(env.config.model.intraday);
    expect(inv.env).toMatchObject({ CTRADE_TRIGGER_EVENT_ID: String(inv.triggerEventId), CTRADE_IPC_PATH: 'test-pipe' });
    expect(inv.env.CTRADE_READONLY).toBeUndefined();
    expect(env.db.prepare('SELECT exit_status, input_tokens FROM usage_log').get()).toEqual({ exit_status: 'ok', input_tokens: 1000 });
    expect(events()).toEqual([{ kind: 'pre_open', invoked_claude: 1, skip_reason: null }]);

    // 同一天不重複
    await loop.tick();
    expect(claude.calls).toHaveLength(1);
  });

  it('復盤使用 review 設定檔、唯讀模式與復盤模型，並先執行收盤工作', async () => {
    env.clock.set(at('14:35'));
    await loop.tick();
    const inv = claude.calls.at(-1)!;
    expect(inv.profile).toBe('review');
    expect(inv.env.CTRADE_READONLY).toBe('1');
    expect(inv.model).toBe(env.config.model.review);
    expect(env.db.prepare('SELECT COUNT(*) FROM daily_snapshots').pluck().get()).toBe(1);
    expect(existsSync(join(root, 'backup', '2026-10-19', 'paper.db'))).toBe(true);
  });

  it('暫停中不叫醒 Claude，但復盤照常', async () => {
    pause(env.db, 'manual', '測試', env.clock);
    env.clock.set(at('09:01'));
    await loop.tick();
    expect(claude.calls).toHaveLength(0);
    expect(events().at(-1)?.skip_reason).toContain('paused');

    env.clock.set(at('14:35'));
    await loop.tick();
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.profile).toBe('review');
  });

  it('沒有寫入決策記錄時記錄風控警告', async () => {
    claude.respond = () => ({ status: 'ok', durationMs: 10 });
    env.clock.set(at('08:45'));
    await loop.tick();
    expect(env.db.prepare(`SELECT COUNT(*) FROM risk_events WHERE rule = 'no_decision'`).pluck().get()).toBe(1);
  });

  it('呼叫失敗進入 claude_unavailable，之後不再叫醒，直到使用者重設', async () => {
    claude.respond = () => ({ status: 'error', durationMs: 10, error: 'rate limited' });
    env.clock.set(at('08:45'));
    await loop.tick();
    expect(getState(env.db, 'claude_unavailable')).toContain('rate limited');
    env.clock.set(at('09:01'));
    await loop.tick();
    expect(claude.calls).toHaveLength(1);
    expect(events().at(-1)?.skip_reason).toContain('claude_unavailable');
  });

  it('逾時只記錄，不停止後續呼叫', async () => {
    claude.respond = () => ({ status: 'timeout', durationMs: 240_000, error: '逾時' });
    env.clock.set(at('08:45'));
    await loop.tick();
    expect(getState(env.db, 'claude_unavailable')).toBeNull();
    expect(env.db.prepare(`SELECT COUNT(*) FROM risk_events WHERE rule = 'claude_timeout'`).pluck().get()).toBe(1);
  });

  it('用量達每日預算時停止呼叫', async () => {
    env.config.usage.daily_budget_tokens = 1000;
    env.clock.set(at('08:45'));
    await loop.tick(); // 用掉 1200
    env.clock.set(at('09:01'));
    await loop.tick();
    expect(claude.calls).toHaveLength(1);
    expect(getState(env.db, 'claude_unavailable')).toContain('budget_daily');
  });

  it('工作階段結束後更新價格參考價與定時觸發計時', async () => {
    env.clock.set(at('09:01'));
    await loop.tick();
    const refs = env.db.prepare('SELECT symbol, price_x100 FROM price_refs ORDER BY symbol').all();
    expect(refs).toEqual([
      { symbol: '0050', price_x100: 5000 },
      { symbol: '00631L', price_x100: 2000 },
      { symbol: '00632R', price_x100: 1500 },
    ]);
    expect(getState(env.db, 'last_claude_end')).toBe(at('09:01'));

    // 價格觸發
    env.clock.set(at('09:03'));
    env.quotes.set('00632R', 1550); // +3.3%
    await loop.tick();
    expect(claude.calls.at(-1)?.prompt).toContain('價格觸發：00632R 15.00→15.50');
  });

  it('工作階段執行中不重複排入同一個動態觸發', async () => {
    env.db.prepare(`INSERT INTO trigger_events (ts, kind, invoked_claude) VALUES (?, 'pre_open', 1), (?, 'open', 1)`).run(at('08:45'), at('09:01'));
    setState(env.db, 'last_claude_end', at('09:50'), env.clock);
    env.clock.set(at('10:00'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = claude.respond;
    claude.run = async (inv) => {
      claude.calls.push(inv);
      await gate;
      return original(inv);
    };
    const first = loop.tick(); // 排入 interval 並開始執行
    await new Promise((r) => setTimeout(r, 0));
    await loop.tick(); // 執行中再 tick：interval 條件仍成立，但不應再排入
    release();
    await first;
    await loop.drain();
    expect(claude.calls).toHaveLength(1);
  });

  it('執行中又有觸發時合併成一次待辦，固定觸發優先', async () => {
    loop.enqueue({ kind: 'interval', fixed: false, reason: '定時觸發' });
    loop.enqueue({ kind: 'price_move', fixed: false, reason: '價格觸發' });
    env.clock.set(at('13:20'));
    loop.enqueue({ kind: 'pre_close', fixed: true, reason: '固定觸發 pre_close' });
    await loop.drain();
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toContain('固定觸發 pre_close；合併：定時觸發；價格觸發');
  });
});

describe('每日工作', () => {
  it('盤前重設觸發條件與開盤前權益', () => {
    setTriggerConfig(env.db, { interval_min: 30 }, 'claude', env.clock);
    env.clock.set(at('07:59'));
    expect(daily.maybeDailyReset()).toBe(false);
    env.clock.set(at('08:00'));
    expect(daily.maybeDailyReset()).toBe(true);
    expect(getTriggerConfig(env.db)).toMatchObject({ interval_min: 5, up_pct: 3, down_pct: 2, set_by: 'system' });
    expect(getState(env.db, 'day_start_equity')).toBe('100000');
    expect(daily.maybeDailyReset()).toBe(false);
  });

  it('盤中虧損達門檻時自動暫停', () => {
    transferIn(env.db, { symbol: '00631L', qty: 999, costPerShareX100: 2000, actor: 'user' }, env.clock);
    env.clock.set(at('08:00'));
    daily.maybeDailyReset(); // 開盤前權益 119980
    env.clock.set(at('10:00'));
    env.quotes.set('00631L', 700, { limit_down_x100: 700 }); // 市值 6993 → 權益 106993，虧損 12987 ≥ 11998
    daily.checkHalts();
    expect(getPause(env.db)).toMatchObject({ paused: true, rule: 'daily_loss_limit' });
  });

  it('有持股缺報價時不檢查停機條件', () => {
    transferIn(env.db, { symbol: '2330', qty: 1, costPerShareX100: 100000, actor: 'user' }, env.clock);
    env.clock.set(at('08:00'));
    daily.maybeDailyReset();
    env.clock.set(at('10:00'));
    setState(env.db, 'day_start_equity', '999999999', env.clock);
    daily.checkHalts();
    expect(getPause(env.db).paused).toBe(false);
  });

  it('每日快照計算已實現損益並更新歷史高點', () => {
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5000, actor: 'user' }, env.clock);
    env.clock.set(at('10:00'));
    const o = env.db
      .prepare(
        `INSERT INTO orders (client_order_id, symbol, side, session, origin, price_x100, qty, status, created_at, updated_at)
         VALUES ('t1', '0050', 'sell', 'odd_intraday', 'claude', 5200, 100, 'submitted', ?, ?)`,
      )
      .run(at('10:00'), at('10:00'));
    applyFill(env.db, { orderId: Number(o.lastInsertRowid), priceX100: 5200, qty: 100, ts: at('10:00'), category: 'etf' }, env.clock);
    daily.snapshot();
    const snap = env.db.prepare('SELECT realized_pnl, fees_tax, equity, peak_equity FROM daily_snapshots').get();
    // 已實現：5200 − 手續費 7 − 稅 5 − 成本 5000 = 188；權益：現金 100000 + 賣出淨額 5188
    expect(snap).toEqual({ realized_pnl: 188, fees_tax: 12, equity: 105_188, peak_equity: 105_188 });
  });
});

describe('硬停損停利', () => {
  let cache: QuoteCache;
  let stops: StopExecutor;

  beforeEach(() => {
    env.clock.set(at('10:00'));
    cache = new QuoteCache();
    const matcher = new PaperMatcher(env.db, env.config, env.clock, (s, b) => cache.book(s, b), {
      fillAtTouch: false,
      maxVolumeSharePct: 20,
    });
    const broker = new PaperBroker(env.db, matcher, env.clock, [0, 0]);
    stops = new StopExecutor(env.db, env.config, env.clock, env.quotes, broker, () => {});
    transferIn(env.db, { symbol: '00632R', qty: 1500, costPerShareX100: 1500, actor: 'user' }, env.clock);
    setStop(env.db, { symbol: '00632R', stopX100: 1450, takeProfitX100: 1600, actor: 'claude' }, env.clock);
  });

  const stopOrders = () =>
    env.db.prepare(`SELECT session, qty, price_x100, status FROM orders WHERE origin = 'stop' ORDER BY id`).all();

  it('跌破停損價：整股與零頭分別以最後成交價減 5 檔賣出', async () => {
    env.quotes.set('00632R', 1449, { limit_down_x100: 1350 });
    const hits = await stops.check();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('stop');
    expect(stopOrders()).toEqual([
      { session: 'regular', qty: 1000, price_x100: 1444, status: 'submitted' },
      { session: 'odd_intraday', qty: 500, price_x100: 1444, status: 'submitted' },
    ]);
  });

  it('同一檔已有停損單時不重送', async () => {
    env.quotes.set('00632R', 1449);
    await stops.check();
    env.clock.advanceMinutes(1);
    await stops.check();
    expect(stopOrders()).toHaveLength(2);
  });

  it('暫停中照常執行', async () => {
    pause(env.db, 'manual', '測試', env.clock);
    env.quotes.set('00632R', 1449);
    expect(await stops.check()).toHaveLength(1);
  });

  it('觸及停利價賣出，限價不低於跌停價', async () => {
    env.quotes.set('00632R', 1600, { limit_down_x100: 1598 });
    const hits = await stops.check();
    expect(hits[0]?.kind).toBe('take_profit');
    expect(stopOrders()[0]).toMatchObject({ price_x100: 1598 });
  });

  it('未觸價不動作', async () => {
    env.quotes.set('00632R', 1500);
    expect(await stops.check()).toEqual([]);
    expect(getPosition(env.db, '00632R').pending_sell_qty).toBe(0);
  });
});

describe('daemon 整合', () => {
  it('停損單成交後叫醒 Claude（stop_triggered）', async () => {
    env.config.paper.submit_delay_ms = [0, 0];
    env.clock.set(at('10:00'));
    const d = new Daemon({
      config: env.config,
      db: env.db,
      root,
      clock: env.clock,
      feed: new ManualFeed(),
      ipcPath: 'unused',
      claude,
      tickMs: 0,
      log: () => {},
    });
    transferIn(env.db, { symbol: '00632R', qty: 1000, costPerShareX100: 1500, actor: 'user' }, env.clock);
    setStop(env.db, { symbol: '00632R', stopX100: 1450, actor: 'claude' }, env.clock);
    setState(env.db, 'last_notified_stop_fill', '0', env.clock);

    const ts = at('10:00');
    d.onMarketEvent({ type: 'ticker', symbol: '00632R', ts, reference_x100: 1500, prev_close_x100: 1500, limit_up_x100: 1650, limit_down_x100: 1350 });
    d.onMarketEvent({ type: 'book', symbol: '00632R', board: 'regular', ts, bids: [{ price_x100: 1445, size: 5000 }], asks: [{ price_x100: 1449, size: 5000 }] });
    d.onMarketEvent({ type: 'trade', symbol: '00632R', board: 'regular', ts, price_x100: 1449, volume: 1000 });
    await new Promise((r) => setTimeout(r, 20));
    await d.runStops();

    expect(getPosition(env.db, '00632R').qty).toBe(0); // 以最佳買價 14.45 成交
    await d.triggers!.drain();
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toContain('硬停損停利成交：00632R 1000 股 @ 14.45');
    expect(claude.calls[0]?.prompt).toContain('硬停損或停利價自動賣出');
  });
});

describe('復盤記錄', () => {
  it('筆記必須在 reviews/ 內，寫入後狀態為 observed', () => {
    mkdirSync(join(root, 'reviews'), { recursive: true });
    const note = join(root, 'reviews', '2026-10-19.md');
    writeFileSync(note, '# 復盤\n今天不動作。');
    const outside = join(root, 'note.md');
    writeFileSync(outside, 'x');
    const opts = { date: '2026-10-19', allowedRoots: [root] };
    expect(errorCode(() => submitReview(env.db, env.config, { ...opts, file: outside }, env.clock))).toBe('REVIEW_FILE_LOCATION');
    expect(submitReview(env.db, env.config, { ...opts, file: note }, env.clock).status).toBe('observed');
  });

  it('策略修改提案須同時滿足交易日數與成交筆數，虧損停機當天例外', () => {
    mkdirSync(join(root, 'reviews'), { recursive: true });
    const note = join(root, 'reviews', '2026-10-19.md');
    writeFileSync(note, '# 復盤');
    const input = { date: '2026-10-19', file: note, proposalBranch: 'strategy/2026-10-19', allowedRoots: [root] };
    expect(errorCode(() => submitReview(env.db, env.config, input, env.clock))).toBe('PROPOSAL_NOT_ELIGIBLE');
    expect(proposalEligibility(env.db, env.config, env.clock)).toMatchObject({ eligible: false, min_days: 5, min_trades: 20 });

    pause(env.db, 'daily_loss_limit', '虧損 10%', env.clock);
    expect(submitReview(env.db, env.config, input, env.clock).status).toBe('proposed');
  });
});

describe('Claude CLI 參數', () => {
  it('trading 設定檔：dontAsk、只開放 ctrade 與讀取', () => {
    const args = buildClaudeArgs(env.config, 'trading', 'claude-sonnet-5-5');
    expect(args).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'dontAsk', '--setting-sources', 'project', 'Bash(ctrade *)', 'Read(./**)']));
    expect(args).toContain('Bash(ctrade-admin *)');
    expect(args).not.toContain('Read'); // 不可有不限路徑的 Read
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read,Skill');
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(expect.arrayContaining(['Read(./data/**)', 'Read(./backup/**)']));
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(expect.arrayContaining(['Edit', 'Write', 'WebFetch']));
  });

  it('review 設定檔：可寫復盤筆記與策略 skill，禁止 push 與切換分支', () => {
    const args = buildClaudeArgs(env.config, 'review', 'claude-opus-5-5');
    expect(args).toEqual(expect.arrayContaining(['Write(./reviews/**)', 'Edit(./.claude/skills/trading-strategy/**)', 'Bash(git push*)', 'Bash(git checkout*)']));
    expect(args).not.toContain('Read');
  });

  it('子程序環境：移除 Claude Code 工作階段變數，保留使用者自己的認證', () => {
    const env = childEnv(
      {
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'desktop',
        CLAUDE_CODE_SESSION_ID: 'x',
        CLAUDE_CODE_OAUTH_TOKEN: 'long-lived',
        ANTHROPIC_BASE_URL: 'http://host-proxy',
        ANTHROPIC_API_KEY: 'k',
      },
      { CTRADE_HOME: '/home' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'long-lived',
      ANTHROPIC_API_KEY: 'k',
      CTRADE_HOME: '/home',
    });
    // 不是從 Claude Code 啟動時，使用者自行設定的 ANTHROPIC_BASE_URL 保留
    expect(childEnv({ ANTHROPIC_BASE_URL: 'http://my-proxy' }, {}).ANTHROPIC_BASE_URL).toBe('http://my-proxy');
  });

  it('從 stream-json 的 result 事件取出用量', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.05,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000 },
    });
    expect(parseResultEvent(line)).toEqual({
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 5000, cost_usd: 0.05 },
      isError: false,
      error: undefined,
    });
    expect(parseResultEvent('{"type":"assistant"}')).toBeUndefined();
    expect(parseResultEvent(JSON.stringify({ type: 'result', is_error: true, result: '額度用盡' }))?.isError).toBe(true);
  });
});
