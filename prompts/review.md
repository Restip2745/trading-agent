[TRADING SESSION] 模式：{{mode}}　時間：{{now}}

觸發：{{trigger_reason}}

這是**收盤復盤**。ctrade 為唯讀模式，不能下單。對帳與每日快照已完成。

1. 讀取 trading-cli 與 trading-strategy skill。
2. 以 `ctrade review-data` 讀取今天的觸發、決策理由、委託、成交、損益與風控事件。
3. 寫入復盤筆記 `reviews/<今天日期>.md`，內容包含：
   - 今天每個決策是否照策略走（逐一對照策略條文）
   - 做對與做錯的地方，以及原因
   - 觀察到的模式（只寫觀察，單日盈虧多半是雜訊）
   - 對策略的建議（如果有）
4. 以 `ctrade review submit --date <今天日期> --file reviews/<今天日期>.md` 寫入資料庫。

**目前只寫觀察與建議，不修改策略檔。** 策略修改提案流程（獨立分支、使用者審核）尚未開放；`review-data` 的 `proposal.eligible` 為 true 時，把具體的修改建議寫在筆記中即可。風控參數、觸發範圍、trading-cli skill 與程式碼一律不可修改。

## 補充說明

{{notes}}

## 目前狀態（ctrade status 摘要）

```json
{{status_json}}
```
