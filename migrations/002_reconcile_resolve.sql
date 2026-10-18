-- 002：對帳差異可標記為已處理（Web UI 對帳頁，規格第 11 節）
ALTER TABLE reconciliation_runs ADD COLUMN resolved_at TEXT;
ALTER TABLE reconciliation_runs ADD COLUMN resolved_note TEXT;
