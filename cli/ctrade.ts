#!/usr/bin/env node
/**
 * ctrade：給 Claude 使用的 CLI（規格第 5 節）。
 *
 * 不提供 --mode 之類的參數，模式只由設定檔決定。
 * CTRADE_READONLY=1（復盤模式）時拒絕所有會改變交易狀態的指令。
 */
import { Command, Option } from 'commander';
import { addJournal, getStops, getTriggerConfig, setStop, setTriggerConfig, type TriggerPatch } from '../core/claude-ops.js';
import type { Session } from '../core/config.js';
import { CtradeError, ExitCode, invalidArgs } from '../core/errors.js';
import { call } from '../core/ipc.js';
import { getBalance, getPositions } from '../core/ledger.js';
import { contextReport, refreshMin } from '../core/market-context.js';
import type { QuoteDetail } from '../core/marketdata.js';
import { type OrderRow, createOrder, listFills, listOrders, markRejected, requestCancelByClaude } from '../core/orders.js';
import { getFeeSchedule, getMarketRules, getRiskParams } from '../core/settings.js';
import { proposalEligibility, reviewData, submitReview } from '../core/review.js';
import { buildStatus } from '../core/status.js';
import { addDays, isValidDate, toTwIso, twDate } from '../core/time.js';
import { DEFAULT_SMA_PERIODS, INDICATOR_FIELDS, INDICATOR_NOTES, indicatorsReport } from '../core/indicator-catalog.js';
import { type Bar as IndicatorBar, dailyIndicators, intradayIndicators } from '../core/indicators.js';
import { daemonPath, getCtx, initMode, loadQuotes, parseIntArg, parseNumberArg, parsePriceArg, parseSymbol, run } from './common.js';
import {
  presentFees,
  presentFill,
  presentOrder,
  presentPosition,
  presentQuoteDetail,
  presentStop,
  presentTrigger,
} from './present.js';

initMode();

function requireWritable(command: string): void {
  if (process.env.CTRADE_READONLY === '1') {
    throw new CtradeError('READONLY', `目前為唯讀模式（復盤），不允許 ${command}`, ExitCode.RISK_REJECTED);
  }
}

function dateArg(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!isValidDate(v)) throw invalidArgs('INVALID_DATE', `日期 ${v} 格式錯誤，須為 YYYY-MM-DD`);
  return v;
}

const program = new Command('ctrade')
  .description('Claude 交易 CLI：查詢帳本、行情與下單')
  .addOption(new Option('--text', '輸出人類可讀格式'))
  .exitOverride()
  .configureOutput({ writeErr: () => {} });

program
  .command('status')
  .description('模式、暫停狀態、交易時段、資金、持倉摘要、今日委託與用量')
  .action(() =>
    run(async () => {
      const c = getCtx();
      const { db, config, clock } = c;
      // daemon 在執行時以即時報價估值；否則以平均成本估值並在 valued_at_cost 標示
      let daemon: 'running' | 'unavailable' = 'running';
      try {
        await loadQuotes(c, getPositions(db).map((p) => p.symbol));
      } catch {
        daemon = 'unavailable';
      }
      return { daemon, ...buildStatus(db, config, clock, c.quotes) };
    }),
  );

program
  .command('balance')
  .description('現金餘額、圈存金額、可用資金')
  .action(() => run(() => getBalance(getCtx().db)));

program
  .command('positions')
  .description('各持股的股數、可賣股數、平均成本')
  .action(() => run(() => getPositions(getCtx().db).map(presentPosition)));

program
  .command('orders')
  .description('委託列表')
  .option('--open', '只列未完成委託')
  .option('--date <YYYY-MM-DD>', '委託日期')
  .action((opts: { open?: boolean; date?: string }) =>
    run(() => listOrders(getCtx().db, { open: opts.open, date: dateArg(opts.date) }).map(presentOrder)),
  );

program
  .command('fills')
  .description('成交列表')
  .option('--date <YYYY-MM-DD>', '成交日期')
  .action((opts: { date?: string }) => run(() => listFills(getCtx().db, { date: dateArg(opts.date) }).map(presentFill)));

program
  .command('fees')
  .description('目前適用的費率、稅率與市場規則（唯讀）')
  .action(() =>
    run(() => {
      const { db, clock } = getCtx();
      const today = twDate(clock.now());
      const rules = getMarketRules(db, today);
      return { fees: presentFees(getFeeSchedule(db, today)), market_rules: rules };
    }),
  );

program
  .command('history')
  .description('每日快照、已實現損益')
  .option('--days <n>', '天數', '20')
  .action((opts: { days: string }) =>
    run(() => {
      const days = parseIntArg('--days', opts.days);
      return getCtx().db.prepare('SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT ?').all(days);
    }),
  );

