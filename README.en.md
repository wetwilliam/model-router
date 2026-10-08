# model-router

**A Claude Code mod that picks the model (Opus / Sonnet / Haiku) and effort level for you, based on each prompt.**

Polishing a message → Haiku. Writing a feature → Sonnet. Chasing a nasty bug → Opus. No more manual `/model`.

[繁體中文](README.md) · [Design doc (zh-TW)](docs/design.md) · [Contributing](CONTRIBUTING.md)

> ⚠️ This is a Claude Code **mod**. The mod API is **early access** and may change between releases.
> Developed and tested on Claude Code **v2.1.291**.

## What it looks like

Each screenshot is a fresh session that starts on Opus 5.5. After the first prompt, the status line shows the routed model and effort.

| 🟢 Polish a message → Haiku | 🟡 Write an API endpoint → Sonnet · medium | 🔴 Distributed-systems analysis → Opus · xhigh |
|:---:|:---:|:---:|
| ![Haiku](docs/images/haiku-polish-message.png) | ![Sonnet medium](docs/images/sonnet-fastapi-login.png) | ![Opus xhigh](docs/images/opus-distributed-system.png) |

## How it works

| Tier | Model | Default effort | Typical work |
|---|---|---|---|
| 🔴 TIER_1 | Opus 5.5 | `high` (`xhigh` for root-cause debugging, security, architecture) | Hard debugging, concurrency, security review, refactors |
| 🟡 TIER_2 | Sonnet 5.5 | `medium` (`high` for multi-step reasoning) | Features, tests, data scripts, docs, code review |
| 🟢 TIER_3 | Haiku 4.5 | none | Format conversion, typo fixes, polishing, summaries, plain Q&A |

**Classification timing.** The prompt cache is per model, so switching mid-conversation re-writes the whole context into the new model's cache — the longer the conversation, the more it costs. The mod therefore classifies freely only when the cache is being rebuilt anyway (new session, `/clear`, after compact, on resume). In the middle of a conversation it **only upgrades**, and only when the classifier's confidence is ≥ 0.8. It never downgrades automatically.

Pricing per Anthropic: cache write 1.25× (5 min) / 2× (1 h) of base input price, cache read 0.1× (0.05× on Opus 5.5) — see [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Install

Requires Claude Code **v2.1.291+** (terminal).

**Try it without installing (tested):**

```powershell
git clone https://github.com/wetwilliam/model-router.git model-router-repo
claude --plugin-dir ".\model-router-repo\model-router"
```

**Install from the marketplace (per the official docs; not yet tested locally):**

```
/plugin install model-router --marketplace wetwilliam/model-router
```

## Use

- Status line shows e.g. `🟡 sonnet · medium`; `📌` = pinned with `/route`; `🧭 手動 /model` = you switched manually, the mod stays out of the way.
- `/route opus|sonnet|haiku [low|medium|high|xhigh|max]` pins a model; `/route auto` unpins and re-classifies the next prompt.
- Setting `midSession`: `upgrade` (default) · `suggest` (only a toast) · `off` (no classification mid-conversation).
- `/guard` shows the context guard's thresholds, settings and the last 5 evaluations (diagnostics).
- Never touched: models you pick with `/model`, subagents, and anything when classification fails or times out (the current route is kept).

## Context guard

Right model, wrong habit: a long conversation re-reads its whole history every turn. Before each prompt you type, the guard checks two things and, if needed, **asks** — it never clears or compacts on its own.

| Trigger | Options |
|---|---|
| The new prompt is **unrelated** to the recent conversation (Haiku verdict, confidence ≥ 0.8) | **Yes, clear** / **No, continue** |
| Context is **large** (≥ 200k tokens or ≥ 50% of the window) | **Compact** / **Clear** / **Continue** |
| Both | **Clear** / **Compact** / **Continue** (one question) |

- **Clear** runs `/clear` and re-submits your original prompt unchanged; the router re-classifies it in the fresh conversation.
- **Compact** runs a compaction, then your prompt goes through.
- **Continue** silences the size question until context grows another 10 points or 50k tokens.
- Relevance is only checked when context is ≥ 8k tokens and there is a real exchange. When unsure, the verdict is "related".
- Prompts with `@file` mentions or attachments get no "clear" option (a re-submit would lose them).
- Only your own prompts typed at the terminal are checked, not slash commands, plugins or background tasks.
- A timeout, Esc, or any error lets the prompt through untouched.

Settings (leave empty for defaults): `guardTokens` (`200000`; an absolute threshold, since 50% of a 1M window is too late), `guardPercent` (`50`), `relevance` (`on`; `off` skips the per-prompt Haiku call).

If `/guard` shows `tokens=undefined`, the engine reports no usage until the live window's first response; the guard then falls back to a local estimate (`src=breakdown`).

## Development

```bash
npm run check   # claude plugin validate + tsc + claude plugin test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [design doc](docs/design.md).

## Resources

- [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Model configuration](https://code.claude.com/docs/en/model-config) · [Plugins](https://code.claude.com/docs/en/plugins)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [claude-code-router](https://github.com/musistudio/claude-code-router) · [Pilot Shell model routing](https://pilot-shell.com/docs/features/model-routing) · [Issue #44976](https://github.com/anthropics/claude-code/issues/44976)
- Jev (not implemented yet): [DigitalOcean](https://www.digitalocean.com/resources/articles/what-is-jev) · [OpenRouter](https://openrouter.ai/typesafe/jev-1.13/api)

## License

[MIT](LICENSE)
