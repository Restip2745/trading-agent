import { spawnSync } from 'node:child_process';
import type { DB } from './db.js';
import { CtradeError, ExitCode, invalidArgs } from './errors.js';
import { type Clock, toTwIso } from './time.js';

/**
 * 策略版本（規格第 10 節）：版本號是最後一次修改 trading-strategy skill 的 git commit。
 * 每筆委託與決策記錄當時生效的版本，Dashboard 可依版本比較績效。
 * 重新啟用舊版本（回滾）時更新其啟用時間，讓它成為目前版本。
 *
 * 交易工作階段讀的是專案目錄裡的策略檔，所以叫醒 Claude 前要確認檔案內容就是生效版本
 * （checkStrategyFiles），否則決策記錄上的版本號與 Claude 實際照著走的策略會不一致。
 */

export const STRATEGY_DIR = '.claude/skills/trading-strategy';

export interface StrategyVersion {
  version: string;
  activated_at: string;
  note: string | null;
}

export function activateStrategy(db: DB, version: string, note: string | undefined, clock: Clock): StrategyVersion {
  if (!/^[0-9a-f]{40}$/.test(version)) throw invalidArgs('INVALID_VERSION', `策略版本必須是完整的 git commit hash，收到 ${version}`);
  const activatedAt = toTwIso(clock.now());
  db.prepare(
    `INSERT INTO strategy_versions (version, activated_at, note) VALUES (?, ?, ?)
     ON CONFLICT(version) DO UPDATE SET activated_at = excluded.activated_at, note = excluded.note`,
  ).run(version, activatedAt, note ?? null);
  return { version, activated_at: activatedAt, note: note ?? null };
}

export function currentStrategy(db: DB): StrategyVersion | undefined {
  return db.prepare('SELECT * FROM strategy_versions ORDER BY activated_at DESC LIMIT 1').get() as StrategyVersion | undefined;
}

export function listStrategies(db: DB): StrategyVersion[] {
  return db.prepare('SELECT * FROM strategy_versions ORDER BY activated_at DESC').all() as StrategyVersion[];
}

// ---------------------------------------------------------------- git

export function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new CtradeError('GIT_ERROR', `git ${args.join(' ')} 失敗：${(r.stderr ?? r.error?.message ?? '').trim()}`, ExitCode.INTERNAL);
  return r.stdout.replace(/\s+$/, '');
}

export interface StrategyCheck {
  ok: boolean;
  version: string | null;
  /** 與生效版本不同的檔案（含未進版控的新檔） */
  changed: string[];
  reason: string | null;
}

/** 比對專案目錄裡的策略檔與生效版本的 commit：內容不同、多出檔案、或無法確認時 ok 為 false。 */
export function checkStrategyFiles(root: string, version: string | null): StrategyCheck {
  if (!version) return { ok: false, version, changed: [], reason: '尚未啟用任何策略版本，請先執行 ctrade-admin strategy activate' };
  try {
    git(root, ['cat-file', '-e', `${version}^{commit}`]);
  } catch {
    return { ok: false, version, changed: [], reason: `git 裡找不到生效版本 ${version.slice(0, 12)}` };
  }
  try {
    const changed = [
      ...git(root, ['diff', '--name-only', version, '--', STRATEGY_DIR]).split('\n'),
      ...git(root, ['ls-files', '--others', '--exclude-standard', '--', STRATEGY_DIR]).split('\n'),
    ].filter(Boolean);
    if (changed.length === 0) return { ok: true, version, changed, reason: null };
    return {
      ok: false,
      version,
      changed,
      reason: `策略檔與生效版本 ${version.slice(0, 12)} 不同：${changed.join('、')}。請 commit 後重新啟用，或還原成生效版本`,
    };
  } catch (e) {
    return { ok: false, version, changed: [], reason: `無法確認策略檔：${(e as Error).message}` };
  }
}

/** 生效版本的策略檔內容（從 git 取出，不是讀工作目錄）。 */
export function strategyFilesAt(root: string, version: string): { path: string; content: string }[] {
  const paths = git(root, ['ls-tree', '-r', '--name-only', version, '--', STRATEGY_DIR]).split('\n').filter(Boolean);
  return paths.map((path) => ({ path, content: git(root, ['show', `${version}:${path}`]) }));
}

/** 工作目錄相對生效版本的差異（給 Web UI 顯示）。 */
export function strategyDiff(root: string, version: string): string {
  return git(root, ['diff', version, '--', STRATEGY_DIR]);
}
