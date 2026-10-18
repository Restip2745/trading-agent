import { join } from 'node:path';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import type { QuoteSource } from '../core/market.js';
import { buildStatus } from '../core/status.js';
import { type StrategyCheck, currentStrategy } from '../core/strategy.js';
import { getPause, getState, recordRiskEvent, setState } from '../core/state.js';
import { type Clock, toTwIso, twDate } from '../core/time.js';
import type { ClaudeInvoker, InvocationResult, Profile } from './claude.js';
import type { DailyJobs } from './daily.js';
import { acquireLock } from './lock.js';
import { renderPrompt } from './prompts.js';
import type { DueTrigger, TriggerScheduler } from './scheduler.js';

/**
 * 叫醒 Claude 的規則（規格第 8 節）：
 *   - 同一時間只允許一個工作階段（檔案鎖）。
 *   - 執行中又有觸發時合併成一次待辦，結束後立即執行；固定觸發優先於動態觸發。
 *   - 逾時強制結束並記錄；呼叫失敗進入 claude_unavailable，停止呼叫 Claude，硬停損停利照常。
 *   - 工作階段結束後檢查有沒有寫入決策記錄。
 *   - 策略檔與生效版本不一致時不叫醒 Claude 做交易決策（復盤照常，提示中註明）。
 */

export interface TriggerLoopOptions {
  db: DB;
  config: Config;
  root: string;
  clock: Clock;
  quotes: QuoteSource;
  scheduler: TriggerScheduler;
  daily: DailyJobs;
  invoker: ClaudeInvoker;
  /** 傳給 Claude 的環境變數（例如 CTRADE_IPC_PATH），讓 ctrade 找得到這個 daemon */
  env: Record<string, string>;
  log: (msg: string) => void;
  /**
   * 比對專案目錄的策略檔與生效版本（daemon 以 git 實作，見 core/strategy.ts）。
   * 不指定時不檢查（測試用）。
   */
  strategyCheck?: (version: string | null) => StrategyCheck;
}

interface Pending extends DueTrigger {
  triggerEventId?: number;
}

export class TriggerLoop {
  private pending?: Pending;
  private running = false;

  constructor(private readonly o: TriggerLoopOptions) {}

  get busy(): boolean {
    return this.running;
  }

  /** 每次 daemon tick 呼叫：收集到期的觸發並執行。 */
  async tick(): Promise<void> {
    const { run, superseded } = this.o.scheduler.dueFixed();
    for (const kind of superseded) this.recordEvent({ kind, fixed: true, reason: '系統中斷，由較晚的固定觸發取代' }, false, 'superseded');
    if (run) this.enqueue(run);
    // 工作階段執行中不評估動態觸發：定時與價格條件要等這次決策結束、參考價與計時更新後才有意義，
    // 否則同一個條件會在執行中被重複排進待辦，結束後立刻再叫醒一次
    else if (!this.running && !this.blocked()) {
      const dynamic = this.o.scheduler.duePriceMove() ?? this.o.scheduler.dueInterval();
      if (dynamic) this.enqueue(dynamic);
    }
    await this.drain();
  }

