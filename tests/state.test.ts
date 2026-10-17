import { beforeEach, describe, expect, it } from 'vitest';
import { addJournal, getStops, getTriggerConfig, setStop, setTriggerConfig } from '../core/claude-ops.js';
import { resolveMode } from '../core/config.js';
import { allocate, transferIn } from '../core/ledger.js';
import { evaluateEquityHalts, scalePeaksForFlow } from '../core/risk.js';
import { addFeeSchedule, getFeeSchedule, setRiskParams } from '../core/settings.js';
import { getPause, getState, pause, resume, setState } from '../core/state.js';
import { type TestEnv, errorCode, makeEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

describe('模式', () => {
  it('CTRADE_MODE 與設定檔不一致時拒絕', () => {
    expect(resolveMode('paper', undefined)).toBe('paper');
    expect(resolveMode('paper', 'PAPER')).toBe('paper');
    expect(() => resolveMode('paper', 'live')).toThrow(/不一致/);
    expect(() => resolveMode('demo', undefined)).toThrow();
  });
});

describe('停機條件', () => {
  const setup = () => {
    setState(env.db, 'day_start_equity', '100000', env.clock);
    setState(env.db, 'intraday_peak_equity', '100000', env.clock);
    setState(env.db, 'peak_equity', '100000', env.clock);
  };

  it('當日虧損達開盤前權益 10%', () => {
    setup();
    expect(evaluateEquityHalts(env.db, 90_001, env.clock)).toBeNull();
    expect(evaluateEquityHalts(env.db, 90_000, env.clock)?.rule).toBe('daily_loss_limit');
  });

  it('當日先賺後賠：自盤中高點回撤 15%', () => {
    setup();
    expect(evaluateEquityHalts(env.db, 120_000, env.clock)).toBeNull();
    expect(getState(env.db, 'intraday_peak_equity')).toBe('120000');
    // 102000 仍高於開盤前權益，但自高點 120000 回撤 15%
    expect(evaluateEquityHalts(env.db, 102_000, env.clock)?.rule).toBe('intraday_drawdown');
  });

  it('跨日累計回撤 25%：盤中不更新歷史高點', () => {
    setState(env.db, 'peak_equity', '100000', env.clock);
    setState(env.db, 'day_start_equity', '80000', env.clock);
    setState(env.db, 'intraday_peak_equity', '80000', env.clock);
    expect(evaluateEquityHalts(env.db, 76_000, env.clock)).toBeNull(); // 當日 -5%、累計 -24%
    expect(evaluateEquityHalts(env.db, 75_000, env.clock)?.rule).toBe('max_drawdown');
    expect(getState(env.db, 'peak_equity')).toBe('100000');
  });

  it('資金異動時高點按比例縮放，回撤比例不變', () => {
    setState(env.db, 'peak_equity', '120000', env.clock);
    scalePeaksForFlow(env.db, 100_000, 50_000, env.clock);
    expect(getState(env.db, 'peak_equity')).toBe('60000');
  });

  it('第一次撥入時以撥入後權益初始化高點', () => {
    scalePeaksForFlow(env.db, 0, 100_000, env.clock);
    expect(getState(env.db, 'peak_equity')).toBe('100000');
  });
});

describe('暫停與恢復', () => {
  it('跨日回撤停機後必須重設高點才能恢復', () => {
    pause(env.db, 'max_drawdown', '回撤 25%', env.clock);
    expect(errorCode(() => resume(env.db, { resetPeak: false, currentEquity: 75_000 }, env.clock))).toBe('RESET_PEAK_REQUIRED');
    resume(env.db, { resetPeak: true, currentEquity: 75_000 }, env.clock);
    expect(getPause(env.db).paused).toBe(false);
    expect(getState(env.db, 'peak_equity')).toBe('75000');
    expect(env.db.prepare(`SELECT COUNT(*) FROM risk_events WHERE rule = 'peak_reset'`).pluck().get()).toBe(1);
  });

  it('手動暫停可直接恢復', () => {
    pause(env.db, 'manual', '測試', env.clock);
    resume(env.db, { resetPeak: false }, env.clock);
    expect(getPause(env.db).paused).toBe(false);
  });
});

describe('觸發條件', () => {
  it('超出允許範圍時拒絕並回報範圍', () => {
    expect(errorCode(() => setTriggerConfig(env.db, { interval_min: 2 }, 'claude', env.clock))).toBe('TRIGGER_OUT_OF_RANGE');
    expect(errorCode(() => setTriggerConfig(env.db, { price: { up_pct: 11, down_pct: 2 } }, 'claude', env.clock))).toBe(
      'TRIGGER_OUT_OF_RANGE',
    );
    setTriggerConfig(env.db, { interval_min: 10, price: { up_pct: 2, down_pct: 1.5 } }, 'claude', env.clock);
    expect(getTriggerConfig(env.db)).toMatchObject({ interval_min: 10, up_pct: 2, down_pct: 1.5, set_by: 'claude' });
  });

  it('不能兩者都關，有持股時不能關閉價格觸發', () => {
    setTriggerConfig(env.db, { price: null }, 'claude', env.clock);
    expect(errorCode(() => setTriggerConfig(env.db, { interval_min: null }, 'claude', env.clock))).toBe('TRIGGER_ALL_OFF');
    setTriggerConfig(env.db, { price: { up_pct: 3, down_pct: 2 } }, 'claude', env.clock);
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5000, actor: 'user' }, env.clock);
    expect(errorCode(() => setTriggerConfig(env.db, { price: null }, 'claude', env.clock))).toBe('PRICE_TRIGGER_REQUIRED');
  });
});

