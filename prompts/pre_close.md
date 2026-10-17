[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**收盤前決策**。13:25–13:30 為收盤集合競價，整股委託要在 13:30 前送出。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 依策略決定哪些部位當日出清、哪些留倉過夜；當沖部位是否留倉要照策略規則。
3. 檢查未完成委託，不需要的先刪單。
4. 確認留倉部位都有合理的硬停損停利價。
5. 結束前寫入決策記錄（`ctrade journal add`）。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