  /**
   * 加入待辦並合併：已有待辦時，固定觸發取代動態觸發，同類則合併原因。
   * 固定觸發在加入時就寫入 trigger_events，避免排程重複判定為到期。
   */
  enqueue(t: DueTrigger): void {
    const next: Pending = { ...t };
    if (t.fixed) next.triggerEventId = this.recordEvent(t, false, null);
    const cur = this.pending;
    if (!cur) this.pending = next;
    else if (next.fixed && !cur.fixed) this.pending = { ...next, reason: `${next.reason}；合併：${cur.reason}` };
    else if (next.fixed && cur.fixed) {
      // 兩個固定觸發同時待辦：保留較新的，較舊的標為已略過
      if (cur.triggerEventId) this.markSkipped(cur.triggerEventId, 'superseded');
      this.pending = next;
    } else if (!next.fixed && !cur.fixed) {
      this.pending = { ...cur, reason: `${cur.reason}；${next.reason}`, kind: cur.kind === 'stop_triggered' ? cur.kind : next.kind };
    }
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const t = this.pending;
        this.pending = undefined;
        await this.execute(t);
      }
    } finally {
      this.running = false;
    }
  }

  /** 暫停或 Claude 無法使用時，不產生動態觸發。 */
  private blocked(): boolean {
    return getPause(this.o.db).paused || getState(this.o.db, 'claude_unavailable') !== null;
  }

  private recordEvent(t: DueTrigger, invoked: boolean, skip: string | null): number {
    const info = this.o.db
      .prepare('INSERT INTO trigger_events (ts, kind, detail_json, invoked_claude, skip_reason) VALUES (?, ?, ?, ?, ?)')
      .run(toTwIso(this.o.clock.now()), t.kind, JSON.stringify({ reason: t.reason, ...t.detail }), invoked ? 1 : 0, skip);
    return Number(info.lastInsertRowid);
  }

  private markSkipped(id: number, reason: string): void {
    this.o.db.prepare('UPDATE trigger_events SET invoked_claude = 0, skip_reason = ? WHERE id = ?').run(reason, id);
  }

  async execute(t: Pending): Promise<InvocationResult | undefined> {
    const { db, config, clock, daily } = this.o;
    const id = t.triggerEventId ?? this.recordEvent(t, false, null);

    // 暫停中只停止叫醒 Claude；復盤例外，停機當天更需要檢討（規格第 6 節）
    if (t.kind !== 'review' && getPause(db).paused) return void this.markSkipped(id, `paused：${getPause(db).reason ?? ''}`);
    const unavailable = getState(db, 'claude_unavailable');
    if (unavailable) return void this.markSkipped(id, `claude_unavailable：${unavailable}`);
    const budget = daily.checkBudget();
    if (!budget.ok) {
      setState(db, 'claude_unavailable', budget.reason ?? 'budget', clock);
      return void this.markSkipped(id, `claude_unavailable：${budget.reason}`);
    }
    const mismatch = this.strategyMismatch();
    if (mismatch && t.kind !== 'review') return void this.markSkipped(id, `strategy_mismatch：${mismatch}`);
    if (t.kind === 'review') await daily.closeOfDay();

    let release: () => void;
    try {
      release = acquireLock(join(this.o.root, 'data', `claude-session-${config.mode}.lock`));
    } catch (e) {
      return void this.markSkipped(id, `lock：${(e as Error).message}`);
    }

    try {
      db.prepare('UPDATE trigger_events SET invoked_claude = 1, skip_reason = NULL WHERE id = ?').run(id);
      return await this.invoke(t, id, mismatch);
    } finally {
      release();
    }
  }

  private async invoke(t: Pending, id: number, mismatch: string | null): Promise<InvocationResult> {
    const { db, config, clock, root, quotes } = this.o;
    const now = clock.now();
    const profile: Profile = t.kind === 'review' ? 'review' : 'trading';
    const model = profile === 'review' ? config.model.review : config.model.intraday;
    const strategyVersion = currentStrategy(db)?.version ?? 'unversioned';

    const prompt = renderPrompt(root, t, {
      mode: config.mode,
      now: toTwIso(now),
      status: buildStatus(db, config, clock, quotes),
      notes: this.notesFor(t, mismatch),
    });
    const env: Record<string, string> = {
      ...this.o.env,
      CTRADE_HOME: root,
      CTRADE_TRIGGER_EVENT_ID: String(id),
      CTRADE_MODEL: model,
      CTRADE_STRATEGY_VERSION: strategyVersion,
    };
    if (profile === 'review') env.CTRADE_READONLY = '1';

    this.o.log(`叫醒 Claude：${t.reason}（觸發 ${id}，${model}）`);
    const result = await this.o.invoker.run({
      triggerEventId: id,
      profile,
      model,
      prompt,
      cwd: root,
      env,
      logPath: join(root, 'logs', 'claude', twDate(now), `${id}.jsonl`),
      timeoutMs: config.claude.timeout_min * 60_000,
    });
    this.afterSession(t, id, model, result);
    return result;
  }

  /**
   * 策略檔與生效版本不一致時回傳原因。同一個原因只記錄一次風控事件；恢復一致時清除狀態。
   */
  private strategyMismatch(): string | null {
    const { db, clock, strategyCheck } = this.o;
    if (!strategyCheck) return null;
    const version = currentStrategy(db)?.version ?? null;
    const r = strategyCheck(version);
    const prev = getState(db, 'strategy_mismatch');
    if (r.ok) {
      if (prev) {
        setState(db, 'strategy_mismatch', null, clock);
        this.o.log('策略檔已與生效版本一致，恢復叫醒 Claude');
      }
      return null;
    }
    const reason = r.reason ?? '策略檔與生效版本不一致';
    if (prev !== reason) {
      setState(db, 'strategy_mismatch', reason, clock);
      recordRiskEvent(db, 'strategy_mismatch', { version, changed: r.changed, reason }, 'warn', clock);
      this.o.log(`不叫醒 Claude 做交易決策：${reason}`);
    }
    return reason;
  }

  private notesFor(t: Pending, strategyMismatch: string | null = null): string[] {
    const notes: string[] = [];
    if (strategyMismatch) notes.push(`策略檔與生效版本不一致，今天的盤中決策已暫停叫醒：${strategyMismatch}。復盤請以生效版本（ctrade-admin strategy show 由使用者查看）為準，並在筆記中提醒使用者處理。`);
    const warning = getState(this.o.db, 'usage_warning');
    if (warning) notes.push(`用量已達預算 80%：${warning}`);
    if (t.kind === 'pre_open') {
      const changes = this.o.db
        .prepare(
          `SELECT 'fee' AS kind, effective_date FROM fee_schedules WHERE effective_date = ? AND created_by = 'user'
           UNION ALL SELECT 'rules', effective_date FROM market_rules WHERE effective_date = ? AND created_by = 'user'`,
        )
        .all(twDate(this.o.clock.now()), twDate(this.o.clock.now())) as { kind: string }[];
      if (changes.length > 0) notes.push('今天起適用新的費率或市場規則，請以 ctrade fees 確認。');
    }
    return notes;
  }

  private afterSession(t: Pending, id: number, model: string, r: InvocationResult): void {
    const { db, clock, quotes, scheduler } = this.o;
    db.prepare(
      `INSERT INTO usage_log (ts, trigger_event_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms, exit_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toTwIso(clock.now()),
      id,
      model,
      r.usage?.input_tokens ?? null,
      r.usage?.output_tokens ?? null,
      r.usage?.cache_read_tokens ?? null,
      r.usage?.cost_usd ?? null,
      r.durationMs,
      r.status,
    );

    if (r.status === 'timeout') {
      recordRiskEvent(db, 'claude_timeout', { trigger_event_id: id, error: r.error }, 'warn', clock);
      this.o.log(`Claude 工作階段逾時（觸發 ${id}）`);
    } else if (r.status === 'error') {
      setState(db, 'claude_unavailable', `call_failed：${r.error ?? 'unknown'}`, clock);
      recordRiskEvent(db, 'claude_unavailable', { trigger_event_id: id, error: r.error }, 'warn', clock);
      this.o.log(`Claude 呼叫失敗，停止呼叫 Claude：${r.error}`);
    }

    const decision = db
      .prepare('SELECT id FROM decisions WHERE trigger_event_id = ? ORDER BY id DESC LIMIT 1')
      .pluck()
      .get(id) as number | undefined;
    if (!decision && t.kind !== 'review') {
      recordRiskEvent(db, 'no_decision', { trigger_event_id: id, kind: t.kind }, 'warn', clock);
    }

    // 價格觸發的參考價改為這次決策時的價格；定時觸發從現在重新計時
    const ts = toTwIso(clock.now());
    const insertRef = db.prepare('INSERT INTO price_refs (symbol, price_x100, decision_id, set_at) VALUES (?, ?, ?, ?)');
    for (const symbol of scheduler.watchSymbols()) {
      const q = quotes.getQuote(symbol);
      if (q) insertRef.run(symbol, q.last_x100, decision ?? null, ts);
    }
    setState(db, 'last_claude_end', ts, clock);
  }
}
