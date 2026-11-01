# Changelog

格式參考 [Keep a Changelog](https://keepachangelog.com/)，版本號依 `model-router/.claude-plugin/plugin.json`。

## [Unreleased]

## [0.4.0] — 2026-11-01

### 新增
- 問答依難度路由。預設：容易 → Sonnet · max（`easyRoute` 可改成 `sonnet medium`）、困難 → Opus · medium、冷僻事實 → Sonnet · low。信心低於 0.6 的容易或冷僻題改走困難那一組。改檔與跑指令仍走原來的三層；對話中途仍只升不降。
- 答完的三層檢查：免費規則（格式、合理區間、重複錯誤、長度超過近期正常的 2.5 倍）命中才呼叫 Haiku，只收 `{ok, why, confidence}`；`ok` 為 false 且信心 ≥ 0.7 才用較強的模型或高一級 effort 重試一次。
- 主迴圈每次請求追加 `cost.jsonl`（token 與依公開牌價估的 `usd_estimate`、是否為重試）。

## [0.3.1] — 2026-10-15

### 修正
- 上下文守衛選「壓縮」或「清除」時實際上沒有執行：`prompt.submit` hook 裡的 `$.session.compact()` 與 `$.command.run()` 會被引擎拒絕（host check：「it would compact under the turn this hook is holding」），錯誤被吞掉後訊息照常送出。改為先擋下訊息，hook 回傳後執行 `/compact` 或 `/clear`，再原樣重送。
- 清除後重送的訊息不會再經過同一個 hook，router 原本不會在新對話重新分類；改為重送前先分類。
- 帶 `@檔案` 或圖片的訊息壓縮後無法自動重送，改為把文字放回輸入框。

### 新增
- 4 個經過引擎的守衛整合測試（壓縮、清除、帶 @檔案、繼續），共 32 個。

## [0.3.0] — 2026-10-08

### 新增
- 上下文守衛：送出訊息前，若與先前對話無關（Haiku 判斷）或 context 過大（≥ 200k tokens / 50%），詢問清除或壓縮；清除後原樣重送訊息。
- `/guard` 診斷指令；設定 `guardTokens`、`guardPercent`、`relevance`。
- 9 個守衛單元測試（共 28 個）。

### 已知缺口
- 清除 → 重送的互動流程只有單元測試與手動驗證，沒有引擎整合測試。

## [0.2.0] — 2026-10-06

第一個公開版本。

### 新增
- 在 `startup` / `clear` / `compact` / `resume` / `fork` 時用 Haiku 分類，選擇 Opus / Sonnet / Haiku 與 effort。
- 對話中途只升不降，信心 ≥ 0.8 才升級；`midSession` 設定：`upgrade` / `suggest` / `off`。
- `/route opus|sonnet|haiku [effort]` 鎖定、`/route auto` 恢復並重新分類。
- 使用者用 `/model` 手動切換後 mod 不再干預；subagent 不改寫。
- 狀態列顯示目前路由。
- 19 個測試（17 個規則單元測試、2 個經過引擎的整合測試）。

### 已知缺口
- 尚未實作 Jev 分類器。
- marketplace 安裝流程依官方文件撰寫，未在本機實測。
