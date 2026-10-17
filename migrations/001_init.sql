-- 001_init：帳本核心 schema（規格第 4 節）
--
-- 通用規則：
--   金額一律為整數「元」；價格一律為整數「分」（*_x100）；股數一律為「股」。
--   時間一律為 ISO 8601 含 +08:00。
--   流水表只能 INSERT，由下方 trigger 擋下 UPDATE 與 DELETE，更正以反向調整記錄完成。

-- ---------------------------------------------------------------- 流水

CREATE TABLE cash_movements (
  id        INTEGER PRIMARY KEY,
  ts        TEXT    NOT NULL,
  type      TEXT    NOT NULL CHECK (type IN (
              'allocate_in', 'allocate_out', 'buy', 'sell', 'fee', 'fee_rebate',
              'tax', 'dividend', 'capital_reduction', 'adjust')),
  amount    INTEGER NOT NULL,           -- 帶正負號：入帳為正、出帳為負
  order_id  INTEGER REFERENCES orders(id),
  fill_id   INTEGER REFERENCES fills(id),
  actor     TEXT    NOT NULL CHECK (actor IN ('claude', 'user', 'system')),
  note      TEXT
);

CREATE TABLE position_movements (
  id        INTEGER PRIMARY KEY,
  ts        TEXT    NOT NULL,
  symbol    TEXT    NOT NULL,
  type      TEXT    NOT NULL CHECK (type IN (
              'buy', 'sell', 'transfer_in', 'transfer_out', 'corporate_action', 'adjust')),
  qty       INTEGER NOT NULL,           -- 帶正負號：增加為正、減少為負
  cost_x100 INTEGER NOT NULL,           -- 總成本變動（分），帶正負號；賣出時以當下平均成本扣除
  fill_id   INTEGER REFERENCES fills(id),
  actor     TEXT    NOT NULL CHECK (actor IN ('claude', 'user', 'system')),
  note      TEXT
);
CREATE INDEX idx_position_movements_symbol ON position_movements(symbol);

-- ---------------------------------------------------------------- 委託與成交

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY,
  client_order_id     TEXT    NOT NULL UNIQUE,
  broker_order_id     TEXT,
  symbol              TEXT    NOT NULL,
  side                TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  session             TEXT    NOT NULL CHECK (session IN ('regular', 'odd_intraday', 'odd_after')),
  origin              TEXT    NOT NULL CHECK (origin IN ('claude', 'stop', 'emergency')),
  price_x100          INTEGER NOT NULL CHECK (price_x100 > 0),
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  filled_qty          INTEGER NOT NULL DEFAULT 0 CHECK (filled_qty >= 0 AND filled_qty <= qty),
  status              TEXT    NOT NULL CHECK (status IN (
                        'pending_submit', 'submitted', 'partial', 'filled',
                        'cancelled', 'rejected', 'expired', 'unknown')),
  reserved_amount     INTEGER NOT NULL DEFAULT 0,   -- 買單圈存：價金 + 預估手續費（元）
  decision_id         INTEGER REFERENCES decisions(id),
  strategy_version    TEXT,
  cancel_requested_at TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  reject_reason       TEXT
);
CREATE INDEX idx_orders_symbol_status ON orders(symbol, status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

CREATE TABLE fills (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  broker_fill_id  TEXT,
  ts              TEXT    NOT NULL,
  price_x100      INTEGER NOT NULL CHECK (price_x100 > 0),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  fee             INTEGER NOT NULL,
  tax             INTEGER NOT NULL,
  day_trade       INTEGER NOT NULL DEFAULT 0,       -- 1：現股當沖賣出
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id),
  settle_date     TEXT    NOT NULL,
  simulated       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fills_order ON fills(order_id);
CREATE UNIQUE INDEX idx_fills_broker ON fills(broker_fill_id) WHERE broker_fill_id IS NOT NULL;

-- ---------------------------------------------------------------- 觸發與決策

CREATE TABLE trigger_events (
  id             INTEGER PRIMARY KEY,
  ts             TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  detail_json    TEXT,
  invoked_claude INTEGER NOT NULL DEFAULT 0,
  skip_reason    TEXT
);

CREATE TABLE decisions (
  id                INTEGER PRIMARY KEY,
  trigger_event_id  INTEGER REFERENCES trigger_events(id),
  ts                TEXT    NOT NULL,
  model             TEXT,
  reasoning         TEXT    NOT NULL,
  actions_json      TEXT    NOT NULL,
  next_trigger_json TEXT,
  strategy_version  TEXT
);

-- 只增不改，以最新一筆為準
CREATE TABLE trigger_config (
  id           INTEGER PRIMARY KEY,
  interval_min INTEGER,                -- NULL 代表關閉
  up_pct       REAL,                   -- NULL 代表價格觸發關閉（與 down_pct 一起）
  down_pct     REAL,
  set_by       TEXT    NOT NULL CHECK (set_by IN ('claude', 'user', 'system')),
  set_at       TEXT    NOT NULL,
  valid_until  TEXT
);

CREATE TABLE price_refs (
  id          INTEGER PRIMARY KEY,
  symbol      TEXT    NOT NULL,
  price_x100  INTEGER NOT NULL,
  decision_id INTEGER REFERENCES decisions(id),
  set_at      TEXT    NOT NULL
);
CREATE INDEX idx_price_refs_symbol ON price_refs(symbol, id);

CREATE TABLE protective_stops (
  id               INTEGER PRIMARY KEY,
  ts               TEXT    NOT NULL,
  symbol           TEXT    NOT NULL,
  stop_x100        INTEGER,            -- NULL 代表未設定
  take_profit_x100 INTEGER,
  set_by           TEXT    NOT NULL CHECK (set_by IN ('claude', 'user', 'system')),
  reason           TEXT
);
CREATE INDEX idx_protective_stops_symbol ON protective_stops(symbol, id);

-- ---------------------------------------------------------------- 用量、快照、對帳

CREATE TABLE usage_log (
  id                INTEGER PRIMARY KEY,
  ts                TEXT    NOT NULL,
  trigger_event_id  INTEGER REFERENCES trigger_events(id),
  model             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cost_usd          REAL,
  duration_ms       INTEGER,
  exit_status       TEXT
);

CREATE TABLE daily_snapshots (
  date           TEXT    PRIMARY KEY,
  cash           INTEGER NOT NULL,
  reserved       INTEGER NOT NULL,
  market_value   INTEGER NOT NULL,
  equity         INTEGER NOT NULL,
  peak_equity    INTEGER NOT NULL,
  realized_pnl   INTEGER NOT NULL,
  unrealized_pnl INTEGER NOT NULL,
  fees_tax       INTEGER NOT NULL
);

CREATE TABLE reconciliation_runs (
  id         INTEGER PRIMARY KEY,
  date       TEXT    NOT NULL,
  ts         TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('ok', 'warning', 'error')),
  diffs_json TEXT    NOT NULL
);

