#!/usr/bin/env node
/**
 * ctrade-admin：只給使用者與 Web UI 使用的管理 CLI（規格第 5 節）。
 * Claude Code 的權限設定不開放這個執行檔。所有操作都寫入 audit_log。
 */
import { Command, Option } from 'commander';
import type { RiskParams } from '../core/config.js';
import type { DB } from '../core/db.js';
import { CtradeError, ExitCode, invalidArgs } from '../core/errors.js';
import { allocate, getPositions, transferIn, transferOut, withdraw } from '../core/ledger.js';
import { valuate } from '../core/market.js';
import { checkLedgerConsistency, recordReconciliation } from '../core/reconcile.js';
import { scalePeaksForFlow } from '../core/risk.js';
import { type FeeScheduleInput, addFeeSchedule, getFeeSchedule, getRiskParams, setRiskParams } from '../core/settings.js';
import { addHoliday, audit, getPause, getState, pause, resume, setState } from '../core/state.js';
import { DailyJobs } from '../daemon/daily.js';
import { isValidDate, twDate } from '../core/time.js';
import { type Ctx, getCtx, initMode, loadQuotes, parseIntArg, parseNumberArg, parsePriceArg, parseSymbol, run } from './common.js';
import { presentFees, presentPosition } from './present.js';

initMode();

const ACTOR = 'user';

/** 執行管理操作並寫入稽核記錄；失敗也記錄。 */
function admin<T>(command: string, args: unknown, fn: (ctx: Ctx) => T): Promise<void> {
  return run(() => {
    const ctx = getCtx();
    try {
      const result = fn(ctx);
      audit(ctx.db, ACTOR, command, args, 'ok', ctx.clock);
      return result;
    } catch (e) {
      audit(ctx.db, ACTOR, command, args, `error: ${(e as Error).message}`, ctx.clock);
      throw e;
    }
  });
}

const equityOf = (ctx: Ctx) => valuate(ctx.db, ctx.quotes, ctx.config.symbols).equity;

/** 資金或持股異動：前後權益比例縮放回撤高點（規格第 6 節）。 */
function withPeakScaling<T>(ctx: Ctx, fn: (db: DB) => T): T {
  return ctx.db.transaction(() => {
    const before = equityOf(ctx);
    const result = fn(ctx.db);
    scalePeaksForFlow(ctx.db, before, equityOf(ctx), ctx.clock);
    return result;
  })();
}

const program = new Command('ctrade-admin')
  .description('Claude 交易系統管理 CLI（使用者與 Web UI 專用）')
  .addOption(new Option('--text', '輸出人類可讀格式'))
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

// ---------------------------------------------------------------- 資金與持股

program
  .command('allocate')
  .description('撥入資金給 Claude')
  .requiredOption('--amount <元>', '金額')
  .option('--note <text>', '備註')
  .action((opts: { amount: string; note?: string }) =>
    admin('allocate', opts, (ctx) => {
      const amount = parseIntArg('--amount', opts.amount);
      return withPeakScaling(ctx, (db) => allocate(db, amount, ACTOR, opts.note, ctx.clock));
    }),
  );

program
  .command('withdraw')
  .description('撥出資金，不可超過可用資金')
  .requiredOption('--amount <元>', '金額')
  .option('--note <text>', '備註')
  .action((opts: { amount: string; note?: string }) =>
    admin('withdraw', opts, (ctx) => {
      const amount = parseIntArg('--amount', opts.amount);
      return withPeakScaling(ctx, (db) => withdraw(db, amount, ACTOR, opts.note, ctx.clock));
    }),
  );

program
  .command('transfer-in <symbol>')
  .description('把使用者持股轉入 Claude 帳本')
  .requiredOption('--qty <股>', '股數')
  .option('--cost <價>', '每股成本；預設為前一交易日收盤價')
  .option('--note <text>', '備註')
  .action((symbol: string, opts: { qty: string; cost?: string; note?: string }) =>
    admin('transfer-in', { symbol, ...opts }, (ctx) => {
      const sym = parseSymbol(symbol);
      if (ctx.config.mode === 'live') {
        // 規格第 5 節：live 模式必須先向券商查詢實際持股。券商連線由 daemon 提供（第 3 階段）。
        throw new CtradeError(
          'BROKER_UNAVAILABLE',
          'live 模式轉入持股需要 daemon 向券商查詢實際持股，daemon 尚未實作',
          ExitCode.BROKER_ERROR,
        );
      }
      let cost: number;
      if (opts.cost !== undefined) cost = parsePriceArg(opts.cost);
      else {
        const prevClose = ctx.quotes.getQuote(sym)?.prev_close_x100;
        if (!prevClose) throw invalidArgs('COST_REQUIRED', `取不到 ${sym} 前一交易日收盤價，請以 --cost 指定每股成本`);
        cost = prevClose;
      }
      const qty = parseIntArg('--qty', opts.qty);
      return presentPosition(
        withPeakScaling(ctx, (db) =>
          transferIn(db, { symbol: sym, qty, costPerShareX100: cost, actor: ACTOR, note: opts.note }, ctx.clock),
        ),
      );
    }),
  );