// ---------------------------------------------------------------- 行情

program
  .command('quote <symbols...>')
  .description('即時報價，含漲跌停價與該價位的升降單位')
  .action((symbols: string[]) =>
    run(async () => {
      const c = getCtx();
      const list = symbols.map(parseSymbol);
      const details = await call<QuoteDetail[]>(daemonPath(c), 'quote_detail', { symbols: list }, 5_000);
      const rules = getMarketRules(c.db, twDate(c.clock.now()));
      return details.map((d) => presentQuoteDetail(d, c.config.symbols[d.symbol]?.category ?? 'stock', rules));
    }),
  );

program
  .command('candles <symbol>')
  .description('K 線資料')
  .option('--interval <interval>', 'K 線週期，例如 1m、5m、D', '5m')
  .option('--count <n>', '根數', '60')
  .action((symbol: string, opts: { interval: string; count: string }) =>
    run(async () => {
      const c = getCtx();
      return call(daemonPath(c), 'candles', {
        symbol: parseSymbol(symbol),
        interval: opts.interval,
        count: parseIntArg('--count', opts.count),
      });
    }),
  );

program
  .command('global')
  .description('隔夜國際行情：美股指數與台積電 ADR、台指期夜盤、美元兌新台幣（daemon 定時抓取，標示資料時間、來源與是否過期）')
  .action(() =>
    run(() => {
      const { db, config, clock } = getCtx();
      return { now: toTwIso(clock.now()), ...contextReport(db, clock, refreshMin(config)) };
    }),
  );

// ---------------------------------------------------------------- 技術指標

program
  .command('indicators [symbol]')
  .description('技術指標：日線均線（不含今天、昨日、含今天）、RSI、ATR、近 20 日高低，盤中 VWAP、偏離、日高低、止跌 K 線與量比')
  .option('--sma <periods>', '日線均線週期，逗號分隔', DEFAULT_SMA_PERIODS.join(','))
  .option('--list', '列出所有欄位的定義與單位（不需要代號，也不需要 daemon）')
  .action((symbolArg: string | undefined, opts: { sma: string; list?: boolean }) =>
    run(async () => {
      if (opts.list) return { default_sma_periods: DEFAULT_SMA_PERIODS, fields: INDICATOR_FIELDS, notes: INDICATOR_NOTES };
      if (!symbolArg) throw invalidArgs('INVALID_ARGS', '請指定代號，例如 ctrade indicators 0050；ctrade indicators --list 列出欄位');
      const c = getCtx();
      const symbol = parseSymbol(symbolArg);
      const periods = opts.sma.split(',').map((v) => parseIntArg('--sma', v));
      if (periods.some((n) => n < 2 || n > 240)) throw invalidArgs('INVALID_ARGS', '--sma 週期須介於 2 至 240');
      const now = c.clock.now();
      const today = twDate(now);
      const path = daemonPath(c);
      await loadQuotes(c, [symbol]);
      const last = c.quotes.getQuote(symbol)?.last_x100;
      const lastPrice = last === undefined ? null : last / 100;

      // 日 K：取足夠計算最長週期的「昨日」均線；5 分 K：今天，以及近 20 個交易日（約 40 個日曆日）
      const maxN = Math.max(...periods, 20);
      const [daily, todayBars, pastBars] = await Promise.all([
        call<IndicatorBar[]>(path, 'bars', { symbol, interval: 'D', from: addDays(today, -Math.ceil(maxN * 1.6) - 30), to: addDays(today, -1) }, 30_000),
        call<IndicatorBar[]>(path, 'bars', { symbol, interval: '5m', from: today, to: today }, 30_000),
        call<IndicatorBar[]>(path, 'bars', { symbol, interval: '5m', from: addDays(today, -40), to: addDays(today, -1) }, 30_000),
      ]);
      return indicatorsReport(symbol, toTwIso(now), lastPrice, dailyIndicators(daily, lastPrice, periods), intradayIndicators(todayBars, pastBars, lastPrice, now));
    }),
  );

// ---------------------------------------------------------------- 委託

const SESSION_CHOICES = ['regular', 'odd_intraday', 'odd_after'];