-- ---------------------------------------------------------------- 策略與復盤

CREATE TABLE strategy_versions (
  version      TEXT PRIMARY KEY,       -- git commit hash
  activated_at TEXT NOT NULL,
  note         TEXT
);

CREATE TABLE reviews (
  date            TEXT PRIMARY KEY,
  observations    TEXT NOT NULL,
  proposal_branch TEXT,
  status          TEXT NOT NULL CHECK (status IN (
                    'observed', 'proposed', 'approved', 'merged', 'rejected', 'invalid')),
  reject_reason   TEXT
);

-- ---------------------------------------------------------------- 風控與系統

CREATE TABLE risk_events (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  rule        TEXT NOT NULL,
  detail_json TEXT,
  action      TEXT NOT NULL            -- reject、pause、warn、adjust
);

-- 風控參數，只增不改，以最新一筆為準
CREATE TABLE risk_settings (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  params_json TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('user', 'system'))
);

CREATE TABLE system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE holidays (
  date   TEXT PRIMARY KEY,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('calendar', 'user'))
);

-- ---------------------------------------------------------------- 費率與市場規則（版本化，規格第 7 節）

CREATE TABLE fee_schedules (
  id                   INTEGER PRIMARY KEY,
  effective_date       TEXT    NOT NULL,
  fee_rate_ppm         INTEGER NOT NULL,   -- 0.1425% = 1425
  fee_discount_bp      INTEGER NOT NULL,   -- 2.8 折 = 2800，無折扣 = 10000
  rebate_mode          TEXT    NOT NULL CHECK (rebate_mode IN ('instant', 'monthly')),
  min_fee_regular      INTEGER NOT NULL,
  min_fee_odd          INTEGER NOT NULL,
  tax_stock_ppm        INTEGER NOT NULL,
  tax_daytrade_ppm     INTEGER NOT NULL,
  tax_etf_ppm          INTEGER NOT NULL,
  created_by           TEXT    NOT NULL CHECK (created_by IN ('user', 'system')),
  created_at           TEXT    NOT NULL
);

