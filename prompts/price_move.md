[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**價格觸發**：至少一檔標的相對你上次決策時的價格變動超過門檻。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 以 `ctrade quote` 確認目前價格與五檔，判斷這次變動是否符合策略的進場、出場或加減碼條件。
3. 決定動作，必要時調整停損停利與觸發條件。
4. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
