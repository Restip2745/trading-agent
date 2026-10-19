-- 004：K 線快取，給決策日誌的盤勢圖使用。
-- 過去交易日的 5 分 K 不會再變，第一次向 daemon 取得後存在這裡，之後檢視歷史日誌不必依賴 daemon，也不重複呼叫券商 API。
-- 當天的 K 線還在變動，不快取；取得的結果是空的也不快取（可能是資料尚未就緒）。
-- 價格是當時的實際價格（不做除權息、分割還原），才能與當天的成交記錄對照。
CREATE TABLE bar_cache (
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL CHECK (timeframe IN ('5m')),
  date       TEXT NOT NULL,           -- 交易日 YYYY-MM-DD
  bars_json  TEXT NOT NULL,           -- [{date, open, high, low, close, volume}]；價格為元，5 分 K 的 volume 為張
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, date)
);