program
  .command('transfer-out <symbol>')
  .description('把 Claude 持股轉回使用者')
  .requiredOption('--qty <股>', '股數')
  .option('--note <text>', '備註')
  .action((symbol: string, opts: { qty: string; note?: string }) =>
    admin('transfer-out', { symbol, ...opts }, (ctx) => {
      const qty = parseIntArg('--qty', opts.qty);
      return presentPosition(
        withPeakScaling(ctx, (db) =>
          transferOut(db, { symbol: parseSymbol(symbol), qty, actor: ACTOR, note: opts.note }, ctx.clock),
        ),
      );
    }),
  );

// ---------------------------------------------------------------- 暫停與恢復

program
  .command('pause')
  .description('暫停 Claude 交易')
  .option('--reason <text>', '原因', '使用者手動暫停')
  .action((opts: { reason: string }) =>
    admin('pause', opts, (ctx) => {
      pause(ctx.db, 'manual', opts.reason, ctx.clock);
      return getPause(ctx.db);
    }),
  );

program
  .command('resume')
  .description('恢復 Claude 交易；因跨日回撤暫停時必須加 --reset-peak')
  .option('--reset-peak', '以目前權益重設歷史權益高點')
  .action((opts: { resetPeak?: boolean }) =>
    admin('resume', opts, (ctx) => {
      resume(ctx.db, { resetPeak: !!opts.resetPeak, currentEquity: equityOf(ctx) }, ctx.clock);
      return getPause(ctx.db);
    }),
  );

// ---------------------------------------------------------------- Claude 狀態

const claude = program.command('claude').description('Claude 呼叫狀態');

claude
  .command('reset')
  .description('解除 claude_unavailable（呼叫失敗或用量預算用盡後），恢復叫醒 Claude')
  .action(() =>
    admin('claude reset', {}, (ctx) => {
      const before = getState(ctx.db, 'claude_unavailable');
      setState(ctx.db, 'claude_unavailable', null, ctx.clock);
      return { claude_unavailable: null, was: before };
    }),
  );

program
  .command('snapshot')
  .description('手動產生今日快照（daemon 在執行時以即時報價估值）')
  .action(() =>
    run(async () => {
      const ctx = getCtx();
      try {
        await loadQuotes(ctx, getPositions(ctx.db).map((p) => p.symbol));
      } catch {
        // daemon 未執行時以平均成本估值
      }
      new DailyJobs(ctx.db, ctx.config, ctx.root, ctx.clock, ctx.quotes, () => {}).snapshot();
      audit(ctx.db, ACTOR, 'snapshot', {}, 'ok', ctx.clock);
      return ctx.db.prepare('SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 1').get();
    }),
  );

// ---------------------------------------------------------------- 對帳

program
  .command('reconcile')
  .description('手動執行對帳（目前為帳本內部一致性檢查）')
  .action(() =>
    admin('reconcile', {}, (ctx) => {
      const diffs = checkLedgerConsistency(ctx.db);
      const status = recordReconciliation(ctx.db, diffs, ctx.clock);
      if (status === 'error') pause(ctx.db, 'reconciliation', '對帳出現差異', ctx.clock);
      return { status, diffs };
    }),
  );

// ---------------------------------------------------------------- 風控參數

const risk = program.command('risk').description('風控參數');

risk
  .command('show')
  .description('查看風控參數')
  .action(() => run(() => getRiskParams(getCtx().db)));

