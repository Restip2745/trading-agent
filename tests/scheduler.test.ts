import { beforeEach, describe, expect, it } from 'vitest';
import { setTriggerConfig } from '../core/claude-ops.js';
import { setState } from '../core/state.js';
import { toTwIso } from '../core/time.js';
import { TriggerScheduler } from '../daemon/scheduler.js';
import { type TestEnv, makeEnv } from './helpers.js';

const at = (hhmm: string) => `2026-10-19T${hhmm}:00.000+08:00`;

let env: TestEnv;
let s: TriggerScheduler;

beforeEach(() => {
  env = makeEnv(at('08:00'));
  s = new TriggerScheduler(env.db, env.config, env.clock, env.quotes);
});

const fire = (kind: string, hhmm: string) =>
  env.db.prepare(`INSERT INTO trigger_events (ts, kind, invoked_claude) VALUES (?, ?, 1)`).run(at(hhmm), kind);

describe('固定觸發', () => {
  it('到時間才到期，同一天只執行一次', () => {
    expect(s.dueFixed().run).toBeUndefined();
    env.clock.set(at('08:45'));
    expect(s.dueFixed().run).toMatchObject({ kind: 'pre_open', fixed: true, missed: false });
    fire('pre_open', '08:45');
    expect(s.dueFixed().run).toBeUndefined();
    env.clock.set(at('09:01'));
    expect(s.dueFixed().run?.kind).toBe('open');
  });

  it('非交易日不觸發', () => {
    env.clock.set('2026-10-17T09:01:00.000+08:00'); // 週六
    expect(s.dueFixed().run).toBeUndefined();
  });

  it('重啟時錯過多個盤中固定觸發，只補跑最近的一個並標示補跑', () => {
    env.clock.set(at('11:00'));
    const due = s.dueFixed();
    expect(due.run).toMatchObject({ kind: 'open', missed: true });
    expect(due.superseded).toEqual(['pre_open']);
  });

  it('收盤後才發現錯過 pre_close 不補跑；錯過的 review 一定補跑', () => {
    fire('pre_open', '08:45');
    fire('open', '09:01');
    env.clock.set(at('13:40'));
    expect(s.dueFixed()).toEqual({ superseded: ['pre_close'] });
    env.clock.set(at('16:00'));
    expect(s.dueFixed().run).toMatchObject({ kind: 'review', missed: true });
  });
});

describe('動態觸發', () => {
  beforeEach(() => {
    env.clock.set(at('09:30'));
    fire('open', '09:01');
    setState(env.db, 'last_claude_end', at('09:20'), env.clock);
  });

  it('開盤觸發執行前不啟動動態觸發', () => {
    env.db.prepare(`DELETE FROM trigger_events`).run();
    expect(s.inDynamicWindow()).toBe(false);
  });

  it('定時觸發：距上次工作階段結束滿 interval 分鐘', () => {
    setTriggerConfig(env.db, { interval_min: 15 }, 'claude', env.clock);
    expect(s.dueInterval()).toBeUndefined(); // 10 分鐘
    env.clock.set(at('09:35'));
    expect(s.dueInterval()?.kind).toBe('interval');
  });

  it('定時觸發可關閉', () => {
    setTriggerConfig(env.db, { interval_min: null }, 'claude', env.clock);
    env.clock.set(at('12:00'));
    expect(s.dueInterval()).toBeUndefined();
  });

  it('價格觸發：相對上次決策時的價格漲跌超過門檻', () => {
    env.db.prepare(`INSERT INTO price_refs (symbol, price_x100, set_at) VALUES ('0050', 5000, ?)`).run(at('09:20'));
    env.quotes.set('0050', 5090); // +1.8%，未達 up 3%
    expect(s.duePriceMove()).toBeUndefined();
    env.quotes.set('0050', 4895); // -2.1%，達 down 2%
    const t = s.duePriceMove();
    expect(t?.kind).toBe('price_move');
    expect(t?.reason).toContain('0050 50.00→48.95');
  });

  it('收盤後不再有動態觸發', () => {
    env.clock.set(at('13:35'));
    expect(s.dueInterval()).toBeUndefined();
  });
});

it('watchSymbols 包含白名單與帳本持股', () => {
  env.db
    .prepare(`INSERT INTO position_movements (ts, symbol, type, qty, cost_x100, actor) VALUES (?, '2330', 'transfer_in', 1, 100000, 'user')`)
    .run(toTwIso(env.clock.now()));
  expect(s.watchSymbols().sort()).toEqual(['0050', '00631L', '00632R', '2330']);
});
