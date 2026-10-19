import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectRoot } from '../core/config.js';
import { contextReport, contextSummary, saveContext } from '../core/market-context.js';
import { MarketContextJobs, parseTaifexNight, parseYahooChart } from '../daemon/market-context.js';
import { renderPrompt } from '../daemon/prompts.js';
import { buildStatus } from '../core/status.js';
import { type TestEnv, makeEnv } from './helpers.js';

/** 盤外資訊（規格第 14 節）：解析公開來源、寫入快取、過期判斷、pre_open 提示摘要。 */

const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00.000+08:00`);
const MONDAY = '2026-10-19';
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(projectRoot(), 'tests', 'fixtures', 'market-context', name), 'utf8'));

describe('解析', () => {
  it('Yahoo 日 K：最後一根對前一根算漲跌，日期用交易所當地時間', () => {
    const r = parseYahooChart(fixture('yahoo-sox.json'), '^SOX', at(MONDAY, '08:45'));
    expect(r).toMatchObject({ date: '2026-10-16', close: 11137.29, prev_close: 11581.21, change_pct: -3.83, in_progress: false });
    expect(r.change).toBeCloseTo(-443.92, 2);
  });

  it('Yahoo：美股交易時段內抓取時標示盤中', () => {
    // 固定檔的交易時段是美東 2026-10-16 09:30–16:00（台灣 21:30–04:00）
    const r = parseYahooChart(fixture('yahoo-sox.json'), '^SOX', at('2026-10-16', '23:00'));
    expect(r.in_progress).toBe(true);
  });

  it('Yahoo 匯率保留四位小數', () => {
    const r = parseYahooChart(fixture('yahoo-twd.json'), 'TWD=X', at(MONDAY, '08:45'), 4);
    expect(r).toMatchObject({ close: 32.386, prev_close: 32.3269, quoted_at: '2026-10-19T08:01:21.000+08:00' });
  });

  it('Yahoo 沒有資料時丟出來源的錯誤訊息', () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { description: 'No data found' } } }, 'X', new Date())).toThrow(
      'No data found',
    );
  });

  it('期交所夜盤：取近月合約，05:00 前的成交時間屬於隔天', () => {
    const r = parseTaifexNight(fixture('taifex-night.json'), at(MONDAY, '08:45'));
    expect(r).toMatchObject({
      contract: '臺指期106',
      symbol_id: 'TXFJ6-M',
      session_date: '2026-10-16',
      last: 46140,
      ref: 47284,
      change: -1144,
      change_pct: -2.42,
      volume: 40941,
      last_trade_at: '2026-10-17T04:59:57.000+08:00',
      in_progress: false,
      spot_ref: 47111.26,
    });
    expect(parseTaifexNight(fixture('taifex-night.json'), at(MONDAY, '22:00')).in_progress).toBe(true);
  });

  it('期交所：錯誤回應與尚無成交都丟出錯誤', () => {
    expect(() => parseTaifexNight({ RtCode: '1', RtMsg: '參數有誤' }, new Date())).toThrow('參數有誤');
    const json = fixture('taifex-night.json') as { RtData: { QuoteList: { SymbolID: string; CLastPrice: string }[] } };
    json.RtData.QuoteList.find((q) => q.SymbolID === 'TXFJ6-M')!.CLastPrice = '0.00';
    expect(() => parseTaifexNight(json, new Date())).toThrow('尚無成交');
  });
});

/** 依網址回傳固定檔；taifexFails 為 true 時期交所連線失敗。 */
function fakeFetch(opts: { taifexFails?: boolean } = {}) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes('taifex')) {
      if (opts.taifexFails) throw new Error('connect ETIMEDOUT');
      return Response.json(fixture('taifex-night.json'));
    }
    return Response.json(fixture(url.includes('TWD') ? 'yahoo-twd.json' : 'yahoo-sox.json'));
  };
  return { fn, calls };
}

describe('抓取與快取', () => {
  let env: TestEnv;
  let logs: string[];
  const jobs = (fetch: ReturnType<typeof fakeFetch>) =>
    new MarketContextJobs(env.db, env.clock, { refreshMin: 15, fetch: fetch.fn, log: (m) => logs.push(m) });
  const rows = () => env.db.prepare('SELECT kind, ts, fetched_at FROM market_context ORDER BY id').all() as { kind: string; ts: string; fetched_at: string }[];

  beforeEach(() => {
    env = makeEnv(`${MONDAY}T08:30:00.000+08:00`);
    logs = [];
  });

  it('三項都寫入；資料沒變時只更新 fetched_at，不新增列', async () => {
    const f = fakeFetch();
    const j = jobs(f);
    await j.refresh();
    expect(rows().map((r) => r.kind).sort()).toEqual(['taifex_night', 'us_markets', 'usdtwd']);
    expect(f.calls).toHaveLength(6); // 美股 4 檔、期交所、匯率

    env.clock.advanceMinutes(15);
    await j.refresh();
    expect(rows()).toHaveLength(3);
    expect(rows().every((r) => r.fetched_at === '2026-10-19T08:45:00.000+08:00')).toBe(true);

    const report = contextReport(env.db, env.clock, 15);
    expect(report.us_markets.status).toBe('ok');
    expect(report.us_markets.data?.quotes.map((q) => q.name)).toEqual(['S&P 500', '那斯達克', '費城半導體', '台積電 ADR']);
    expect(report.taifex_night).toMatchObject({ status: 'ok', data_time: '2026-10-17T04:59:57.000+08:00', source: '臺灣期貨交易所' });
  });

  it('一項失敗不影響其他項；同樣的錯誤只寫一次日誌，成功後清除', async () => {
    const j = jobs(fakeFetch({ taifexFails: true }));
    await j.refresh();
    env.clock.advanceMinutes(15);
    await j.refresh();
    expect(rows().map((r) => r.kind).sort()).toEqual(['us_markets', 'usdtwd']);
    expect(logs).toEqual(['盤外資訊「台指期夜盤」抓取失敗：connect ETIMEDOUT']);

    const report = contextReport(env.db, env.clock, 15);
    expect(report.taifex_night).toMatchObject({ status: 'missing', fetch_error: { error: 'connect ETIMEDOUT' } });
    expect(contextSummary(report)).toContain('- 台指期夜盤：資料缺漏（最近一次抓取失敗：connect ETIMEDOUT）');

    await jobs(fakeFetch()).refresh();
    expect(contextReport(env.db, env.clock, 15).taifex_night.fetch_error).toBeUndefined();
  });

  it('只在交易日、且距上次抓取滿間隔才抓', async () => {
    const f = fakeFetch();
    const j = jobs(f);
    await j.maybeRefresh();
    expect(f.calls).toHaveLength(6);
    env.clock.advanceMinutes(10);
    await j.maybeRefresh();
    expect(f.calls).toHaveLength(6);
    env.clock.advanceMinutes(5);
    await j.maybeRefresh();
    expect(f.calls).toHaveLength(12);

    env.clock.set('2026-10-17T10:00:00.000+08:00'); // 週六
    await jobs(f).maybeRefresh();
    expect(f.calls).toHaveLength(12);
  });

  it('過期：超過兩倍間隔沒有成功更新，或資料時間超過 120 小時', async () => {
    await jobs(fakeFetch()).refresh();
    env.clock.advanceMinutes(31);
    const r = contextReport(env.db, env.clock, 15);
    expect(r.usdtwd).toMatchObject({ status: 'stale', stale_reason: expect.stringContaining('超過 30 分鐘沒有成功更新') });
    expect(contextSummary(r)).toContain('美元兌新台幣【過期：');

    saveContext(env.db, 'taifex_night', { data_time: '2026-10-12T04:59:00.000+08:00', source: 'test', content: r.taifex_night.data! }, env.clock);
    expect(contextReport(env.db, env.clock, 15).taifex_night).toMatchObject({ status: 'stale', stale_reason: '資料時間超過 120 小時' });
  });

  it('pre_open 提示附上摘要：每項一行，含來源與資料時間', async () => {
    await jobs(fakeFetch()).refresh();
    const summary = contextSummary(contextReport(env.db, env.clock, 15));
    expect(summary.split('\n')).toEqual([
      expect.stringMatching(/^- 美股：S&P 500 11,137\.29（-3\.83%）.*當地 2026-10-16 收盤，來源 Yahoo Finance$/),
      '- 台指期夜盤：臺指期106 46,140，較日盤收盤 47,284 -1,144（-2.42%）；加權指數前一日收盤 47,111.26。夜盤已收盤，最後成交 2026-10-17 04:59:57，來源 臺灣期貨交易所',
      expect.stringMatching(/^- 美元兌新台幣：32\.386，較前一日 32\.327 \+0\.059（\+0\.18%）；數字上升代表新台幣貶值。報價時間 2026-10-19 08:01:21/),
    ]);

    const prompt = renderPrompt(
      projectRoot(),
      { kind: 'pre_open', fixed: true, reason: '固定觸發 pre_open（08:45）' },
      { mode: 'paper', now: '2026-10-19T08:45:00.000+08:00', status: buildStatus(env.db, env.config, env.clock, env.quotes), notes: [], globalSummary: summary },
    );
    expect(prompt).toContain('## 隔夜國際行情（ctrade global 摘要）');
    expect(prompt).toContain('- 台指期夜盤：臺指期106 46,140');
    expect(prompt).not.toContain('{{global_summary}}');
  });
});