describe('硬停損停利', () => {
  beforeEach(() => {
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5000, actor: 'user' }, env.clock);
  });

  it('Claude 只能上調停損價，系統可以下調', () => {
    setStop(env.db, { symbol: '0050', stopX100: 4800, takeProfitX100: 5500, actor: 'claude' }, env.clock);
    expect(errorCode(() => setStop(env.db, { symbol: '0050', stopX100: 4700, actor: 'claude' }, env.clock))).toBe('STOP_CANNOT_LOWER');
    setStop(env.db, { symbol: '0050', stopX100: 4900, actor: 'claude' }, env.clock);
    setStop(env.db, { symbol: '0050', stopX100: 4700, actor: 'system', reason: '除息調整' }, env.clock);
    expect(getStops(env.db)[0]).toMatchObject({ stop_x100: 4700, take_profit_x100: 5500 });
  });

  it('停損須低於停利，沒有持股不能設定', () => {
    expect(errorCode(() => setStop(env.db, { symbol: '0050', stopX100: 5600, takeProfitX100: 5500, actor: 'claude' }, env.clock))).toBe(
      'STOP_ABOVE_TAKE_PROFIT',
    );
    expect(errorCode(() => setStop(env.db, { symbol: '00631L', stopX100: 1800, actor: 'claude' }, env.clock))).toBe('NO_POSITION');
  });
});

describe('決策記錄', () => {
  it('寫入並附上當下觸發條件', () => {
    const id = addJournal(env.db, { reasoning: '量縮整理，不動作', actions: '不動作' }, env.clock);
    const row = env.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as { next_trigger_json: string };
    expect(JSON.parse(row.next_trigger_json)).toMatchObject({ interval_min: 5 });
    expect(errorCode(() => addJournal(env.db, { reasoning: '  ', actions: 'x' }, env.clock))).toBe('EMPTY_REASONING');
  });
});

describe('版本化設定', () => {
  it('費率新增版本，生效日不可回溯，舊日期仍查得到舊費率', () => {
    allocate(env.db, 1, 'user', undefined, env.clock);
    const input = {
      fee_rate_pct: 0.1425,
      fee_discount: 0.28,
      rebate_mode: 'instant' as const,
      min_fee_regular: 20,
      min_fee_odd: 1,
      tax_stock_pct: 0.3,
      tax_daytrade_pct: 0.15,
      tax_etf_pct: 0.1,
    };
    expect(errorCode(() => addFeeSchedule(env.db, input, '2026-10-18', env.clock))).toBe('RETROACTIVE_DATE');
    expect(errorCode(() => addFeeSchedule(env.db, { ...input, fee_rate_pct: 2 }, '2026-10-20', env.clock))).toBe('FEE_RANGE');
    addFeeSchedule(env.db, input, '2026-10-20', env.clock);
    expect(getFeeSchedule(env.db, '2026-10-19').fee_discount_bp).toBe(10_000);
    expect(getFeeSchedule(env.db, '2026-10-20').fee_discount_bp).toBe(2800);
  });

  it('風控參數驗證範圍', () => {
    expect(errorCode(() => setRiskParams(env.db, { max_position_pct: 150 }, env.clock))).toBe('RISK_PARAM_RANGE');
    expect(setRiskParams(env.db, { max_order_amount: 20_000 }, env.clock).max_order_amount).toBe(20_000);
  });
});
