# 貢獻指南

## 開發環境

- Claude Code **v2.1.291 以上**（終端機版）與 Node.js
- 在 repo 根目錄用 `--plugin-dir` 載入開發版：

```powershell
claude --plugin-dir ".\model-router"
```

第一次載入時，引擎會把 API 型別寫進 `model-router/.claude-plugin/types/`（已被 `.gitignore` 排除）。型別檢查靠這個資料夾，所以**先載入過一次才能跑 `npm run typecheck`**。
以 `--plugin-dir` 載入的資料夾，互動式 session 會監看檔案；修改後若沒有自動重新載入，執行 `/reload-plugins`。

## 指令

```bash
npm run check      # validate + validate:marketplace + typecheck + test
npm run validate   # claude plugin validate model-router
npm run typecheck  # tsc -p model-router（需要先載入過一次）
npm test           # claude plugin test model-router
```

## 程式結構

| 檔案 | 職責 | 修改時注意 |
|---|---|---|
| `hooks/prompt.ts` | router prompt | 改了分類規則，要同步更新 `docs/design.md` 的說明 |
| `hooks/router.ts` | 路由狀態機：何時分類、如何套用結果 | **不要碰 `$`**。保持純邏輯，才能用單元測試覆蓋 |
| `hooks/register.ts` | 引擎事件 ↔ 狀態機的膠水 | 越薄越好；新行為先放進 `router.ts` 再接線 |
| `tests/router.test.ts` | 規則測試 + 經過引擎的整合測試 | 改規則就要改測試 |

## 修改規則前先看這幾點

1. **「中途不降級」是刻意的。** 換模型會讓 prompt cache 失效，原因與數字見 [設計文件 §3](docs/design.md#3-路由時機與-cache-成本)。要放寬請附成本分析。
2. **分類器失敗不能影響使用者。** `register.ts` 的 `prompt.submit` 一律 try/catch，失敗就沿用目前路由。
3. **`turn.step` 是串流事件**，hook 必須是 `async function*`。寫成一般函式 `claude plugin validate` 會擋下。
4. **不要假設事件欄位。** 寫之前到 `model-router/.claude-plugin/types/claude-code/index.d.ts` 搜尋型別。已踩過的例子：`PostModelSwitch` 沒有 `switch_reason`，實際欄位是 `source`。

## 調整 router prompt

1. 改 `hooks/prompt.ts`。
2. 用真實 prompt 手動試（`claude --plugin-dir`），觀察狀態列判斷是否合理。
3. 把新的邊界案例加進 prompt 的 `# Examples`，並在 `tests/router.test.ts` 補對應的規則測試（若涉及規則而非 prompt 文字）。
4. 在 `CHANGELOG.md` 記一筆。

> 目前 prompt 沒有自動化的準確率評估（需要真的呼叫模型）。若要做，建議建立一份「prompt → 預期層級」的標註資料集，與單元測試分開跑。

## Commit 與版本

- 訊息用簡短祈使句，中英文皆可。
- 變更使用者可見行為時，同步更新 `plugin.json` 的 `version` 與 `CHANGELOG.md`。
- 發 PR 前確認 `npm run check` 通過。

## 回報問題時請附上

- Claude Code 版本（`claude --version`）
- 觸發問題的 prompt 與狀態列截圖
- `claude --debug` 裡與 `model-router` 相關的行
