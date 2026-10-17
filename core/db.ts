import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import { pctToPpm } from './money.js';
import { type Clock, systemClock, toTwIso, twDate } from './time.js';

export type DB = Database.Database;

export interface OpenOptions {
  root: string;
  config: Config;
  /** 測試用：直接指定路徑，':memory:' 為記憶體資料庫。 */
  path?: string;
  clock?: Clock;
}

/**
 * 開啟帳本資料庫：WAL 模式讓 daemon、CLI、Web UI 可同時讀取（規格第 12 節），
 * 執行尚未套用的 migration，首次建立時寫入設定檔的初始值。
 */
export function openDb({ root, config, path, clock = systemClock }: OpenOptions): DB {
  const file = path ?? join(root, 'data', `${config.mode}.db`);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db, join(root, 'migrations'), clock);
  seedIfEmpty(db, root, config, clock);
  return db;
}

export function migrate(db: DB, dir: string, clock: Clock = systemClock): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as string[],
  );
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        toTwIso(clock.now()),
      );
    })();
  }
}

function seedIfEmpty(db: DB, root: string, config: Config, clock: Clock): void {
  const hasSettings = db.prepare('SELECT 1 FROM risk_settings LIMIT 1').get();
  if (hasSettings) return;

  const now = clock.now();
  const ts = toTwIso(now);
  const today = twDate(now);
  const f = config.fees;

  db.transaction(() => {
    db.prepare('INSERT INTO risk_settings (ts, params_json, actor) VALUES (?, ?, ?)').run(
      ts,
      JSON.stringify(config.risk),
      'system',
    );
    db.prepare(
      `INSERT INTO fee_schedules (effective_date, fee_rate_ppm, fee_discount_bp, rebate_mode,
         min_fee_regular, min_fee_odd, tax_stock_ppm, tax_daytrade_ppm, tax_etf_ppm, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?)`,
    ).run(
      // 初始版本從遠古生效，讓任何日期都查得到費率
      '1970-01-01',
      pctToPpm(f.fee_rate_pct),
      Math.round(f.fee_discount * 10_000),
      f.rebate_mode,
      f.min_fee_regular,
      f.min_fee_odd,
      pctToPpm(f.tax_stock_pct),
      pctToPpm(f.tax_daytrade_pct),
      pctToPpm(f.tax_etf_pct),
      ts,
    );
    db.prepare(
      `INSERT INTO market_rules (effective_date, rules_json, created_by, created_at) VALUES ('1970-01-01', ?, 'system', ?)`,
    ).run(JSON.stringify(config.market), ts);

    const d = config.trigger.defaults;
    db.prepare(
      `INSERT INTO trigger_config (interval_min, up_pct, down_pct, set_by, set_at) VALUES (?, ?, ?, 'system', ?)`,
    ).run(d.interval_min, d.up_pct, d.down_pct, ts);

    const insertHoliday = db.prepare(
      `INSERT OR IGNORE INTO holidays (date, reason, source) VALUES (?, ?, 'calendar')`,
    );
    for (const h of readHolidayCsv(join(root, 'config', 'holidays.csv'))) insertHoliday.run(h.date, h.name);

    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES ('created_on', ?, ?)`).run(today, ts);
  })();
}

export function readHolidayCsv(path: string): { date: string; name: string }[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('date,'))
    .map((line) => {
      const [date = '', ...rest] = line.split(',');
      return { date: date.trim(), name: rest.join(',').trim() };
    });
}
