#!/usr/bin/env node
/**
 * ctrade-admin：只給使用者與 Web UI 使用的管理 CLI（規格第 5 節）。
 * Claude Code 的權限設定不開放這個執行檔。所有寫入都經過 core/admin.ts，與 Web UI 共用驗證邏輯，
 * 並寫入 audit_log。
 */
import { Command, Option } from 'commander';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type AdminContext,
  activateCurrentStrategy,
  addFeeVersion,
  allocateFunds,
  cancelAllOrders,
  flattenAll,
  markHoliday,
  pauseTrading,
  quotesFromDaemon,
  resetClaude,
  resolveReconciliation,
  resumeTrading,
  runAdmin,
  runReconciliation,
  setUsageBudget,
  transferSharesIn,
  transferSharesOut,
  updateRiskParams,
  usageBudget,
  withdrawFunds,
} from '../core/admin.js';
import type { RiskParams } from '../core/config.js';
import { CtradeError, ExitCode, invalidArgs } from '../core/errors.js';
import { getPositions } from '../core/ledger.js';
import {
  SECRET_PROFILES,
  isSimulationUrl,
  keyringStore,
  mask,
  maskedCredentials,
  parseProfile,
  readEsunIni,
  requireCredentials,
  resolveMarketCredentials,
} from '../core/secrets.js';
import { getFeeSchedule, getRiskParams } from '../core/settings.js';
import { checkStrategyFiles, currentStrategy, listStrategies } from '../core/strategy.js';
import { twDate } from '../core/time.js';
import { DailyJobs } from '../daemon/daily.js';
import { EsunMarketDataApi, EsunTradeApi } from '../daemon/esun/api.js';
import { type Ctx, daemonPath, getCtx, initMode, parseIntArg, parseNumberArg, parsePriceArg, parseSymbol, run } from './common.js';
import { presentFees, presentPosition } from './present.js';
import { promptHidden } from './prompt.js';

initMode();

/** 管理操作的共用環境；needQuotes 時向 daemon 取報價（未執行則以平均成本估值）。 */
async function adminCtx(ctx: Ctx, needQuotes = false, extraSymbols: string[] = []): Promise<AdminContext> {
  const ipcPath = daemonPath(ctx);
  const quotes = needQuotes
    ? await quotesFromDaemon(ipcPath, [...extraSymbols, ...getPositions(ctx.db).map((p) => p.symbol)])
    : ctx.quotes;
  return { db: ctx.db, config: ctx.config, root: ctx.root, clock: ctx.clock, quotes, ipcPath, actor: 'user' };
}

/** 不經過 core/admin 的操作（金鑰、連線檢查）也寫入稽核記錄。 */
const audited = <T>(command: string, args: unknown, fn: () => T | Promise<T>) =>
  run(async () => runAdmin(await adminCtx(getCtx()), command, args, fn));

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
    run(async () => allocateFunds(await adminCtx(getCtx(), true), { amount: parseIntArg('--amount', opts.amount), note: opts.note })),
  );

program
  .command('withdraw')
  .description('撥出資金，不可超過可用資金')
  .requiredOption('--amount <元>', '金額')
  .option('--note <text>', '備註')
  .action((opts: { amount: string; note?: string }) =>
    run(async () => withdrawFunds(await adminCtx(getCtx(), true), { amount: parseIntArg('--amount', opts.amount), note: opts.note })),
  );

program
  .command('transfer-in <symbol>')
  .description('把使用者持股轉入 Claude 帳本')
  .requiredOption('--qty <股>', '股數')
  .option('--cost <價>', '每股成本；預設為前一交易日收盤價')
  .option('--note <text>', '備註')
  .action((symbol: string, opts: { qty: string; cost?: string; note?: string }) =>
    run(async () => {
      const sym = parseSymbol(symbol);
      const actx = await adminCtx(getCtx(), true, [sym]);
      return presentPosition(
        await transferSharesIn(actx, {
          symbol: sym,
          qty: parseIntArg('--qty', opts.qty),
          costPerShareX100: opts.cost !== undefined ? parsePriceArg(opts.cost) : undefined,
          note: opts.note,
        }),
      );
    }),
  );