async function placeOrder(side: 'buy' | 'sell', symbolArg: string, opts: { qty: string; price: string; session: Session }) {
  requireWritable('下單');
  const c = getCtx();
  const symbol = parseSymbol(symbolArg);
  const req = {
    symbol,
    side,
    session: opts.session,
    priceX100: parsePriceArg(opts.price),
    qty: parseIntArg('--qty', opts.qty),
    origin: 'claude' as const,
  };

  // 估值與曝險需要所有持股與掛單標的的報價；連不上 daemon 時在寫入委託前就結束（結束碼 4）
  const held = getPositions(c.db).filter((p) => p.qty > 0).map((p) => p.symbol);
  const pending = listOrders(c.db, { open: true }).map((o) => o.symbol);
  await loadQuotes(c, [symbol, ...held, ...pending]);

  const order = createOrder(c.db, req, c, { strategyVersion: process.env.CTRADE_STRATEGY_VERSION });
  try {
    const r = await call<{ order: OrderRow; fills: Record<string, unknown>[] }>(
      daemonPath(c),
      'submit',
      { orderId: order.id },
      30_000,
    );
    return { order: presentOrder(r.order), fills: r.fills.map(presentFill), balance: getBalance(c.db) };
  } catch (e) {
    if (e instanceof CtradeError && e.code === 'DAEMON_UNAVAILABLE') {
      // 確定沒有送到 daemon：取消這筆委託並釋放圈存
      markRejected(c.db, order.id, 'daemon 無法連線，委託未送出', c.clock);
    } else if (e instanceof CtradeError && (e.code === 'DAEMON_TIMEOUT' || e.code === 'DAEMON_DISCONNECTED')) {
      throw new CtradeError(
        e.code,
        `${e.message}。委託編號 ${order.id} 的狀態由 daemon 確認，請稍後以 ctrade orders --open 查詢，不要重複下單`,
        e.exitCode,
        { order_id: order.id },
      );
    }
    throw e;
  }
}

const order = program.command('order').description('下單與刪單（只接受限價單）');

for (const side of ['buy', 'sell'] as const) {
  order
    .command(`${side} <symbol>`)
    .description(side === 'buy' ? '限價買進' : '限價賣出')
    .requiredOption('--qty <股>', '股數；整股須為 1000 的倍數，零股 1–999')
    .requiredOption('--price <價>', '限價')
    .addOption(new Option('--session <時段>', '盤別').choices(SESSION_CHOICES).makeOptionMandatory())
    .action((symbol: string, opts: { qty: string; price: string; session: Session }) =>
      run(() => placeOrder(side, symbol, opts)),
    );
}

order
  .command('cancel <orderId>')
  .description('刪單')
  .action((idArg: string) =>
    run(async () => {
      requireWritable('刪單');
      const c = getCtx();
      const id = parseIntArg('orderId', idArg);
      await call(daemonPath(c), 'ping', {}, 3_000);
      requestCancelByClaude(c.db, id, c.clock);
      const r = await call<{ order: OrderRow; fills: Record<string, unknown>[] }>(daemonPath(c), 'cancel', { orderId: id }, 30_000);
      return { order: presentOrder(r.order), fills: r.fills.map(presentFill), balance: getBalance(c.db) };
    }),
  );

// ---------------------------------------------------------------- 復盤

program
  .command('review-data')
  .description('復盤用的當日完整資料：觸發、決策、委託、成交、損益，以及能否提出策略修改')
  .option('--date <YYYY-MM-DD>', '日期，預設今天')
  .action((opts: { date?: string }) =>
    run(() => {
      const { db, config, clock } = getCtx();
      const date = dateArg(opts.date) ?? twDate(clock.now());
      return { ...reviewData(db, date), proposal: proposalEligibility(db, config, clock) };
    }),
  );

const review = program.command('review').description('復盤記錄');

review
  .command('submit')
  .description('把復盤筆記寫入資料庫；附 --proposal-branch 時為策略修改提案（唯讀模式也可使用）')
  .requiredOption('--date <YYYY-MM-DD>', '復盤日期')
  .requiredOption('--file <path>', 'reviews/ 目錄下的筆記檔')
  .option('--proposal-branch <branch>', '策略修改分支 strategy/YYYY-MM-DD')
  .action((opts: { date: string; file: string; proposalBranch?: string }) =>
    run(() => {
      const { db, config, clock, root } = getCtx();
      return submitReview(
        db,
        config,
        { date: dateArg(opts.date)!, file: opts.file, proposalBranch: opts.proposalBranch, allowedRoots: [root, process.cwd()] },
        clock,
      );
    }),
  );

// ---------------------------------------------------------------- 觸發條件

const trigger = program.command('trigger').description('觸發條件');

