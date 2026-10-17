[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**盤中例行檢查**。沒有明確符合策略的理由時，不動作是合理的決策。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 檢查行情、持倉與未完成委託，對照策略條件。
3. 決定動作，必要時調整觸發條件。
4. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
