-- 003：盤外資訊快取開始使用（規格第 14 節）。daemon 定時抓取，ctrade global 與 pre_open 提示從這裡讀。
-- ts 是資料本身的時間（最後成交或報價時間），fetched_at 是最後一次成功抓到這份資料的時間。
-- 同一份資料重複抓到時只更新 fetched_at，資料改變才新增一列，保留歷史供復盤對照。
ALTER TABLE market_context ADD COLUMN fetched_at TEXT;
CREATE INDEX idx_market_context_kind ON market_context (kind, id);