CREATE TABLE market_rules (
  id             INTEGER PRIMARY KEY,
  effective_date TEXT NOT NULL,
  rules_json     TEXT NOT NULL,
  created_by     TEXT NOT NULL CHECK (created_by IN ('user', 'system')),
  created_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------- 盤外資訊與公司行動

CREATE TABLE market_context (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  ts           TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source       TEXT NOT NULL
);

CREATE TABLE news_items (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  source  TEXT NOT NULL,
  title   TEXT NOT NULL,
  summary TEXT,
  url     TEXT
);

CREATE TABLE corporate_actions (
  id                  INTEGER PRIMARY KEY,
  symbol              TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('cash_dividend', 'stock_dividend', 'split', 'capital_reduction')),
  ex_date             TEXT NOT NULL,
  pay_date            TEXT,
  cash_per_share_x100 INTEGER,
  stock_ratio         REAL,
  split_ratio         REAL,
  source              TEXT NOT NULL
);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  command   TEXT NOT NULL,
  args_json TEXT,
  result    TEXT NOT NULL
);

-- ---------------------------------------------------------------- 只增不改

CREATE TRIGGER cash_movements_no_update BEFORE UPDATE ON cash_movements
BEGIN SELECT RAISE(ABORT, 'cash_movements 只能新增，請以反向調整記錄更正'); END;
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements
BEGIN SELECT RAISE(ABORT, 'cash_movements 只能新增，請以反向調整記錄更正'); END;

CREATE TRIGGER position_movements_no_update BEFORE UPDATE ON position_movements
BEGIN SELECT RAISE(ABORT, 'position_movements 只能新增，請以反向調整記錄更正'); END;
CREATE TRIGGER position_movements_no_delete BEFORE DELETE ON position_movements
BEGIN SELECT RAISE(ABORT, 'position_movements 只能新增，請以反向調整記錄更正'); END;

CREATE TRIGGER fills_no_update BEFORE UPDATE ON fills
BEGIN SELECT RAISE(ABORT, 'fills 只能新增'); END;
CREATE TRIGGER fills_no_delete BEFORE DELETE ON fills
BEGIN SELECT RAISE(ABORT, 'fills 只能新增'); END;

CREATE TRIGGER risk_settings_no_update BEFORE UPDATE ON risk_settings
BEGIN SELECT RAISE(ABORT, 'risk_settings 只能新增'); END;
CREATE TRIGGER fee_schedules_no_update BEFORE UPDATE ON fee_schedules
BEGIN SELECT RAISE(ABORT, 'fee_schedules 只能新增'); END;
CREATE TRIGGER market_rules_no_update BEFORE UPDATE ON market_rules
BEGIN SELECT RAISE(ABORT, 'market_rules 只能新增'); END;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log 只能新增'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log 只能新增'); END;

-- ---------------------------------------------------------------- 推導值（規格第 4 節）

-- 未完成委託：pending_submit、submitted、partial、unknown
CREATE VIEW v_open_orders AS
SELECT * FROM orders WHERE status IN ('pending_submit', 'submitted', 'partial', 'unknown');

CREATE VIEW v_cash_balance AS
SELECT COALESCE(SUM(amount), 0) AS cash FROM cash_movements;

-- 圈存：未完成買單依剩餘股數比例保留（無條件進位，寧可多圈）
CREATE VIEW v_reserved AS
SELECT COALESCE(SUM((reserved_amount * (qty - filled_qty) + qty - 1) / qty), 0) AS reserved
FROM v_open_orders WHERE side = 'buy';

CREATE VIEW v_balance AS
SELECT c.cash AS cash, r.reserved AS reserved, c.cash - r.reserved AS available
FROM v_cash_balance c, v_reserved r;

CREATE VIEW v_positions AS
SELECT
  p.symbol,
  SUM(p.qty) AS qty,
  SUM(p.cost_x100) AS cost_x100,
  COALESCE((SELECT SUM(o.qty - o.filled_qty) FROM v_open_orders o
            WHERE o.symbol = p.symbol AND o.side = 'sell'), 0) AS pending_sell_qty,
  SUM(p.qty) - COALESCE((SELECT SUM(o.qty - o.filled_qty) FROM v_open_orders o
            WHERE o.symbol = p.symbol AND o.side = 'sell'), 0) AS sellable_qty
FROM position_movements p
GROUP BY p.symbol
HAVING SUM(p.qty) <> 0 OR SUM(p.cost_x100) <> 0;
