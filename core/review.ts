import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { invalidArgs, riskRejected } from './errors.js';
import { getPause, getState } from './state.js';
import { type Clock, toTwIso, twDate } from './time.js';

/**
 * 收盤復盤（規格第 10 節）：讀取當日資料、寫入復盤記錄、判斷能否提出策略修改。
 */

export function reviewData(db: DB, date: string) {
  const like = `${date}%`;
  return {
    date,
    snapshot: db.prepare('SELECT * FROM daily_snapshots WHERE date = ?').get(date) ?? null,
    triggers: db.prepare('SELECT id, ts, kind, detail_json, invoked_claude, skip_reason FROM trigger_events WHERE ts LIKE ? ORDER BY id').all(like),
    decisions: db
      .prepare('SELECT id, trigger_event_id, ts, model, reasoning, actions_json, strategy_version FROM decisions WHERE ts LIKE ? ORDER BY id')
      .all(like),
    orders: db.prepare('SELECT * FROM orders WHERE created_at LIKE ? ORDER BY id').all(like),
    fills: db
      .prepare(
        `SELECT f.*, o.symbol, o.side, o.session, o.origin FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.ts LIKE ? ORDER BY f.ts`,
      )
      .all(like),
    risk_events: db.prepare('SELECT ts, rule, detail_json, action FROM risk_events WHERE ts LIKE ? ORDER BY id').all(like),
    usage: db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM usage_log WHERE ts LIKE ?`,
      )
      .get(like),
  };
}

export interface ProposalEligibility {
  eligible: boolean;
  days_since_activation: number;
  trades_since_activation: number;
  min_days: number;
  min_trades: number;
  loss_halt_today: boolean;
  reason: string;
}

/**
 * 同時滿足「距上次策略生效滿 min_days 個交易日」與「成交筆數 ≥ min_trades」才能提出修改；
 * 當日因虧損達停機門檻而暫停時不受限制（規格第 10 節）。
 * 交易日以系統有每日快照的日數計算。
 */
export function proposalEligibility(db: DB, config: Config, clock: Clock): ProposalEligibility {
  const activatedAt =
    (db.prepare('SELECT activated_at FROM strategy_versions ORDER BY activated_at DESC LIMIT 1').pluck().get() as string | undefined) ??
    `${getState(db, 'created_on') ?? '1970-01-01'}T00:00:00.000+08:00`;
  const activatedDate = activatedAt.slice(0, 10);
  const days = db.prepare('SELECT COUNT(*) FROM daily_snapshots WHERE date > ?').pluck().get(activatedDate) as number;
  const trades = db.prepare('SELECT COUNT(*) FROM fills WHERE ts >= ?').pluck().get(activatedAt) as number;

  const pause = getPause(db);
  const lossRules = ['daily_loss_limit', 'intraday_drawdown', 'max_drawdown'];
  const lossHalt = pause.paused && lossRules.includes(pause.rule ?? '') && pause.since?.slice(0, 10) === twDate(clock.now());

  const { min_days, min_trades } = config.review;
  const meets = days >= min_days && trades >= min_trades;
  return {
    eligible: meets || lossHalt,
    days_since_activation: days,
    trades_since_activation: trades,
    min_days,
    min_trades,
    loss_halt_today: lossHalt,
    reason: lossHalt
      ? '當日因虧損停機，可立即提出修改'
      : meets
        ? '已滿足交易日數與成交筆數'
        : `距上次策略生效 ${days}/${min_days} 個交易日、成交 ${trades}/${min_trades} 筆，兩者都要達標才能提出修改`,
  };
}

const MAX_NOTE_BYTES = 100_000;

/**
 * 寫入復盤記錄。筆記檔必須位於專案或復盤 worktree 的 reviews/ 目錄內，
 * 附上分支時為策略修改提案，須先通過 proposalEligibility。
 */
export function submitReview(
  db: DB,
  config: Config,
  input: { date: string; file: string; proposalBranch?: string; allowedRoots: string[] },
  clock: Clock,
): { date: string; status: string; eligibility?: ProposalEligibility } {
  const file = realpathSafe(resolve(input.file));
  const inReviews = input.allowedRoots.some((root) => {
    let dir: string;
    try {
      dir = realpathSync(resolve(root, 'reviews'));
    } catch {
      return false;
    }
    const rel = relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inReviews) throw invalidArgs('REVIEW_FILE_LOCATION', `復盤筆記必須放在 reviews/ 目錄內，收到 ${input.file}`);
  if (statSync(file).size > MAX_NOTE_BYTES) throw invalidArgs('REVIEW_FILE_TOO_LARGE', `復盤筆記超過 ${MAX_NOTE_BYTES} bytes`);
  const observations = readFileSync(file, 'utf8').trim();
  if (!observations) throw invalidArgs('REVIEW_EMPTY', '復盤筆記是空的');

  let status = 'observed';
  let eligibility: ProposalEligibility | undefined;
  if (input.proposalBranch) {
    if (!/^strategy\/\d{4}-\d{2}-\d{2}$/.test(input.proposalBranch)) {
      throw invalidArgs('INVALID_BRANCH', `提案分支名稱須為 strategy/YYYY-MM-DD，收到 ${input.proposalBranch}`);
    }
    eligibility = proposalEligibility(db, config, clock);
    if (!eligibility.eligible) throw riskRejected('PROPOSAL_NOT_ELIGIBLE', eligibility.reason, { ...eligibility });
    status = 'proposed';
  }

  const existing = db.prepare('SELECT status FROM reviews WHERE date = ?').pluck().get(input.date) as string | undefined;
  if (existing && existing !== 'observed') {
    throw invalidArgs('REVIEW_LOCKED', `${input.date} 的復盤已是 ${existing}，不能覆寫`);
  }
  db.prepare(
    `INSERT INTO reviews (date, observations, proposal_branch, status) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET observations = excluded.observations,
       proposal_branch = excluded.proposal_branch, status = excluded.status`,
  ).run(input.date, observations, input.proposalBranch ?? null, status);
  db.prepare('INSERT INTO audit_log (ts, actor, command, args_json, result) VALUES (?, ?, ?, ?, ?)').run(
    toTwIso(clock.now()),
    'claude',
    'review submit',
    JSON.stringify({ date: input.date, proposalBranch: input.proposalBranch ?? null }),
    status,
  );
  return { date: input.date, status, eligibility };
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    throw invalidArgs('REVIEW_FILE_MISSING', `找不到復盤筆記 ${p}`);
  }
}