program
  .command('transfer-out <symbol>')
  .description('把 Claude 持股轉回使用者')
  .requiredOption('--qty <股>', '股數')
  .option('--note <text>', '備註')
  .action((symbol: string, opts: { qty: string; note?: string }) =>
    run(async () =>
      presentPosition(
        await transferSharesOut(await adminCtx(getCtx(), true), {
          symbol: parseSymbol(symbol),
          qty: parseIntArg('--qty', opts.qty),
          note: opts.note,
        }),
      ),
    ),
  );

// ---------------------------------------------------------------- 暫停、恢復與緊急操作

program
  .command('pause')
  .description('暫停 Claude 交易')
  .option('--reason <text>', '原因', '使用者手動暫停')
  .action((opts: { reason: string }) => run(async () => pauseTrading(await adminCtx(getCtx()), opts)));

program
  .command('resume')
  .description('恢復 Claude 交易；因跨日回撤暫停時必須加 --reset-peak')
  .option('--reset-peak', '以目前權益重設歷史權益高點')
  .action((opts: { resetPeak?: boolean }) => run(async () => resumeTrading(await adminCtx(getCtx(), true), opts)));

program
  .command('cancel-all')
  .description('緊急操作：刪除所有未完成委託並暫停（經 daemon 送出，規格第 18 節）')
  .action(() => run(async () => cancelAllOrders(await adminCtx(getCtx()))));

program
  .command('flatten')
  .description('緊急操作：刪除未完成委託後以對手價賣出全部持股並暫停（經 daemon 送出，規格第 18 節）')
  .action(() => run(async () => flattenAll(await adminCtx(getCtx()))));

// ---------------------------------------------------------------- 策略版本

const strategy = program.command('strategy').description('策略版本（規格第 10 節）');

strategy
  .command('activate')
  .description('把目前 commit 的策略 skill 記錄為生效版本；策略檔有未 commit 的修改時拒絕')
  .option('--note <text>', '備註，例如核准原因')
  .action((opts: { note?: string }) => run(async () => activateCurrentStrategy(await adminCtx(getCtx()), opts)));

strategy
  .command('show')
  .description('目前生效的策略版本與歷史，以及專案目錄的策略檔是否與生效版本一致')
  .action(() =>
    run(() => {
      const c = getCtx();
      const current = currentStrategy(c.db) ?? null;
      return { current, files_match: checkStrategyFiles(c.root, current?.version ?? null), history: listStrategies(c.db) };
    }),
  );

// ---------------------------------------------------------------- 玉山金鑰與連線檢查

const secrets = program.command('secrets').description('玉山 API 金鑰（存放在作業系統的金鑰管理）');

secrets
  .command('import <profile>')
  .description('從玉山金鑰網站下載的設定檔匯入金鑰，密碼以隱藏輸入（profile：esun-sim、esun-live、esun-marketdata）')
  .requiredOption('--ini <path>', '玉山金鑰設定檔（.ini），讀取後不需保留在專案內')
  .option('--cert <path>', '.p12 憑證檔的絕對路徑；未指定時使用設定檔中的路徑')
  .action((profileArg: string, opts: { ini: string; cert?: string }) =>
    audited('secrets import', { profile: profileArg }, async () => {
      const profile = parseProfile(profileArg);
      const ini = readEsunIni(resolve(opts.ini));
      const sim = isSimulationUrl(ini.apiUrl) || ini.environment?.toUpperCase() === 'SIMULATION';
      if (profile === 'esun-sim' && !sim) {
        throw invalidArgs(
          'PROFILE_MISMATCH',
          '這份設定檔是正式環境，不能匯入為 esun-sim。paper 模式不需要 esun-sim：它使用真實行情（esun-marketdata，沒有時改用 esun-live）加本地模擬撮合，不會送出委託。esun-sim 只用於以玉山模擬金鑰測試下單串接',
        );
      }
      if (profile === 'esun-live' && sim) throw invalidArgs('PROFILE_MISMATCH', '這份設定檔是模擬環境，不能匯入為 esun-live');

      const certRaw = opts.cert ?? ini.certPath;
      if (!certRaw) throw invalidArgs('CERT_REQUIRED', '設定檔沒有憑證路徑，請以 --cert 指定 .p12 檔');
      // 相對路徑以設定檔所在目錄解析（SDK 會以目前工作目錄解析，容易指錯）
      const certPath = isAbsolute(certRaw) ? certRaw : resolve(dirname(resolve(opts.ini)), certRaw);
      const root = getCtx().root;
      if (!relative(root, certPath).startsWith('..')) {
        throw invalidArgs('CERT_IN_PROJECT', '憑證檔不可放在專案目錄內（規格第 12 節），請移到專案外再匯入');
      }

      const password = await promptHidden('玉山證券登入密碼：');
      const certPass = await promptHidden('憑證密碼：');
      const creds = { ...ini, password, certPass, certPath };
      delete (creds as { environment?: string }).environment;
      await keyringStore.set(profile, creds);
      return { profile, stored: maskedCredentials(creds) };
    }),
  );

