[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**開盤後第一次決策**。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 以 `ctrade quote` 查看開盤價與五檔，對照策略的進場與出場條件。
3. 決定動作（下單、調整停損停利，或不動作），並設定下一輪觸發條件。
4. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
