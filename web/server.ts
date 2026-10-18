import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as admin from '../core/admin.js';
import { getStops, getTriggerConfig } from '../core/claude-ops.js';
import type { Config, Mode, RiskParams } from '../core/config.js';
import { type DB, openDb } from '../core/db.js';
import { CtradeError, ExitCode, invalidArgs } from '../core/errors.js';
import { call } from '../core/ipc.js';
import { getBalance, getPositions } from '../core/ledger.js';
import { type QuoteSource, staticQuotes, valuate } from '../core/market.js';
import { formatPrice, ppmToPct } from '../core/money.js';
import { listFills, listOrders } from '../core/orders.js';
import { getFeeSchedule, getMarketRules, getRiskParams } from '../core/settings.js';
import { getPause, getState } from '../core/state.js';
import { buildStatus } from '../core/status.js';
import { DEFAULT_SMA_PERIODS, INDICATOR_FIELDS, INDICATOR_NOTES, checkIndicatorRefs } from '../core/indicator-catalog.js';
import { STRATEGY_DIR, checkStrategyFiles, git, listStrategies, strategyDiff, strategyFilesAt } from '../core/strategy.js';
import { type Clock, isValidDate, twDate, twDayStartIso } from '../core/time.js';

/**
 * Web UI 後端（規格第 11 節）。只綁定 127.0.0.1，讀取 SQLite 呈現 dashboard；
 * 所有寫入都呼叫 core/admin.ts（與 ctrade-admin 相同的函式庫），不直接寫 SQL。
 *
 * 安全：
 *   - Host 標頭必須是 127.0.0.1 或 localhost 加上本服務的埠號，擋下 DNS rebinding。
 *   - 寫入請求必須是 JSON，且帶有每次啟動隨機產生的 X-Ctrade-Token（嵌在頁面中，其他網站讀不到）。
 *   - 不開放 CORS；回應帶 CSP 與 X-Frame-Options，禁止被嵌入。
 *
 * 檢視與寫入分開：?db=paper|live 只切換檢視的資料庫；寫入一律寫目前交易模式（config.mode）的帳本。
 */

export interface WebOptions {
  root: string;
  config: Config;
  clock: Clock;
  ipcPath: string;
  port: number;
  /** 測試用：固定 token 與資料庫路徑 */
  token?: string;
  dbPath?: string;
  logger?: boolean;
}

interface Views {
  active: DB;
  other?: DB;
}