secrets
  .command('show [profile]')
  .description('顯示已匯入的金鑰（遮罩）')
  .action((profileArg?: string) =>
    run(async () => {
      const profiles = profileArg ? [parseProfile(profileArg)] : [...SECRET_PROFILES];
      const out: Record<string, unknown> = {};
      for (const p of profiles) {
        const c = await keyringStore.get(p);
        out[p] = c ? maskedCredentials(c) : null;
      }
      return out;
    }),
  );

secrets
  .command('delete <profile>')
  .description('從金鑰管理刪除一組金鑰')
  .action((profileArg: string) =>
    audited('secrets delete', { profile: profileArg }, async () => ({
      profile: profileArg,
      deleted: await keyringStore.delete(parseProfile(profileArg)),
    })),
  );

const broker = program.command('broker').description('玉山交易 API');

broker
  .command('check')
  .description('登入並執行唯讀查詢：金鑰、憑證、交易權限、市場狀態、主機時間、庫存（第 1 階段驗收）')
  .option('--profile <profile>', 'esun-sim 或 esun-live', 'esun-live')
  .action((opts: { profile: string }) =>
    audited('broker check', opts, async () => {
      const profile = parseProfile(opts.profile);
      if (profile === 'esun-marketdata') throw invalidArgs('INVALID_PROFILE', '行情金鑰請用 ctrade-admin market check');
      const api = new EsunTradeApi(await requireCredentials(keyringStore, profile));
      await api.login();
      const diagnostics = await api.diagnostics();
      let holdings: unknown;
      try {
        holdings = (await api.getHoldings()).map((h) => ({ symbol: h.symbol, qty: h.qty }));
      } catch (e) {
        holdings = { error: (e as Error).message };
      }
      const keyInfo = diagnostics.key_info as Record<string, unknown> | undefined;
      if (keyInfo && typeof keyInfo.apiKey === 'string') keyInfo.apiKey = mask(keyInfo.apiKey);
      // 憑證名稱含身分證字號（例如 A123456789-00-00::PCC005），只顯示遮罩後的值
      const certInfo = diagnostics.cert_info as Record<string, unknown> | undefined;
      if (certInfo && typeof certInfo.cn === 'string') certInfo.cn = mask(certInfo.cn, 2);
      if (certInfo && typeof certInfo.serial === 'string') certInfo.serial = mask(certInfo.serial, 2);
      return { profile, login: 'ok', ...diagnostics, holdings };
    }),
  );

const market = program.command('market').description('玉山行情 API');

market
  .command('check')
  .description('登入行情並取得一檔標的的參考價、漲跌停與報價（使用 esun-marketdata，沒有時改用 esun-live）')
  .option('--symbol <symbol>', '代號', '0050')
  .action((opts: { symbol: string }) =>
    audited('market check', opts, async () => {
      const md = await resolveMarketCredentials(keyringStore);
      if (!md) {
        throw new CtradeError(
          'CREDENTIALS_MISSING',
          '金鑰管理中沒有 esun-marketdata 或 esun-live，請先以 ctrade-admin secrets import 匯入金鑰',
          ExitCode.BROKER_ERROR,
        );
      }
      const api = new EsunMarketDataApi(md.creds);
      await api.login();
      const symbol = parseSymbol(opts.symbol);
      const t = await api.ticker(symbol);
      const q = await api.quote(symbol, false);
      return {
        credentials: md.profile,
        login: 'ok',
        ticker: {
          date: t.date,
          name: t.name,
          reference: t.referencePrice,
          limit_up: t.limitUpPrice,
          limit_down: t.limitDownPrice,
          board_lot: t.boardLot,
          status: t.securityStatus,
        },
        quote: { last: q.lastPrice ?? q.closePrice, bid: q.bids?.[0], ask: q.asks?.[0], updated: q.lastUpdated },
      };
    }),
  );

