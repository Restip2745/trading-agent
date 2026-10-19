import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, projectRoot } from '../core/config.js';
import { testClock } from './helpers.js';
import { buildServer } from '../web/server.js';
import { renderMarkdown } from '../web/public/markdown.js';
import { STRATEGY_DIR } from '../core/strategy.js';

/**
 * Web UI 後端（規格第 11 節）。第 5 階段驗收：從 Web UI 撥入資金、轉入持股、暫停與恢復，帳本流水正確反映。
 */

const PORT = 18787;
const TOKEN = 'test-token-0123456789abcdef';
const HOST = `127.0.0.1:${PORT}`;

let dir: string;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ctrade-web-'));
  const config = loadConfig(projectRoot());
  config.mode = 'paper';
  config.risk.max_order_amount = 30_000;
  server = await buildServer({
    root: projectRoot(),
    config,
    clock: testClock('2026-10-19T10:00:00.000+08:00'),
    ipcPath: process.platform === 'win32' ? `\\\\.\\pipe\\ctrade-web-none-${process.pid}` : join(dir, 'none.sock'),
    port: PORT,
    token: TOKEN,
    dbPath: join(dir, 'paper.db'),
  });
});

afterAll(async () => {
  await server.app.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, host = HOST) => server.app.inject({ method: 'GET', url, headers: { host } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({
    method: 'POST',
    url: `/api/admin/${path}`,
    headers: { host: HOST, 'content-type': 'application/json', 'x-ctrade-token': TOKEN, ...headers },
    payload: JSON.stringify(body),
  });

describe('安全', () => {
  it('Host 不是 127.0.0.1 或 localhost 時拒絕（DNS rebinding）', async () => {
    expect((await get('/api/meta', 'evil.example.com')).statusCode).toBe(403);
    expect((await get('/api/meta', `localhost:${PORT}`)).statusCode).toBe(200);
  });

  it('寫入請求必須帶正確的 token', async () => {
    expect((await post('pause', {}, { 'x-ctrade-token': '' })).statusCode).toBe(403);
    expect((await post('pause', {}, { 'x-ctrade-token': 'x'.repeat(TOKEN.length) })).statusCode).toBe(403);
  });

  it('寫入請求必須是 JSON（擋下跨站表單送出）', async () => {
    const r = await server.app.inject({
      method: 'POST',
      url: '/api/admin/pause',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', 'x-ctrade-token': TOKEN },
      payload: 'reason=x',
    });
    expect(r.statusCode).toBe(415);
  });

  it('首頁嵌入 token 與模式，回應帶 CSP 且禁止被嵌入', async () => {
    const r = await get('/');
    expect(r.body).toContain(`content="${TOKEN}"`);
    expect(r.body).toContain('content="paper"');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('只提供 Vue 的瀏覽器版本，不開放 node_modules 其他檔案', async () => {
    expect((await get('/vendor/vue/vue.esm-browser.prod.js')).statusCode).toBe(200);
    expect((await get('/vendor/vue/vue.cjs.js')).statusCode).toBe(404);
  });
});

describe('第 5 階段驗收：資金、持股、暫停與恢復', () => {
  it('撥入資金後帳本流水與餘額正確', async () => {
    const r = await post('allocate', { amount: 200_000, note: 'Web UI 撥入' });
    expect(r.statusCode).toBe(200);
    const ledger = (await get('/api/ledger')).json().data;
    expect(ledger.balance).toEqual({ cash: 200_000, reserved: 0, available: 200_000 });
    expect(ledger.cash[0]).toMatchObject({ type: 'allocate_in', amount: 200_000, actor: 'user', note: 'Web UI 撥入' });
  });

  it('轉入持股後持倉與持股流水正確', async () => {
    const r = await post('transfer-in', { symbol: '0050', qty: 300, cost: '108.50' });
    expect(r.statusCode).toBe(200);
    const positions = (await get('/api/positions')).json().data;
    expect(positions).toMatchObject([{ symbol: '0050', qty: 300, avg_cost: '108.50', total_cost: 32_550 }]);
    const ledger = (await get('/api/ledger')).json().data;
    expect(ledger.positions[0]).toMatchObject({ type: 'transfer_in', qty: 300, cost: 32_550 });
  });

  it('總覽：權益與投入本金', async () => {
    const d = (await get('/api/overview')).json().data;
    expect(d.status.equity).toBe(232_550); // 現金 + 以成本估值的持股（沒有 daemon 報價）
    expect(d.contributed).toBe(232_550);
    expect(d.daemon.running).toBe(false);
  });

  it('暫停與恢復', async () => {
    expect((await post('pause', { reason: '測試暫停' })).json().data).toMatchObject({ paused: true, reason: '測試暫停' });
    expect((await get('/api/overview')).json().data.pause.paused).toBe(true);
    expect((await post('resume', {})).json().data.paused).toBe(false);
  });

  it('寫入都記錄在稽核記錄，操作者為 web', async () => {
    const audit = (await get('/api/system')).json().data.audit as { command: string; actor: string; result: string }[];
    expect(audit.map((a) => a.command)).toEqual(expect.arrayContaining(['allocate', 'transfer-in', 'pause', 'resume']));
    expect(audit.every((a) => a.actor === 'web')).toBe(true);
  });
});

describe('驗證與錯誤', () => {
  it('撥出超過可用資金：400 並寫出限制值', async () => {
    const r = await post('withdraw', { amount: 999_999 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'WITHDRAW_EXCEEDS_AVAILABLE' });
    expect(r.json().error.message).toContain('200000');
  });

  it('參數型別錯誤', async () => {
    expect((await post('allocate', { amount: '100' })).json().error.code).toBe('INVALID_ARGS');
    expect((await post('transfer-in', { symbol: 'bad!', qty: 1 })).json().error.code).toBe('INVALID_SYMBOL');
  });

  it('風控參數超出範圍時拒絕，合法時新增版本', async () => {
    expect((await post('risk', { patch: { max_position_pct: 500 } })).json().error.code).toBe('RISK_PARAM_RANGE');
    expect((await post('risk', { patch: { max_order_amount: 50_000 } })).json().data.max_order_amount).toBe(50_000);
    expect((await get('/api/risk')).json().data.params.max_order_amount).toBe(50_000);
  });

  it('費率新增版本，未填欄位沿用', async () => {
    const r = await post('fees', { effective: '2026-10-20', fee_discount: 0.38 });
    expect(r.statusCode).toBe(200);
    const fees = (await get('/api/fees')).json().data;
    expect(fees.schedules[0]).toMatchObject({ effective_date: '2026-10-20', fee_discount: 0.38, fee_rate_pct: 0.1425 });
  });

  it('用量預算', async () => {
    expect((await post('usage-budget', { daily_budget_tokens: 100, weekly_budget_tokens: 50 })).json().error.code).toBe('INVALID_BUDGET');
    await post('usage-budget', { daily_budget_tokens: 500_000, weekly_budget_tokens: 2_000_000 });
    expect((await get('/api/usage')).json().data.budget).toEqual({ daily_budget_tokens: 500_000, weekly_budget_tokens: 2_000_000 });
  });

  it('對帳與標記處理', async () => {
    expect((await post('reconcile', {})).json().data.status).toBe('ok');
    const runs = (await get('/api/reconcile')).json().data;
    expect(runs[0]).toMatchObject({ status: 'ok', diffs: [] });
    expect((await post('reconcile-resolve', { id: runs[0].id, note: '' })).json().error.code).toBe('NOTE_REQUIRED');
  });

  it('緊急操作需要 daemon：未執行時回 502', async () => {
    const r = await post('cancel-all', {});
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('DAEMON_UNAVAILABLE');
  });

  it('休市日', async () => {
    await post('holiday', { date: '2026-10-21', reason: '颱風' });
    expect((await get('/api/system')).json().data.holidays).toEqual([{ date: '2026-10-21', reason: '颱風', source: 'user' }]);
    expect((await post('holiday', { date: '2026/10/21' })).json().error.code).toBe('INVALID_DATE');
  });
});

describe('策略頁', () => {
  it('尚未啟用版本時回報不一致，仍提供指標目錄', async () => {
    const data = (await get('/api/strategy')).json().data;
    expect(data.current).toBeNull();
    expect(data.files_match).toMatchObject({ ok: false, reason: expect.stringContaining('尚未啟用') });
    expect(data.files).toEqual([]);
    expect(data.indicators.fields.map((f: { path: string }) => f.path)).toContain('intraday.vwap');
  });

  it('顯示生效版本在 git 裡的策略檔內容與指標引用檢查', async () => {
    const version = spawnSync('git', ['log', '-1', '--format=%H', '--', STRATEGY_DIR], { cwd: projectRoot(), encoding: 'utf8' }).stdout.trim();
    const db = new Database(join(dir, 'paper.db'));
    db.prepare('INSERT INTO strategy_versions (version, activated_at, note) VALUES (?, ?, ?)').run(version, '2026-10-19T09:00:00.000+08:00', '測試');
    db.close();
    const data = (await get('/api/strategy')).json().data;
    expect(data.current).toMatchObject({ version, note: '測試', subject: expect.any(String) });
    expect(data.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['SKILL.md', 'reference.md']));
    expect(data.files.find((f: { name: string }) => f.name === 'SKILL.md').content).toContain('name: trading-strategy');
    expect(data.refs).toMatchObject({ ok: true, unknown: [] });
  });

  it('Markdown 轉換：跳脫 HTML、不輸出連結，支援表格與巢狀清單', () => {
    const html = renderMarkdown(['# 標題', '<script>alert(1)</script> **粗** `a<b`', '', '| 欄 | 值 |', '| --- | --- |', '| x | [連結](javascript:alert(1)) |', '', '1. 一', '   - 子項', '2. 二'].join('\n'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>粗</strong> <code>a&lt;b</code>');
    expect(html).toContain('<th>欄</th>');
    expect(html).toContain('<ol><li>一<ul><li>子項</li></ul></li><li>二</li></ol>');
  });
});

describe('決策日誌的指標快照', () => {
  it('回傳決策當下的快照；取不到時回傳原因；舊的決策兩者皆為 null', async () => {
    const db = new Database(join(dir, 'paper.db'));
    const insert = db.prepare('INSERT INTO decisions (ts, reasoning, actions_json, indicators_json, indicators_error) VALUES (?, ?, ?, ?, ?)');
    const snap = { symbol: '0050', as_of: '2026-10-19T10:00:00.000+08:00', last_price: 110.5, intraday: { vwap: 110.9, below_vwap_pct: 0.361 } };
    insert.run('2026-10-19T09:00:00.000+08:00', '舊的決策', '"不動作"', null, null);
    insert.run('2026-10-19T09:30:00.000+08:00', 'daemon 未執行', '"不動作"', null, 'DAEMON_UNAVAILABLE：無法連線到 daemon');
    insert.run('2026-10-19T10:00:00.000+08:00', '有快照', '"不動作"', JSON.stringify(snap), null);
    db.close();

    const rows = (await get('/api/decisions?date=2026-10-19')).json().data as Record<string, unknown>[];
    const by = (reasoning: string) => rows.find((r) => r.reasoning === reasoning);
    expect(by('有快照')).toMatchObject({ indicators: snap, indicators_error: null });
    expect(by('daemon 未執行')).toMatchObject({ indicators: null, indicators_error: expect.stringMatching(/^DAEMON_UNAVAILABLE/) });
    expect(by('舊的決策')).toMatchObject({ indicators: null, indicators_error: null });
    expect(by('有快照')).not.toHaveProperty('indicators_json');
  });

  it('指標欄位目錄', async () => {
    const data = (await get('/api/indicators/fields')).json().data;
    expect(data.fields.map((f: { path: string }) => f.path)).toContain('intraday.last_bar.volume_vs_avg');
  });
});