trigger
  .command('show')
  .description('目前觸發條件與允許範圍')
  .action(() =>
    run(() => {
      const { db } = getCtx();
      const risk = getRiskParams(db);
      return {
        current: presentTrigger(getTriggerConfig(db)),
        allowed: {
          interval_min: risk.trigger_interval_min_range,
          up_pct: risk.trigger_up_pct_range,
          down_pct: risk.trigger_down_pct_range,
          note: '可用 --interval off 或 --price off 關閉，但不能兩者都關；有持股時不能關閉價格觸發',
        },
      };
    }),
  );

trigger
  .command('set')
  .description('設定下一輪觸發條件')
  .option('--interval <分|off>', '定時觸發間隔（分鐘），off 關閉')
  .option('--up <pct>', '價格觸發漲幅（%）')
  .option('--down <pct>', '價格觸發跌幅（%）')
  .option('--price <off>', '關閉價格觸發')
  .action((opts: { interval?: string; up?: string; down?: string; price?: string }) =>
    run(() => {
      requireWritable('trigger set');
      const patch: TriggerPatch = {};
      if (opts.interval !== undefined) {
        patch.interval_min = opts.interval === 'off' ? null : parseIntArg('--interval', opts.interval);
      }
      if (opts.price !== undefined) {
        if (opts.price !== 'off') throw invalidArgs('INVALID_ARGS', '--price 只接受 off');
        if (opts.up !== undefined || opts.down !== undefined) throw invalidArgs('INVALID_ARGS', '--price off 不能與 --up、--down 同時使用');
        patch.price = null;
      } else if (opts.up !== undefined || opts.down !== undefined) {
        if (opts.up === undefined || opts.down === undefined) throw invalidArgs('INVALID_ARGS', '--up 與 --down 必須一起指定');
        patch.price = { up_pct: parseNumberArg('--up', opts.up), down_pct: parseNumberArg('--down', opts.down) };
      }
      if (patch.interval_min === undefined && patch.price === undefined) {
        throw invalidArgs('INVALID_ARGS', '至少要指定 --interval、--up/--down 或 --price off');
      }
      const { db, clock } = getCtx();
      return presentTrigger(setTriggerConfig(db, patch, 'claude', clock));
    }),
  );

// ---------------------------------------------------------------- 決策記錄

const journal = program.command('journal').description('決策記錄');

journal
  .command('add')
  .description('寫入本次決策記錄，每次觸發結束前必須呼叫')
  .requiredOption('--reasoning <text>', '決策理由')
  .requiredOption('--actions <text>', '採取的動作摘要，沒有動作時寫「不動作」')
  .option('--trigger-event <id>', '觸發事件編號（daemon 會以 CTRADE_TRIGGER_EVENT_ID 提供）')
  .action((opts: { reasoning: string; actions: string; triggerEvent?: string }) =>
    run(() => {
      const { db, clock } = getCtx();
      const triggerRaw = opts.triggerEvent ?? process.env.CTRADE_TRIGGER_EVENT_ID;
      const id = addJournal(
        db,
        {
          reasoning: opts.reasoning,
          actions: opts.actions,
          triggerEventId: triggerRaw ? parseIntArg('--trigger-event', triggerRaw) : undefined,
          model: process.env.CTRADE_MODEL,
          strategyVersion: process.env.CTRADE_STRATEGY_VERSION,
        },
        clock,
      );
      return { decision_id: id };
    }),
  );

// ---------------------------------------------------------------- 硬停損停利

const stop = program.command('stop').description('硬停損停利價（daemon 觸價直接賣出）');

stop
  .command('show')
  .description('各持股的硬停損價與硬停利價')
  .action(() => run(() => getStops(getCtx().db).map(presentStop)));

stop
  .command('set <symbol>')
  .description('設定硬停損停利價；停損價只能上調')
  .option('--stop <price>', '停損價')
  .option('--take-profit <price>', '停利價')
  .option('--reason <text>', '理由')
  .action((symbol: string, opts: { stop?: string; takeProfit?: string; reason?: string }) =>
    run(() => {
      requireWritable('stop set');
      const { db, clock } = getCtx();
      return presentStop(
        setStop(
          db,
          {
            symbol: parseSymbol(symbol),
            stopX100: opts.stop !== undefined ? parsePriceArg(opts.stop) : undefined,
            takeProfitX100: opts.takeProfit !== undefined ? parsePriceArg(opts.takeProfit) : undefined,
            actor: 'claude',
            reason: opts.reason,
          },
          clock,
        ),
      );
    }),
  );

try {
  await program.parseAsync(process.argv);
} catch (e) {
  // commander 的 --help、--version 也會走到這裡，exitCode 為 0 時不視為錯誤
  const err = e as { exitCode?: number; code?: string };
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exitCode = 0;
  else await run(() => {
    throw e;
  });
}
