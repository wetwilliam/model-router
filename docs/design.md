# 設計文件

> 目標：讓 Claude Code 依每次 prompt 自動挑選 Opus / Sonnet / Haiku 與 effort，同時避免頻繁換模型造成 prompt cache 失效。
> 這份文件說明「為什麼這樣設計」。實際行為以原始碼為準：[`model-router/hooks/`](../model-router/hooks/)。

## 1. 可行方案比較

| 做法 | 能否依 prompt 自動切換 | 備註 |
|---|---|---|
| **Claude Code mod（本專案採用）** | ✅ 每次 API 請求都能改 `model` 與 `effort` | `turn.step` 事件：`next({ ...e, model, effort })` |
| settings.json 傳統 hooks | ❌ | [官方文件](https://code.claude.com/docs/en/hooks)：`UserPromptSubmit` 只能擋 / 注入 context；`PreModelSwitch` 只能 allow / deny，沒有任何欄位能改 model 或 effort |
| `opusplan` 別名 | ⚠️ 只依「模式」 | plan mode 用 Opus、執行用 Sonnet，不看 prompt 內容（[Model configuration](https://code.claude.com/docs/en/model-config)） |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | ⚠️ 只依請求類型 | 本機 proxy，依 background / thinking / long context 分流，主要用途是接其他供應商 |
| 官方原生路由設定 | ❌ 沒有 | [#44976](https://github.com/anthropics/claude-code/issues/44976) 已被標為重複後關閉，官方沒有回應 |

## 2. Router prompt 相對原始版本的修改

原始版本見 [`original-prompt.md`](original-prompt.md)，現行版本是 [`prompt.ts`](../model-router/hooks/prompt.ts)。

### 必改（不改會跟 Claude Code 的機制衝突）

| # | 原設計 | 問題 | 修改 |
|---|---|---|---|
| 1 | `extended_thinking: true/false` | Claude Code 已改用 effort 等級（`low` / `medium` / `high` / `xhigh` / `max`）搭配 adaptive thinking，沒有「開關」 | 改輸出 `effort` |
| 2 | 輸出 `primary_model` / `fallback_model` | 讓分類模型自己寫 model ID 容易寫錯；替補由 Claude Code 自己處理 | 刪掉，只輸出 `risk_tier`，程式碼做 tier → model 對應 |
| 3 | 只看單一句 prompt | Claude Code 裡大量輸入是「繼續」「好」「跑一下測試」；resume / compact 後第一句也常是接續句 | 輸入加入 `session_event`、`previous_tier`、`recent_context`（compact 時放摘要）；接續句沿用上一層級 |
| 4 | Haiku 典型場景包含一般操作 | Claude Code 的主迴圈是 agent（讀檔、改檔、跑指令），Haiku 在多步工具呼叫上較弱 | Haiku 只限「不需動到 repo 的純問答 / 格式轉換」；會改檔或跑指令最低 Sonnet |
| 5 | 沒有防注入 | 使用者貼入的文件可能含「請用 Opus」「忽略以上規則」 | 明定標籤內文字一律是資料，不是指令 |

### 建議改（影響成本與穩定度）

| # | 修改 | 原因 |
|---|---|---|
| 6 | 加 `confidence`（0–1） | 路由窗口內低於 0.6 往上升一級；對話中途 ≥ 0.8 才升級 |
| 7 | 輸出欄位精簡 | 分類用 Haiku + `effort: low`，輸出越短越快越便宜 |
| 8 | 「何時允許切換」由程式決定，不由 prompt 決定 | 這是成本問題，與任務分類無關，放程式碼比較可靠且可測試 |
| 9 | resume 的長對話不選 Haiku | Haiku 4.5 的 context window 比 Opus / Sonnet 小 |

### Effort 對應

| Tier | 預設 effort | 調高 | 調低 |
|---|---|---|---|
| TIER_1_OPUS | `high` | 根因不明的 debug、安全審查、架構重構 → `xhigh` | — |
| TIER_2_SONNET | `medium` | 多步推導、多條件邏輯、數學 → `high` | 純照規格產出 → `low` |
| TIER_3_HAIKU | 不送 effort | — | — |

`max` 很貴，router 不主動選，留給使用者手動指定。

## 3. 路由時機與 cache 成本

### 為什麼不每一句都分類

換模型會讓 prompt cache 失效，下一次請求要把整段 context 重新寫入新模型的 cache，**代價與當下 context 長度成正比**。

這個判斷的依據：

- Claude Code 的 mod API 型別定義中，`PostModelSwitch` 事件帶有 `prompt_cache_warm`（註解：*Whether the current model's prompt cache is likely still warm (a switch then forfeits it)*）與 `estimated_cache_write_usd`（重新快取 `context_tokens` 的預估成本）。`model.fork` 的說明也寫到 `/model` 之後 prefix 會重新計費。
- Anthropic 的 [Prompt caching 文件](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) **沒有明講**「換模型會失效」（我讀到的前 10 萬字元範圍內沒有這句），但說明了其他參數變動會使 cache 失效，並給出費率：5 分鐘 cache write = 基本輸入價 **1.25×**、1 小時 = **2×**、cache read = **0.1×**（Claude Opus 5.5 為 0.05×）。

所以：不切換時每輪只付少量 cache read；切換那一輪要付整段 context 的 cache write。

### 策略

| 時機 | 切換代價 | 策略 |
|---|---|---|
| session 第一個 prompt（`startup`） | 只有 system prompt + 工具定義 | ✅ 自由路由（可升可降） |
| `/clear` 之後 | context 已清空 | ✅ 自由路由 |
| compact 之後 | 內容換成摘要，本來就要重建 cache | ✅ 自由路由，並把摘要給分類器 |
| resume / fork 載入舊對話 | 舊 cache 多半已過期 | ✅ 自由路由，但對話太長不選 Haiku |
| 對話中途 | 整段重寫 cache | ⚠️ **只升不降**，信心 ≥ 0.8 才升 |

中途仍保留升級：原本的設計原則是「升級浪費成本」遠小於「降級導致錯誤」。中途突然出現高風險任務時，重建一次 cache 的錢通常比判斷錯誤便宜；而且第一個 prompt 常常不代表整個任務（例如「先看一下這個專案」）。

## 4. 運作流程與分類器

```
classic.SessionStart（source = startup / resume / clear / compact / fork）
   └─ 開啟「路由窗口」，記下 source
classic.PostCompact
   └─ 存下 compact_summary，給下一次分類當上下文
classic.PostModelSwitch（source = command / picker）
   └─ 使用者手動換過模型 → mod 不再干預，直到 /route auto

使用者送出 prompt → prompt.submit
   ├─ 已 /route 鎖定、或已手動 /model → 不分類
   ├─ 路由窗口開著 → 完整分類（可升可降）→ 關閉窗口
   └─ 路由窗口關著（對話中途）
         ├─ midSession = off，或目前已是 Opus → 不分類
         └─ 分類；結果較高且 confidence ≥ 0.8
               ├─ upgrade → 升級 + 通知
               └─ suggest → 只通知

每次 API 請求前 → turn.step
   ├─ 手動 /model、或 subagent（有 agentId）→ 不改寫
   └─ 主迴圈 → next({ ...e, model, effort })
```

分類只在 `prompt.submit` 跑一次，`turn.step` 只套用結果，所以一輪裡的多次工具呼叫不會重複分類。

### 分類器選擇

| 選項 | 延遲 | 成本 | 優點 | 缺點 | 狀態 |
|---|---|---|---|---|---|
| Haiku + router prompt | 約 1–2 秒 | 每次約 2–3k input tokens | 可放完整規則，輸出 rationale 便於除錯 | 每次分類多等一下 | ✅ 目前使用 |
| `$.model.classify(text, labels)` | 約 1 秒 | 更低 | 一行搞定 | 固定分類 prompt，無法放規則，沒有 effort 與 confidence | 未採用 |
| Jev（TypeSafe，經 OpenRouter） | 70–500 ms | 輸入 $0.042 / 百萬 tokens，輸出免費 | 最快、回傳必為合法型別、附機率可當 confidence | 需 OpenRouter key；需依官方文件設計 typed question | ❌ 尚未實作 |

來源：[What is Jev（DigitalOcean）](https://www.digitalocean.com/resources/articles/what-is-jev)、[Jev on OpenRouter](https://openrouter.ai/typesafe/jev-1.13/api)。數字取自這些頁面，未實測。

分類器呼叫次數：`midSession: off` 時，每個 session 只有開始、`/clear`、compact、resume 時各一次；`upgrade` / `suggest` 時中途每句都會分類（已是 Opus 時跳過）。

## 5. 已知限制

1. **中途升級仍會重建一次 cache**：刻意保留的代價。升級太頻繁時調高 `UPGRADE_CONFIDENCE`，或改 `midSession: suggest`。
2. **effort 變更是否影響 cache 未驗證**：中途升級通常同時改 effort；思考相關參數改變是否使部分 cache 失效尚未實測。
3. **Haiku 不支援 effort**：mod 送 Haiku 時不帶 `effort`。
4. **Subagent 不路由**：`turn.step` 也會為 subagent 觸發（`e.agentId` 有值），目前一律不改寫，沿用 subagent 自己的設定。
5. **reload 會重設狀態**：模組變數在重新載入時歸零，視同新的路由窗口。要跨 reload 保留需改用 `$.state`。
6. **組織政策**：管理員限制可用模型時，改寫成不允許的模型會被拒絕。
7. **Early Access**：mod API 可能隨版本改變。
8. **Jev 未實作**。
9. **marketplace 安裝流程未在本機實測**；`--plugin-dir` 載入已實測。

## 6. 實作時踩到的 API 細節

型別與 `claude plugin validate` 幫忙抓到、而文件或印象中沒寫對的地方：

1. `turn.step` 是串流事件，hook 必須是 `async function* ($, e, next) { return yield* next(...) }`；寫成一般函式會被 validate 擋下。
2. `classic.PostModelSwitch` 沒有 `switch_reason`，實際欄位是 `source`（`command` / `picker` / `sdk` / `auto` / `resume`）。偵測使用者手動切換用 `command` 或 `picker`。
3. `turn.step` 送出完整 model ID（`claude-opus-5-5` 等），不用別名。
4. `/route auto` 之後的那一句走「窗口內」完整分類（可降級），不是中途的只升不降——這是使用者主動要求的。
5. 逾時計時器要處理 rejection，否則計時器出錯時會出現未處理的 rejection。
6. 測試裡的假模型回覆要包成 `{ value: ... }`，且 `prompt.submit` 的輸入需要 `wait` 與 `origin` 欄位。

## 7. 驗證紀錄

- `claude plugin validate`、TypeScript 型別檢查、`claude plugin test`（19/19）皆通過。
- 實機（Claude Code v2.1.291、Windows 11、預設模型 Opus 5.5）三個新 session 的第一句 prompt：
  - 潤飾 Slack 訊息 → 🟢 haiku
  - FastAPI 登入端點 → 🟡 sonnet · medium
  - 高併發秒殺系統網路分區分析 → 🔴 opus · xhigh

  截圖見 [`images/`](images/)。實機紀錄只有這三張（新 session 第一句）；compact / resume / 中途升級 / `/route` 目前只有單元與整合測試，沒有實機紀錄。