risk
  .command('set <assignments...>')
  .description('修改風控參數，例如 risk set max_order_amount=20000 symbols_allowlist=0050,00631L')
  .action((assignments: string[]) =>
    admin('risk set', assignments, (ctx) => {
      const current = getRiskParams(ctx.db);
      const patch: Record<string, unknown> = {};
      for (const a of assignments) {
        const eq = a.indexOf('=');
        if (eq <= 0) throw invalidArgs('INVALID_ARGS', `參數格式應為 key=value，收到 ${a}`);
        const key = a.slice(0, eq) as keyof RiskParams;
        const raw = a.slice(eq + 1);
        if (!(key in current)) throw invalidArgs('UNKNOWN_RISK_PARAM', `未知的風控參數 ${key}`);
        const prev = current[key];
        if (typeof prev === 'boolean') {
          if (raw !== 'true' && raw !== 'false') throw invalidArgs('INVALID_ARGS', `${key} 必須是 true 或 false`);
          patch[key] = raw === 'true';
        } else if (key === 'symbols_allowlist') {
          patch[key] = raw === '' ? [] : raw.split(',').map(parseSymbol);
        } else if (Array.isArray(prev)) {
          const parts = raw.split(',').map((v) => parseNumberArg(key, v));
          patch[key] = parts;
        } else {
          patch[key] = parseNumberArg(key, raw);
        }
      }
      return setRiskParams(ctx.db, patch as Partial<RiskParams>, ctx.clock);
    }),
  );

// ---------------------------------------------------------------- 費率

const fees = program.command('fees').description('費率與稅率');

fees
  .command('show')
  .description('查看目前與未來的費率版本')
  .action(() =>
    run(() => {
      const { db, clock } = getCtx();
      const today = twDate(clock.now());
      const upcoming = db.prepare('SELECT id FROM fee_schedules WHERE effective_date > ? ORDER BY effective_date').pluck().all(today);
      return {
        current: presentFees(getFeeSchedule(db, today)),
        upcoming: upcoming.map((id) =>
          presentFees(db.prepare('SELECT * FROM fee_schedules WHERE id = ?').get(id) as Parameters<typeof presentFees>[0]),
        ),
      };
    }),
  );

fees
  .command('set')
  .description('新增費率版本；未指定的欄位沿用目前版本')
  .requiredOption('--effective <YYYY-MM-DD>', '生效日，不可早於今天')
  .option('--fee-rate <pct>', '手續費率（%）')
  .option('--discount <ratio>', '手續費折扣，2.8 折填 0.28')
  .option('--rebate-mode <mode>', 'instant 或 monthly')
  .option('--min-fee-regular <元>', '整股最低手續費')
  .option('--min-fee-odd <元>', '零股最低手續費')
  .option('--tax-stock <pct>', '一般股票證交稅（%）')
  .option('--tax-daytrade <pct>', '現股當沖證交稅（%）')
  .option('--tax-etf <pct>', 'ETF 證交稅（%）')
  .action((opts: Record<string, string>) =>
    admin('fees set', opts, (ctx) => {
      const effective = opts.effective ?? '';
      const cur = presentFees(getFeeSchedule(ctx.db, effective));
      const num = (key: string, fallback: number) => (opts[key] !== undefined ? parseNumberArg(key, opts[key]) : fallback);
      const input: FeeScheduleInput = {
        fee_rate_pct: num('feeRate', cur.fee_rate_pct),
        fee_discount: num('discount', cur.fee_discount),
        rebate_mode: (opts.rebateMode ?? cur.rebate_mode) as FeeScheduleInput['rebate_mode'],
        min_fee_regular: num('minFeeRegular', cur.min_fee_regular),
        min_fee_odd: num('minFeeOdd', cur.min_fee_odd),
        tax_stock_pct: num('taxStock', cur.tax_stock_pct),
        tax_daytrade_pct: num('taxDaytrade', cur.tax_daytrade_pct),
        tax_etf_pct: num('taxEtf', cur.tax_etf_pct),
      };
      return presentFees(addFeeSchedule(ctx.db, input, effective, ctx.clock));
    }),
  );

// ---------------------------------------------------------------- 休市

const holiday = program.command('holiday').description('休市日');

holiday
  .command('add <date>')
  .description('標記臨時休市（例如颱風停市）')
  .option('--reason <text>', '原因')
  .action((date: string, opts: { reason?: string }) =>
    admin('holiday add', { date, ...opts }, (ctx) => {
      if (!isValidDate(date)) throw invalidArgs('INVALID_DATE', `日期 ${date} 格式錯誤，須為 YYYY-MM-DD`);
      addHoliday(ctx.db, date, opts.reason ?? null);
      return { date, reason: opts.reason ?? null };
    }),
  );

program
  .command('positions')
  .description('Claude 帳本持股（含已出清但有殘值者）')
  .action(() => run(() => getPositions(getCtx().db).map(presentPosition)));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = e as { code?: string };
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exitCode = 0;
  else await run(() => {
    throw e;
  });
}
