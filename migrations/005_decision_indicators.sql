-- 005：決策時的指標快照，讓決策日誌看到 agent 寫決策當下讀得到的數值，而不是事後的完整走勢。
-- ctrade journal add 先寫入決策，再向 daemon 取與 ctrade indicators 相同的資料補上；
-- 取不到時（daemon 未執行、逾時、行情來源不支援）決策照常寫入，indicators_json 留空，原因記在 indicators_error。
-- 這兩欄之前寫入的決策都是 NULL。
ALTER TABLE decisions ADD COLUMN indicators_json TEXT;   -- ctrade indicators 的輸出（不含 notes）
ALTER TABLE decisions ADD COLUMN indicators_error TEXT;  -- 取不到快照的原因，例如 DAEMON_UNAVAILABLE：…