function openViews(o: WebOptions): Views {
  const active = openDb({ root: o.root, config: o.config, clock: o.clock, path: o.dbPath });
  const otherMode: Mode = o.config.mode === 'paper' ? 'live' : 'paper';
  const otherPath = join(o.root, 'data', `${otherMode}.db`);
  // 另一個模式的帳本只讀，不存在就不建立
  const other = !o.dbPath && existsSync(otherPath) ? new Database(otherPath, { readonly: true, fileMustExist: true }) : undefined;
  return { active, other };
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const price = (x100: unknown) => (x100 === null || x100 === undefined ? null : formatPrice(Number(x100)));

export async function buildServer(o: WebOptions): Promise<{ app: FastifyInstance; token: string; close: () => void }> {
  const token = o.token ?? randomBytes(24).toString('hex');
  const views = openViews(o);
  const app = Fastify({ logger: o.logger ?? false });
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  // ---------------------------------------------------------------- 安全
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host ?? ''))) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN_HOST', message: 'Host 不允許' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const given = Buffer.from(String(req.headers['x-ctrade-token'] ?? ''));
      const expected = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN_TOKEN', message: '缺少或錯誤的操作 token，請重新整理頁面' } });
      }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return reply.code(415).send({ ok: false, error: { code: 'JSON_REQUIRED', message: '寫入請求必須是 JSON' } });
      }
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    // Vue 完整版在瀏覽器編譯模板需要 unsafe-eval；頁面內容一律經 Vue 文字插值（自動跳脫），不使用 v-html
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CtradeError) {
      const status = err.exitCode === ExitCode.INTERNAL ? 500 : err.exitCode === ExitCode.BROKER_ERROR ? 502 : 400;
      return reply.code(status).send({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    return reply.code(status).send({ ok: false, error: { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: e.message ?? String(err) } });
  });

  // ---------------------------------------------------------------- 靜態頁面
  const publicDir = join(o.root, 'web', 'public');
  const indexHtml = () =>
    readFileSync(join(publicDir, 'index.html'), 'utf8').replace('__CTRADE_TOKEN__', token).replace('__CTRADE_MODE__', o.config.mode);
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(indexHtml()));
  await app.register(fastifyStatic, { root: publicDir, prefix: '/static/', index: false });
  await app.register(fastifyStatic, {
    root: join(o.root, 'node_modules', 'vue', 'dist'),
    prefix: '/vendor/vue/',
    decorateReply: false,
    allowedPath: (p) => p === '/vue.esm-browser.prod.js',
  });

  // ---------------------------------------------------------------- 共用
  const viewDb = (req: FastifyRequest): { db: DB; mode: Mode; active: boolean } => {
    const want = (req.query as { db?: string }).db;
    const otherMode: Mode = o.config.mode === 'paper' ? 'live' : 'paper';
    if (want === otherMode) {
      if (!views.other) throw invalidArgs('DB_NOT_FOUND', `沒有 ${otherMode}.db`);
      return { db: views.other, mode: otherMode, active: false };
    }
    return { db: views.active, mode: o.config.mode, active: true };
  };

  /** 估值用報價：只有目前模式的帳本向 daemon 取（daemon 只服務目前模式）。 */
  const quotesFor = async (db: DB, active: boolean): Promise<QuoteSource> =>
    active ? admin.quotesFromDaemon(o.ipcPath, getPositions(db).map((p) => p.symbol)) : staticQuotes([]);

  const adminCtx = async (needQuotes = false): Promise<admin.AdminContext> => ({
    db: views.active,
    config: o.config,
    root: o.root,
    clock: o.clock,
    quotes: needQuotes ? await quotesFor(views.active, true) : staticQuotes([]),
    ipcPath: o.ipcPath,
    actor: 'web',
  });

  const daemonInfo = async () => {
    try {
      return { running: true, ...(await call<Record<string, unknown>>(o.ipcPath, 'ping', {}, 2_000)) };
    } catch {
      return { running: false };
    }
  };

  const ok = (data: unknown) => ({ ok: true, data });
  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as T;
  const int = (name: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw invalidArgs('INVALID_ARGS', `${name} 必須是整數`);
    return v;
  };
  const symbolArg = (v: unknown) => {
    const s = String(v ?? '').trim().toUpperCase();
    if (!/^[0-9A-Z]{4,6}$/.test(s)) throw invalidArgs('INVALID_SYMBOL', `股票代號 ${JSON.stringify(v)} 格式錯誤`);
    return s;
  };
  const priceArg = (v: unknown) => {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? '').trim());
    if (!m) throw invalidArgs('INVALID_PRICE', `價格 ${JSON.stringify(v)} 格式錯誤，最多兩位小數`);
    return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  };
  const dateQuery = (req: FastifyRequest) => {
    const d = (req.query as { date?: string }).date;
    if (d && !isValidDate(d)) throw invalidArgs('INVALID_DATE', `日期 ${d} 格式錯誤`);
    return d;
  };

  // ---------------------------------------------------------------- 讀取
  app.get('/api/meta', async () => ok({ mode: o.config.mode, views: views.other ? ['paper', 'live'] : [o.config.mode], symbols: o.config.symbols }));

  app.get('/api/overview', async (req) => {
    const { db, mode, active } = viewDb(req);
    const quotes = await quotesFor(db, active);
    const now = o.clock.now();
    return ok({
      mode,
      active,
      daemon: active ? await daemonInfo() : { running: false },
      heartbeat: getState(db, 'daemon_heartbeat'),
      status: buildStatus(db, o.config, o.clock, quotes),
      pause: getPause(db),
      usage_warning: getState(db, 'usage_warning'),
      peak_equity: n(getState(db, 'peak_equity')),
      triggers_today: db
        .prepare(`SELECT kind, invoked_claude, skip_reason, ts FROM trigger_events WHERE ts >= ? ORDER BY id`)
        .all(twDayStartIso(now)),
      equity_curve: db.prepare('SELECT date, equity, peak_equity, realized_pnl, unrealized_pnl FROM daily_snapshots ORDER BY date').all(),
      // 投入本金 = 撥入 − 撥出 + 轉入持股成本 − 轉出持股成本；累計損益 = 權益 − 投入本金
      contributed:
        (db.prepare(`SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE type IN ('allocate_in', 'allocate_out')`).pluck().get() as number) +
        Math.round(
          (db.prepare(`SELECT COALESCE(SUM(cost_x100), 0) FROM position_movements WHERE type IN ('transfer_in', 'transfer_out')`).pluck().get() as number) / 100,
        ),
    });
  });

  app.get('/api/positions', async (req) => {
    const { db, active } = viewDb(req);
    const quotes = await quotesFor(db, active);
    const stops = new Map(getStops(db).map((s) => [s.symbol, s]));
    return ok(
      getPositions(db)
        .filter((p) => p.qty > 0)
        .map((p) => {
          const q = quotes.getQuote(p.symbol);
          const s = stops.get(p.symbol);
          return {
            symbol: p.symbol,
            name: o.config.symbols[p.symbol]?.name ?? null,
            qty: p.qty,
            sellable_qty: p.sellable_qty,
            avg_cost: formatPrice(p.avg_cost_x100),
            total_cost: Math.round(p.cost_x100 / 100),
            last: q ? formatPrice(q.last_x100) : null,
            market_value: q ? Math.floor((q.last_x100 * p.qty) / 100) : null,
            unrealized_pnl: q ? Math.floor((q.last_x100 * p.qty - p.cost_x100) / 100) : null,
            stop: price(s?.stop_x100),
            take_profit: price(s?.take_profit_x100),
          };
        }),
    );
  });

  app.get('/api/orders', async (req) => {
    const { db } = viewDb(req);
    const date = dateQuery(req);
    const open = (req.query as { open?: string }).open === '1';
    return ok(
      listOrders(db, { date, open })
        .reverse()
        .slice(0, 500)
        .map((r) => ({ ...r, price: formatPrice(r.price_x100) })),
    );
  });

  app.get('/api/fills', async (req) => {
    const { db } = viewDb(req);
    return ok(
      listFills(db, { date: dateQuery(req) })
        .reverse()
        .slice(0, 500)
        .map((f) => ({ ...f, price: price(f.price_x100) })),
    );
  });

  app.get('/api/decisions', async (req) => {
    const { db } = viewDb(req);
    const { q, kind } = req.query as { q?: string; kind?: string };
    const date = dateQuery(req);
    const where: string[] = [];
    const params: unknown[] = [];
    if (date) where.push('substr(d.ts, 1, 10) = ?'), params.push(date);
    if (kind) where.push('t.kind = ?'), params.push(kind);
    if (q) where.push('(d.reasoning LIKE ? OR d.actions_json LIKE ?)'), params.push(`%${q}%`, `%${q}%`);
    const rows = db
      .prepare(
        `SELECT d.id, d.ts, d.model, d.reasoning, d.actions_json, d.next_trigger_json, d.strategy_version,
                d.trigger_event_id, t.kind, t.detail_json
         FROM decisions d LEFT JOIN trigger_events t ON t.id = d.trigger_event_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT 200`,
      )
      .all(...params) as Record<string, unknown>[];
    return ok(
      rows.map((r) => ({
        ...r,
        actions: safeJson(r.actions_json),
        next_trigger: safeJson(r.next_trigger_json),
        trigger_detail: safeJson(r.detail_json),
        has_log: r.trigger_event_id ? existsSync(logPath(String(r.ts).slice(0, 10), Number(r.trigger_event_id))) : false,
      })),
    );
  });

  const logPath = (date: string, id: number) => join(o.root, 'logs', 'claude', date, `${id}.jsonl`);

  /** 一次 Claude 工作階段的完整過程（只整理文字與工具呼叫，給決策日誌頁檢視）。 */
  app.get('/api/sessions/:id', async (req) => {
    const { db } = viewDb(req);
    const id = Number((req.params as { id: string }).id);
    const ev = db.prepare('SELECT ts FROM trigger_events WHERE id = ?').get(id) as { ts: string } | undefined;
    if (!ev) throw invalidArgs('NOT_FOUND', `找不到觸發 ${id}`);
    const path = logPath(ev.ts.slice(0, 10), id);
    if (!existsSync(path)) throw invalidArgs('NOT_FOUND', '沒有這次工作階段的記錄檔');
    const steps: { type: string; text: string }[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = safeJson(line) as Record<string, any> | null;
      if (!m) continue;
      if (m.type === 'assistant') {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && c.text) steps.push({ type: 'text', text: c.text });
          if (c.type === 'tool_use') steps.push({ type: 'tool', text: `${c.name}: ${JSON.stringify(c.input)}` });
        }
      } else if (m.type === 'user') {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_result') {
            const content = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : String(c.content ?? '');
            steps.push({ type: c.is_error ? 'error' : 'result', text: content.slice(0, 4000) });
          }
        }
      } else if (m.type === 'result') {
        steps.push({ type: 'result-summary', text: `結束：${m.subtype ?? ''}，${m.num_turns ?? '?'} 回合，${m.duration_ms ?? '?'} ms` });
      }
    }
    return ok({ id, steps });
  });

  app.get('/api/ledger', async (req) => {
    const { db } = viewDb(req);
    return ok({
      balance: getBalance(db),
      cash: db.prepare('SELECT * FROM cash_movements ORDER BY id DESC LIMIT 300').all(),
      positions: (db.prepare('SELECT * FROM position_movements ORDER BY id DESC LIMIT 300').all() as Record<string, unknown>[]).map((r) => ({
        ...r,
        cost: Math.round(Number(r.cost_x100) / 100),
      })),
    });
  });

  app.get('/api/risk', async (req) => {
    const { db } = viewDb(req);
    return ok({
      params: getRiskParams(db),
      history: db.prepare('SELECT id, ts, actor FROM risk_settings ORDER BY id DESC LIMIT 20').all(),
      events: (db.prepare('SELECT * FROM risk_events ORDER BY id DESC LIMIT 200').all() as Record<string, unknown>[]).map((r) => ({
        ...r,
        detail: safeJson(r.detail_json),
      })),
    });
  });

  app.get('/api/fees', async (req) => {
    const { db } = viewDb(req);
    const today = twDate(o.clock.now());
    const present = (s: Record<string, number | string>) => ({
      id: s.id,
      effective_date: s.effective_date,
      fee_rate_pct: ppmToPct(Number(s.fee_rate_ppm)),
      fee_discount: Number(s.fee_discount_bp) / 10_000,
      rebate_mode: s.rebate_mode,
      min_fee_regular: s.min_fee_regular,
      min_fee_odd: s.min_fee_odd,
      tax_stock_pct: ppmToPct(Number(s.tax_stock_ppm)),
      tax_daytrade_pct: ppmToPct(Number(s.tax_daytrade_ppm)),
      tax_etf_pct: ppmToPct(Number(s.tax_etf_ppm)),
      created_by: s.created_by,
      created_at: s.created_at,
    });
    return ok({
      current_id: getFeeSchedule(db, today).id,
      schedules: (db.prepare('SELECT * FROM fee_schedules ORDER BY effective_date DESC, id DESC').all() as Record<string, number | string>[]).map(present),
      market_rules: getMarketRules(db, today),
      market_rule_versions: db.prepare('SELECT id, effective_date, created_by, created_at FROM market_rules ORDER BY id DESC').all(),
    });
  });

  app.get('/api/strategy', async (req) => {
    const { db } = viewDb(req);
    // 依策略版本統計：委託數、成交數、已實現損益（賣出價金 − 手續費 − 稅 − 扣除成本）
    const perf = db
      .prepare(
        `SELECT o.strategy_version AS version,
                COUNT(DISTINCT o.id) AS orders,
                COUNT(f.id) AS fills,
                COALESCE(SUM(CASE WHEN o.side = 'sell' THEN (f.price_x100 * f.qty) / 100 - f.fee - f.tax + COALESCE(p.cost_x100, 0) / 100.0 ELSE 0 END), 0) AS realized_pnl,
                COALESCE(SUM(f.fee + f.tax), 0) AS fees_tax
         FROM orders o LEFT JOIN fills f ON f.order_id = o.id
         LEFT JOIN position_movements p ON p.fill_id = f.id
         GROUP BY o.strategy_version`,
      )
      .all() as Record<string, unknown>[];
    const versions = listStrategies(db).map((v) => {
      let subject: string | null = null;
      try {
        subject = git(o.root, ['log', '-1', '--format=%s', v.version]);
      } catch {
        // 版本不在這個 repo（例如資料庫從別處複製過來），只顯示 hash
      }
      return { ...v, subject };
    });
    const current = versions[0] ?? null;
    const filesMatch = checkStrategyFiles(o.root, current?.version ?? null);
    // 顯示的是生效版本在 git 裡的內容；工作目錄有不同時另外附上差異
    let files: { path: string; name: string; content: string }[] = [];
    let contentError: string | null = null;
    let diff: string | null = null;
    if (current) {
      try {
        files = strategyFilesAt(o.root, current.version).map((f) => ({ ...f, name: f.path.slice(STRATEGY_DIR.length + 1) }));
        if (!filesMatch.ok && filesMatch.changed.length > 0) diff = strategyDiff(o.root, current.version).slice(0, 200_000);
      } catch (e) {
        contentError = (e as Error).message;
      }
    }
    const skill = files.find((f) => f.name === 'SKILL.md');
    return ok({
      current,
      files_match: filesMatch,
      files,
      content_error: contentError,
      diff,
      refs: skill ? checkIndicatorRefs(skill.content) : null,
      indicators: { default_sma_periods: DEFAULT_SMA_PERIODS, fields: INDICATOR_FIELDS, notes: INDICATOR_NOTES },
      versions,
      performance: perf.map((r) => ({ ...r, realized_pnl: Math.round(Number(r.realized_pnl)) })),
      proposals: db.prepare(`SELECT date, proposal_branch, status, reject_reason FROM reviews WHERE proposal_branch IS NOT NULL ORDER BY date DESC`).all(),
    });
  });

  app.get('/api/reviews', async (req) => {
    const { db } = viewDb(req);
    return ok(db.prepare('SELECT * FROM reviews ORDER BY date DESC LIMIT 100').all());
  });

  app.get('/api/usage', async (req) => {
    const { db } = viewDb(req);
    const daily = db
      .prepare(
        `SELECT substr(u.ts, 1, 10) AS date, COUNT(*) AS calls, SUM(COALESCE(u.input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(u.output_tokens, 0)) AS output_tokens, SUM(COALESCE(u.cache_read_tokens, 0)) AS cache_read_tokens,
                ROUND(SUM(COALESCE(u.cost_usd, 0)), 4) AS cost_usd, SUM(CASE WHEN u.exit_status <> 'ok' THEN 1 ELSE 0 END) AS failures
         FROM usage_log u GROUP BY date ORDER BY date DESC LIMIT 60`,
      )
      .all();
    const byKind = db
      .prepare(
        `SELECT COALESCE(t.kind, '-') AS kind, u.model, COUNT(*) AS calls, SUM(COALESCE(u.input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(u.output_tokens, 0)) AS output_tokens, ROUND(AVG(u.duration_ms) / 1000.0, 1) AS avg_seconds
         FROM usage_log u LEFT JOIN trigger_events t ON t.id = u.trigger_event_id
         WHERE u.ts >= date('now', '-30 day') GROUP BY kind, u.model ORDER BY calls DESC`,
      )
      .all();
    return ok({ budget: admin.usageBudget(db, o.config), warning: getState(db, 'usage_warning'), daily, by_kind: byKind });
  });

  app.get('/api/reconcile', async (req) => {
    const { db } = viewDb(req);
    return ok(
      (db.prepare('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 100').all() as Record<string, unknown>[]).map((r) => ({
        ...r,
        diffs: safeJson(r.diffs_json),
      })),
    );
  });

  app.get('/api/system', async (req) => {
    const { db, active } = viewDb(req);
    const today = twDate(o.clock.now());
    return ok({
      daemon: active ? await daemonInfo() : { running: false },
      heartbeat: getState(db, 'daemon_heartbeat'),
      claude_unavailable: getState(db, 'claude_unavailable'),
      last_claude_end: getState(db, 'last_claude_end'),
      trigger: getTriggerConfig(db),
      fixed_triggers: getMarketRules(db, today).fixed_triggers,
      holidays: db.prepare('SELECT * FROM holidays WHERE date >= ? ORDER BY date').all(today),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all(),
    });
  });

  // ---------------------------------------------------------------- 寫入（core/admin.ts）
  const post = (path: string, fn: (req: FastifyRequest) => Promise<unknown>) =>
    app.post(`/api/admin/${path}`, async (req: FastifyRequest, _reply: FastifyReply) => ok(await fn(req)));

  post('allocate', async (req) => {
    const b = body<{ amount: unknown; note?: string }>(req);
    return admin.allocateFunds(await adminCtx(true), { amount: int('amount', b.amount), note: b.note });
  });
  post('withdraw', async (req) => {
    const b = body<{ amount: unknown; note?: string }>(req);
    return admin.withdrawFunds(await adminCtx(true), { amount: int('amount', b.amount), note: b.note });
  });
  post('transfer-in', async (req) => {
    const b = body<{ symbol: unknown; qty: unknown; cost?: unknown; note?: string }>(req);
    const symbol = symbolArg(b.symbol);
    const ctx = await adminCtx(false);
    ctx.quotes = await admin.quotesFromDaemon(o.ipcPath, [symbol, ...getPositions(views.active).map((p) => p.symbol)]);
    return admin.transferSharesIn(ctx, {
      symbol,
      qty: int('qty', b.qty),
      costPerShareX100: b.cost === undefined || b.cost === '' || b.cost === null ? undefined : priceArg(b.cost),
      note: b.note,
    });
  });
  post('transfer-out', async (req) => {
    const b = body<{ symbol: unknown; qty: unknown; note?: string }>(req);
    return admin.transferSharesOut(await adminCtx(true), { symbol: symbolArg(b.symbol), qty: int('qty', b.qty), note: b.note });
  });
  post('pause', async (req) => admin.pauseTrading(await adminCtx(), body<{ reason?: string }>(req)));
  post('resume', async (req) => admin.resumeTrading(await adminCtx(true), body<{ resetPeak?: boolean }>(req)));
  post('cancel-all', async () => admin.cancelAllOrders(await adminCtx()));
  post('flatten', async () => admin.flattenAll(await adminCtx()));
  post('risk', async (req) => admin.updateRiskParams(await adminCtx(), body<{ patch: Partial<RiskParams> }>(req).patch ?? {}));
  post('fees', async (req) => {
    const fee = await admin.addFeeVersion(await adminCtx(), body<Parameters<typeof admin.addFeeVersion>[1]>(req));
    return { id: fee.id, effective_date: fee.effective_date };
  });
  post('holiday', async (req) => admin.markHoliday(await adminCtx(), body<{ date: string; reason?: string }>(req)));
  post('claude-reset', async () => admin.resetClaude(await adminCtx()));
  post('usage-budget', async (req) => {
    const b = body<{ daily_budget_tokens: unknown; weekly_budget_tokens: unknown }>(req);
    return admin.setUsageBudget(await adminCtx(), {
      daily_budget_tokens: int('daily_budget_tokens', b.daily_budget_tokens),
      weekly_budget_tokens: int('weekly_budget_tokens', b.weekly_budget_tokens),
    });
  });
  post('reconcile', async () => admin.runReconciliation(await adminCtx()));
  post('reconcile-resolve', async (req) => {
    const b = body<{ id: unknown; note: string }>(req);
    return admin.resolveReconciliation(await adminCtx(), { id: int('id', b.id), note: b.note });
  });
  post('strategy-activate', async (req) => admin.activateCurrentStrategy(await adminCtx(), body<{ note?: string }>(req)));

  app.get('/api/valuation', async (req) => {
    const { db, active } = viewDb(req);
    return ok(valuate(db, await quotesFor(db, active), o.config.symbols));
  });

  return {
    app,
    token,
    close: () => {
      views.active.close();
      views.other?.close();
    },
  };
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
