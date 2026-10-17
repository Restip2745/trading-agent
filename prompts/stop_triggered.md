[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

daemon 已依你設定的**硬停損或停利價自動賣出**，這次叫醒是告知結果。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 以 `ctrade fills`、`ctrade positions`、`ctrade orders --open` 確認成交與剩餘部位。
3. 依策略決定後續：是否需要調整剩餘部位的停損停利、是否暫時不再進場（賣出後有再進場冷卻時間）。
4. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
