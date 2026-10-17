[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**開盤前準備**。觸發條件已重設為預設值。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 檢查帳本持倉、未完成委託、硬停損停利價是否合理。
3. 依策略判斷今天的基本方向。若策略允許參與開盤集合競價，可在 08:30–09:00 以整股（regular）委託。
4. 視需要以 `ctrade trigger set` 調整今天的觸發條件。
5. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
