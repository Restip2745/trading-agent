# 玉山證券 API 筆記

規格第 19 節第 1 階段的產出。逐項回答第 20 節「券商 API」的待確認事項，並記錄對設計的影響。

- 查證日期：2026-10-17
- 來源：[玉山程式交易 API 官方文件](https://www.esunsec.com.tw/trading-platforms/api-trading/docs/trading/intro/)，以及 `C:\Workspace\apps\evalis` 中以 Python SDK 實測過的行為（2026-08-24）。
- 標示 **【實測】** 的是 evalis 實際呼叫確認過的；其餘是照文件整理，實作時要以模擬環境或唯讀查詢驗證。

## SDK

| 項目 | 交易 SDK | 行情 SDK |
| --- | --- | --- |
| Node.js 套件 | `@esun/trade`（`esun-trade.tgz`） | `esun-marketdata.tgz`（套件名實作時從 tgz 的 package.json 確認） |
| Python 套件 | `esun_trade` 2.2.0（.whl） | `esun_marketdata` 2.2.0（.whl） |
| 取得方式 | 不在公開套件庫，從 [SDK 下載頁](https://www.esunsec.com.tw/trading-platforms/api-trading/docs/download/download-sdk/) 下載 | 同左 |
| 版本注意 | < 2.2.0（舊名 `fugle_trade`）自 2026-01-01 起不支援 | < 2.2.0（舊名 `fugle_marketdata`）自 2025-09-01 起降為基本用戶權限 |

**決定**：照規格使用 Node.js SDK。tgz 放 `vendor/`，以 `file:` 路徑引用。網路上 `fugle_*` 時期的舊範例不要照抄。

## 登入與憑證

- 需要三樣東西：設定檔（API URL、API Key、API Secret、證券帳號）、`.p12` 憑證、兩組密碼（證券登入密碼、憑證密碼）。
- **Node.js SDK** 的 `new EsunTrade({ config })` 可以直接傳入 `apiUrl`、`apiKey`、`apiSecret`、`certPath`、`certPass`、`aid`、`password`。這讓我們能完全從 OS keyring 讀出機密再傳入，不需要明文設定檔，符合規格第 12 節。
- **Python SDK** 刻意不接受明文密碼，第一次 `login()` 會互動式詢問並存進 OS keyring【實測】。Node.js SDK 沒有這個限制，改由我們自己的 keyring 層負責。
- 憑證路徑若為相對路徑，SDK 會以**目前工作目錄**解析，不是以設定檔所在目錄【實測】。我們一律傳絕對路徑。
- 憑證有效期限：`getCertInfo()` 回傳 `notAfter`（epoch 秒）與 `isValid`。使用者目前的憑證檔名顯示到期日為 2027-05-26。daemon 每日檢查，30 天內通知（規格第 18 節）。
- 系統時間：`getMachineTime()` 取得券商主機時間。本機時間差太大會導致驗章失敗（錯誤碼 `AGA0005 Invalid Timestamp`），可用來實作規格第 18 節的時間檢查。

## 環境與 IP 白名單

| 環境 | API URL |
| --- | --- |
| 正式 | `https://esuntradingapi.esunsec.com.tw/api/v1` |
| 模擬 | `https://esuntradingapi-simulation.esunsec.com.tw/api/v1` |

- 模擬環境與正式環境用不同的金鑰設定檔。取得正式權限前，必須在模擬環境送出過至少一筆委託。
- 模擬環境**不會產生成交回報**，帳務數字也不保證與正式環境一致【實測】。這印證規格第 3 節的決定：paper 模式用本地模擬撮合，券商模擬環境只用來驗證下單串接。
- 模擬金鑰的權限只有「交易委託＋帳務查詢」，行情要另外申請行情金鑰。行情 API 不分正式或模擬環境。
- 執行程式的對外 IP 必須登記在金鑰網站的白名單，否則登入失敗（`AGA0002 Invalid IP`），而且錯誤訊息常不明顯【實測】。家用固網的動態 IP 改變時要回去更新。

## 交易功能（Node.js SDK）

| 功能 | 方法 |
| --- | --- |
| 下單 | `placeOrder(order)` → `{ ordNo, ordDate, ordTime, retCode, retMsg, workDate }` |
| 當日委託 | `getOrders()` |
| 歷史委託 | `getHistoricalOrders({ startDate, endDate })` |
| 改價、改量 | `replacePrice(order, price)`、`replaceQuantity(order, qty)`（規格已決定不使用改單） |
| 刪單 | `cancelOrder(order)`，傳入 `getOrders()` 回來的委託物件 |
| 成交明細 | `getTransactions({ duration: '0d' \| '3d' \| '1m' \| '3m' })` |
| 庫存 | `getInventories()` |
| 交割款 | `getSettlements()` |
| 銀行餘額 | `getBalance()` |
| 交易額度與當沖資格 | `getTradeStatus()`，`dayTradeCode`：X 已啟用、Y 僅可先買後賣、N 未啟用、S 暫停中 |
| 市場是否開盤 | `getMarketStatus()` → `isTradingDay`、`lastTradingDay`、`nextTradingDay` |

### 委託參數

| 欄位 | 值 |
| --- | --- |
| `apCode` 盤別 | `1` 盤中整股、`2` 盤後定價、`3` 盤後零股、`4` 興櫃、`5` 盤中零股 |
| `priceFlag` | `0` 限價、`1` 平盤、`2` 跌停、`3` 漲停、`4` 市價 |
| `bsFlag` | `R` ROD、`I` IOC、`F` FOK |
| `trade` | `0` 現股、`3` 融資、`4` 融券、`A` 現股當沖賣 |

**數量單位依盤別不同**，這點對帳本換算很重要：

| 盤別 | 單位 | 範圍 |
| --- | --- | --- |
| 盤中整股（Common） | 張 | 1–499 |
| 盤後定價（AfterMarket） | 張 | 1–499 |
| 盤後零股（Odd） | 股 | 1–999 |
| 盤中零股（IntradayOdd） | 股 | 1–999 |

**對應到規格**：

- `session = regular` → `apCode 1`，送出時把帳本的「股」除以 1000 換成「張」，不是 1000 的倍數就拒絕。
- `session = odd_intraday` → `apCode 5`；`session = odd_after` → `apCode 3`，單位為股，範圍 1–999。
- 一律 `priceFlag 0`（限價）、`bsFlag R`（ROD）。
- **當沖賣出要帶 `trade = A`**（現股當沖賣），一般賣出帶 `0`。系統要判斷這筆賣出是否為當日買進部位，同時決定證交稅率（規格第 7 節：當沖 0.15%）。
- 委託回報有 `userDef` 自訂欄位，但模擬環境不支援，因此 `client_order_id` 不能依賴它，`unknown` 委託仍以代號、方向、價格、數量、時間比對（規格第 17 節）。正式環境可以額外寫入 `userDef` 作輔助比對。

### 主動回報

- `esun.streamer` 是 EventEmitter，事件有 `connect`、`disconnect`、`order`（委託回報）、`trade`（成交回報）、`message`、`error`。呼叫 `esun.streamer.connect()` 建立 WebSocket。
- 回報內容是**字串**，要自己 `JSON.parse`。
- **設計**：live 模式以主動回報為主，斷線時改以 `getOrders()`、`getTransactions({ duration: '0d' })` 補齊，但要遵守下表的查詢頻率限制。

### 使用限制

| 行為 | 上限 |
| --- | --- |
| 登入 | 每分鐘 10 次、每日 300 次 |
| 委託下單 | 每秒 20 次、每日 2000 次 |
| 庫存查詢 `getInventories` | 每分鐘 12 次 |
| 委託查詢 `getOrders` | 每分鐘 12 次 |
| 成交明細 `getTransactions` | 每分鐘 12 次 |
| 交割款 `getSettlements` | 每分鐘 3 次 |
| 銀行餘額 `getBalance` | 每 3 分鐘 1 次 |

超出每秒或每分鐘上限要等 1 分鐘，超出每日上限要等隔天。

**對設計的影響**：

- 規格的 `max_orders_per_minute = 5`、`max_orders_per_day = 20` 遠低於券商上限，安全。
- **登入每日 300 次**：CLI 每次執行都重新登入會很快用完。`ctrade` 不能每次自己登入券商，必須透過 daemon 的長連線送單，或在 daemon 中維持單一 SDK 實體（見下方「架構決定」）。
- 委託查詢每分鐘 12 次：daemon 的定時同步至少間隔 5 秒以上，建議 15 秒；以主動回報為主。
- 銀行餘額每 3 分鐘 1 次：只在每日對帳時查詢。

### 錯誤碼重點

| 代碼 | 意義 | 系統處理 |
| --- | --- | --- |
| `AGA0002` | IP 不在白名單 | 致命，停止並通知使用者 |
| `AGA0005` | 時間戳錯誤 | 檢查系統時間（規格第 18 節） |
| `AGA0000`、`C00003` | 登入密碼、憑證密碼錯誤 | 致命，不重試（避免帳號鎖定） |
| `C00005`、`AG00001` | 憑證過期或驗章失敗 | 致命，通知使用者重新匯出憑證 |
| `AGR0000`–`AGR0006` | 超過速率限制 | 等 1 分鐘再試，計入 API 失敗 |
| `AG00003`、`AG00005` | 單號不存在、不可刪除 | 視為委託狀態已變動，重新同步 |
| `AG00004` | 交易系統暫停服務 | 計入 API 失敗 |
| `O000xx` | 參數錯誤 | 程式錯誤，記錄並計入券商拒單 |

## 行情功能

| 端點 | 用途 | 規格對應 |
| --- | --- | --- |
| `intraday/ticker/{symbol}` | 參考價、**漲跌停價**、`isAttention`、`isDisposition`、`securityStatus`、`canDayTrade`、`matchingInterval`、`securityType` | 價格檢查（第 6 節第 5 條）、特殊狀態股票（第 6 節第 15 條、第 18 節）、證券別判斷 ETF 稅率 |
| `intraday/quote/{symbol}` | 即時報價、最佳五檔、試撮、`isTrial`、`tradingHalt` | `ctrade quote`、模擬撮合 |
| `intraday/candles/{symbol}` | 當日 K 線 | `ctrade candles` |
| `historical/candles/{symbol}` | 一年內歷史 K 線 | `ctrade candles`、績效基準 |
| `snapshot/quotes/{market}` | 全市場快照 | 備用 |
| WebSocket `trades`、`books`、`candles`、`aggregates`、`indices` | 即時推播 | daemon 盤中監看、價格觸發、硬停損 |

- 所有 `intraday` 端點都可加 `type: 'oddlot'` 取得**盤中零股**的資料，模擬撮合零股時要用這個。
- 指數代號：`IX0001` 為加權指數（價格指數）【實測可取得】。報酬指數另有代號，做基準比較時不要混用。

### 行情速率限制

| 類型 | 上限 |
| --- | --- |
| 日內行情 | 每分鐘 600 次 |
| 行情快照 | 每分鐘 600 次 |
| 歷史行情 | 每分鐘 60 次 |
| WebSocket | 300 個訂閱、2 個連線 |

超過時回 429，需等 1 分鐘。第一版只有 3 檔 ETF 加指數，遠低於上限。

### 實測過的行為【實測】

- 4xx 錯誤**不會拋出例外**，而是以一般回應回傳：`{ statusCode: 404, message: ... }`。每個回應都要檢查 `statusCode`。
- 歷史 K 線單次請求跨度必須小於 1 年，超過回 400。
- 非交易日回 404，不是空陣列。
- 當日資料不在 `historical` 端點，要用 `intraday.candles`。
- 分 K 的 `date` 是該根 K 線的**起始**時間。
- WebSocket 訊息是 JSON 字串；時間戳是**微秒** epoch。前幾則是 `authenticated`、`subscribed` 等控制訊息，真正的資料在 `event === 'data'`。
- 歷史價格為**未還原**的原始成交價，除權息要自行處理（對應規格第 16 節）。

## 架構決定

### 1. 券商連線集中在 daemon

登入每日上限 300 次，`ctrade` 每次執行都登入不可行。決定：

- daemon 持有唯一的交易 SDK 與行情 SDK 實體，維持登入狀態與 WebSocket。
- `ctrade` 與 `ctrade-admin` 透過本機 IPC 請 daemon 代為呼叫券商（下單、刪單、即時報價）。daemon 未執行時，需要券商的指令回傳結束碼 4，唯讀的帳本指令照常可用。
- 風控檢查與帳本寫入仍在 `core` 套件中執行，CLI 與 daemon 共用。CLI 先在本地完成風控與圈存，寫入 `pending_submit`，再交給 daemon 送出。
- paper 模式送單不需要券商，但行情仍來自 daemon 的快取，所以同樣經過 daemon。

### 2. 機密來源

- keyring 中存放：API Key、API Secret、證券帳號、證券登入密碼、憑證密碼、憑證檔絕對路徑。模擬與正式環境各一組，以服務名稱區分（例如 `trading-agent/esun-sim`、`trading-agent/esun-live`）。
- Node.js 的 keyring 套件候選：`@napi-rs/keyring`（`keytar` 已停止維護）。實作時確認可在 Windows 認證管理員讀寫。
- 提供 `ctrade-admin secrets set` 互動式寫入 keyring，不經過命令列參數，避免出現在 shell 歷史。

## 第 20 節「券商 API」待確認事項的結論

- [x] 登入流程、憑證有效期限、模擬與正式環境差異：見「登入與憑證」、「環境與 IP 白名單」。
- [x] 是否支援盤中零股、盤後零股、集合競價時段的委託：支援盤中零股（`apCode 5`）與盤後零股（`apCode 3`）。集合競價時段沒有獨立盤別，以盤中整股的 ROD 限價單在開盤前（08:30–09:00）與收盤前（13:25–13:30）送出即可參與，**需在模擬環境實際驗證**。
- [x] 成交回報的取得方式：WebSocket 主動回報（`streamer` 的 `order`、`trade` 事件），並可定時查詢。
- [x] 行情 API 提供的資料：即時報價、五檔、K 線、零股行情（`type: 'oddlot'`）、漲跌停價（ticker）。
- [x] 呼叫頻率限制與每日次數限制：見「使用限制」與「行情速率限制」。
- [x] 查詢帳戶持股與交割款的 API：`getInventories()`、`getSettlements()`、`getBalance()`。資料更新時間點文件未明載，官方建議盤中不要頻繁查詢庫存與餘額。**實際更新時點需在正式環境觀察**。
- [ ] API 使用條款中對自動化交易的規定：文件的最佳實踐頁只提醒遵守交易規則與速率限制。規格第 6 節引述的「短時間連續送單可能被限制或暫停服務」出自 API 使用約定，**需由使用者對照自己簽署的約定確認**。

## 仍需使用者處理

1. 從 SDK 下載頁下載 `esun-trade.tgz` 與 `esun-marketdata.tgz`，放進本專案的 `vendor/`。
2. 申請行情金鑰（模擬金鑰沒有行情權限）。
3. 確認目前使用的對外 IP 已登記在正式與模擬的白名單。
4. 模擬金鑰 evalis 筆記記載有效至 2026-09-25，**目前已過期**，進行模擬環境串接驗證前需重新申請。
