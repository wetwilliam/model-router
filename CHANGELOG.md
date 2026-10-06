# Changelog

格式參考 [Keep a Changelog](https://keepachangelog.com/)，版本號依 `model-router/.claude-plugin/plugin.json`。

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
