import type { DB } from './db.js';
import { invalidArgs } from './errors.js';
import { type Clock, toTwIso } from './time.js';

/**
 * 策略版本（規格第 10 節）：版本號是最後一次修改 trading-strategy skill 的 git commit。
 * 每筆委託與決策記錄當時生效的版本，Dashboard 可依版本比較績效。
 * 重新啟用舊版本（回滾）時更新其啟用時間，讓它成為目前版本。
 */

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