// ---------------------------------------------------------------- Claude 狀態與用量預算

const claude = program.command('claude').description('Claude 呼叫狀態');

claude
  .command('reset')
  .description('解除 claude_unavailable（呼叫失敗或用量預算用盡後），恢復叫醒 Claude')
  .action(() => run(async () => resetClaude(await adminCtx(getCtx()))));

const usage = program.command('usage').description('Claude 用量預算');

usage
  .command('budget')
  .description('查看或設定每日與每週的 token 預算（覆寫設定檔）')
  .option('--daily <tokens>', '每日預算')
  .option('--weekly <tokens>', '每週預算')
  .action((opts: { daily?: string; weekly?: string }) =>
    run(async () => {
      const ctx = getCtx();
      const cur = usageBudget(ctx.db, ctx.config);
      if (opts.daily === undefined && opts.weekly === undefined) return cur;
      return setUsageBudget(await adminCtx(ctx), {
        daily_budget_tokens: opts.daily !== undefined ? parseIntArg('--daily', opts.daily) : cur.daily_budget_tokens,
        weekly_budget_tokens: opts.weekly !== undefined ? parseIntArg('--weekly', opts.weekly) : cur.weekly_budget_tokens,
      });
    }),
  );

program
  .command('snapshot')
  .description('手動產生今日快照（daemon 在執行時以即時報價估值）')
  .action(() =>
    run(async () => {
      const actx = await adminCtx(getCtx(), true);
      return runAdmin(actx, 'snapshot', {}, () => {
        new DailyJobs(actx.db, actx.config, actx.root, actx.clock, actx.quotes, () => {}).snapshot();
        return actx.db.prepare('SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 1').get();
      });
    }),
  );

// ---------------------------------------------------------------- 對帳

const reconcile = program.command('reconcile').description('對帳（目前為帳本內部一致性檢查）');

reconcile
  .command('run', { isDefault: true })
  .description('手動執行對帳；出現差異時暫停')
  .action(() => run(async () => runReconciliation(await adminCtx(getCtx()))));

reconcile
  .command('resolve <id>')
  .description('標記一筆對帳差異已處理')
  .requiredOption('--note <text>', '處理說明')
  .action((id: string, opts: { note: string }) =>
    run(async () => resolveReconciliation(await adminCtx(getCtx()), { id: parseIntArg('id', id), note: opts.note })),
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
    run(async () => {
      const ctx = getCtx();
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
          patch[key] = raw.split(',').map((v) => parseNumberArg(key, v));
        } else {
          patch[key] = parseNumberArg(key, raw);
        }
      }
      return updateRiskParams(await adminCtx(ctx), patch as Partial<RiskParams>);
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
    run(async () => {
      const num = (key: string) => (opts[key] !== undefined ? parseNumberArg(key, opts[key]!) : undefined);
      const rebate = opts.rebateMode;
      if (rebate !== undefined && rebate !== 'instant' && rebate !== 'monthly') {
        throw invalidArgs('INVALID_ARGS', '--rebate-mode 必須是 instant 或 monthly');
      }
      return presentFees(
        await addFeeVersion(await adminCtx(getCtx()), {
          effective: opts.effective ?? '',
          fee_rate_pct: num('feeRate'),
          fee_discount: num('discount'),
          rebate_mode: rebate as 'instant' | 'monthly' | undefined,
          min_fee_regular: num('minFeeRegular'),
          min_fee_odd: num('minFeeOdd'),
          tax_stock_pct: num('taxStock'),
          tax_daytrade_pct: num('taxDaytrade'),
          tax_etf_pct: num('taxEtf'),
        }),
      );
    }),
  );

// ---------------------------------------------------------------- 休市

const holiday = program.command('holiday').description('休市日');

holiday
  .command('add <date>')
  .description('標記臨時休市（例如颱風停市）')
  .option('--reason <text>', '原因')
  .action((date: string, opts: { reason?: string }) => run(async () => markHoliday(await adminCtx(getCtx()), { date, reason: opts.reason })));

program
  .command('positions')
  .description('Claude 帳本持股（含已出清但有殘值者）')
  .action(() => run(() => getPositions(getCtx().db).map(presentPosition)));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = e as { code?: string };
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exitCode = 0;
  else
    await run(() => {
      throw e;
    });
}
