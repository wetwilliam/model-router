import type { EngineInterface, Register } from 'claude-code'

import {
  AnswerCheck,
  JUDGE_SYSTEM,
  costLine,
  estimateUsd,
  judgeInput,
  parseJudgment,
  tokensOf,
} from './check'
import type { CostKind, Judgment, Rule, TokenUsage } from './check'
import { DEFAULT_GUARD, Guard, parseRelevance, RELEVANCE_SYSTEM, relevanceInput } from './guard'
import type { Relevance } from './guard'
import { ROUTER_SYSTEM } from './prompt'
import { DIFFICULTY_ROUTES, MODEL, describe, escalate, parseClassification, parseRouteSpec, Router } from './router'
import type { Classified, MidSession, SessionEvent } from './router'

const CLASSIFY_TIMEOUT_MS = 4000 // 分類逾時就沿用目前路由
// prompt.submit hook 還沒回傳時，引擎會拒絕 compact / 執行指令（host check：「it would compact under the turn
// this hook is holding」）。所以守衛先擋下訊息，等這段時間讓 hook 確實回傳，再執行 /compact 或 /clear
const AFTER_DROP_MS = 100

async function classify($: EngineInterface, input: string): Promise<Classified | undefined> {
  const stop = new AbortController()
  $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => stop.abort(),
    () => {}, // 計時器失敗就不設逾時，不影響分類
  )
  const r = await $.model.complete(
    { model: 'haiku', effort: 'low', maxTokens: 300, system: ROUTER_SYSTEM, prompt: input },
    { signal: stop.signal },
  )
  return r.isAnswered ? parseClassification(r.text) : undefined
}

async function checkRelevance($: EngineInterface, input: string): Promise<Relevance | undefined> {
  const stop = new AbortController()
  $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => stop.abort(),
    () => {},
  )
  const r = await $.model.complete(
    { model: 'haiku', effort: 'low', maxTokens: 60, system: RELEVANCE_SYSTEM, prompt: input },
    { signal: stop.signal },
  )
  return r.isAnswered ? parseRelevance(r.text) : undefined
}

const COST_LOG = 'cost.jsonl'
const COST_LOG_MAX_BYTES = 3_000_000

function logStep(
  $: EngineInterface,
  router: Router,
  kind: CostKind,
  model: string,
  effort: unknown,
  usage: TokenUsage | null | undefined,
  escalated: boolean,
  rules?: Rule[],
  judgment?: Judgment,
) {
  return appendCost(
    $,
    costLine({
      ts: new Date().toISOString(),
      kind,
      model,
      effort: typeof effort === 'string' ? effort : undefined,
      difficulty: router.difficulty,
      ...tokensOf(usage),
      usd_estimate: estimateUsd(model, usage),
      escalated,
      rules,
      judge_ok: judgment?.ok,
      judge_confidence: judgment?.confidence,
    }),
  )
}

async function appendCost($: EngineInterface, line: string) {
  try {
    const path = `${$.plugin.root}/${COST_LOG}`
    if (await $.fs.exists(path)) {
      if ((await $.fs.stat(path)).size > COST_LOG_MAX_BYTES) return
      const prev = await $.fs.read(path)
      const body = prev === '' || prev.endsWith('\n') ? prev : `${prev}\n`
      await $.fs.write(path, `${body}${line}\n`)
    } else {
      await $.fs.write(path, `${line}\n`)
    }
  } catch {
    // 記帳失敗不能擋住這輪
  }
}

async function judge(
  $: EngineInterface,
  prompt: string,
  answer: string,
  rules: Rule[],
): Promise<Judgment | undefined> {
  const stop = new AbortController()
  $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => stop.abort(),
    () => {},
  )
  const r = await $.model.complete(
    { model: 'haiku', effort: 'low', maxTokens: 80, system: JUDGE_SYSTEM, prompt: judgeInput(prompt, answer, rules) },
    { signal: stop.signal },
  )
  const parsed = r.isAnswered ? parseJudgment(r.text) : undefined
  const usage: TokenUsage | undefined = r.usage
  await appendCost(
    $,
    costLine({
      ts: new Date().toISOString(),
      kind: 'judge',
      model: 'haiku',
      effort: 'low',
      ...tokensOf(usage),
      usd_estimate: estimateUsd('haiku', usage),
      escalated: false,
      rules,
      judge_ok: parsed?.ok,
      judge_confidence: parsed?.confidence,
    }),
  )
  return parsed
}

/** 路由窗口開著或對話中途時，替這句分類並套用 */
async function routePrompt($: EngineInterface, router: Router, text: string) {
  const pending = router.pending()
  if (pending) {
    try {
      const event: SessionEvent = pending.event
      const out = await classify($, router.classifierInput(text, event))
      const messageCount = event === 'resume' ? (await $.session.messages()).length : 0
      const { toast } = router.applyClassification(pending, out, messageCount)
      if (toast) $.ui.toast(toast)
    } catch {
      // 分類器出錯絕不影響主流程：沿用目前路由
    }
    $.ui.status(router.status())
  }
  router.finishPrompt(text)
}

const NL = String.fromCharCode(10)
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

export const register: Register = (on, options) => {
  const guard = new Guard({
    ...DEFAULT_GUARD,
    percent: num(options.guardPercent, DEFAULT_GUARD.percent),
    tokens: num(options.guardTokens, DEFAULT_GUARD.tokens),
    relevance: String(options.relevance ?? 'on') !== 'off',
  })
  const guardLog: string[] = []
  const note = (line: string) => {
    guardLog.push(line)
    if (guardLog.length > 5) guardLog.shift()
  }
  const mid = String(options.midSession ?? 'upgrade')
  const spec = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const router = new Router(mid === 'suggest' || mid === 'off' ? (mid as MidSession) : 'upgrade', {
    easy: parseRouteSpec(spec(options.easyRoute), DIFFICULTY_ROUTES.easy),
    hard: parseRouteSpec(spec(options.hardRoute), DIFFICULTY_ROUTES.hard),
    obscure: parseRouteSpec(spec(options.obscureRoute), DIFFICULTY_ROUTES.obscure),
  })
  const checker = new AnswerCheck()

  on('classic.SessionStart', ($, e, next) => {
    router.onSessionStart(e.source)
    if (e.source === 'startup' || e.source === 'clear' || e.source === 'compact') checker.resetLengths()
    return next(e)
  })

  on('classic.PostCompact', ($, e, next) => {
    router.onCompact(e.compact_summary)
    return next(e)
  })

  on('classic.PostModelSwitch', ($, e, next) => {
    // 使用者自己 /model 換模型 → 尊重使用者，mod 不再改寫，直到 /route auto
    if (e.source === 'command' || e.source === 'picker') {
      router.onUserModelSwitch()
      $.ui.status(router.status())
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: '鎖定模型：/route opus|sonnet|haiku [effort]；/route auto 恢復自動並重新分類下一句',
    })
    await $.command.register({
      name: 'guard',
      description: '顯示上下文守衛的設定與最近一次評估結果（診斷用）',
    })
    $.ui.status(router.status())
    return next(e)
  })

  on('command.run', { command: 'guard' }, () => {
    const c = guard.cfg
    const cfg = `門檻：使用率 ≥ ${c.percent}% 或 tokens ≥ ${c.tokens}；相關性偵測 ${c.relevance ? 'on' : 'off'}（context ≥ ${c.relevanceMinTokens} tokens、信心 ≥ ${c.relevanceConfidence}）`
    const raw = `options 原始值：guardPercent=${String(options.guardPercent)} guardTokens=${String(options.guardTokens)} relevance=${String(options.relevance)}`
    const history = guardLog.length ? guardLog.join(NL) : '（尚未評估：還沒有送出過一句使用者訊息）'
    return { text: ['上下文守衛（已載入）', cfg, raw, '最近評估（舊→新）：', history].join(NL) }
  })

  on('command.run', { command: 'route' }, ($, e) => {
    const text = router.command(e.args)
    $.ui.status(router.status())
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    checker.startTurn()
    // 上下文守衛：只攔使用者自己在終端機送的訊息；任何錯誤都放行
    if (e.origin.kind === 'composer' && !e.text.startsWith('/')) {
      try {
        const usage = (await $.session.usage()).context
        const messages = await $.session.messages()
        // usage().context.tokens 在「目前視窗的第一次回應」之前是空的（剛開機、剛 compact、resume 後）；
        // 這時改用本地估算的 breakdown 補上
        let m: { tokens?: number; percent?: number } = usage
        let source = 'usage'
        if (usage.tokens === undefined) {
          const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
          if (b) {
            m = { tokens: b.totalTokens, percent: b.percentage }
            source = 'breakdown'
          }
        }
        const rel = guard.shouldCheckRelevance(m, messages.length)
          ? await checkRelevance($, relevanceInput(messages, e.text)).catch(() => undefined)
          : undefined
        // 重送時 @檔案 不會展開、圖片會遺失，所以帶著它們的訊息不能自動重送
        const canResend = !e.attachments?.length && !/(^|\s)@\S/.test(e.text)
        const q = guard.decide(m, rel, canResend)
        note(`「${e.text.slice(0, 12)}」 src=${source} tokens=${m.tokens} percent=${m.percent} messages=${messages.length} relevance=${rel ? `${rel.related}@${rel.confidence}` : '未偵測/失敗'} canResend=${canResend} → ${q ? `詢問(${q.reason})` : '不詢問'}`)
        if (q) {
          const answer = await $.ui.ask(q.question, { options: q.options, header: q.header })
          const choice = guard.choice(answer)
          if (choice !== 'continue') {
            // 在這個 hook 裡 compact / clear 會被引擎拒絕：先擋下這句，hook 回傳後再執行指令並重送
            const text = e.text
            const verb = choice === 'clear' ? '清除' : '壓縮'
            void $.clock.sleep(AFTER_DROP_MS)
              .then(async () => {
                try {
                  await $.command.run({ command: choice })
                  note(`已執行 /${choice}`)
                } catch (err) {
                  note(`/${choice} 失敗：${err instanceof Error ? err.message : String(err)}`)
                  $.ui.toast(`/${choice} 沒有執行成功，原因見 /guard`)
                }
                guard.reset()
                if (canResend) {
                  // 外掛自己送的 prompt 不會再經過這個 hook，所以先在這裡替新窗口分類
                  await routePrompt($, router, text)
                  await $.prompt.submit({ text, asUser: true })
                } else {
                  await $.prompt.fill({ text })
                  $.ui.toast(`已${verb}。訊息含 @檔案或圖片，無法自動重送：文字已放回輸入框，按 Enter 送出（圖片需重新貼上）`)
                }
              })
              .catch((err) => {
                note(`重送失敗，文字放回輸入框：${err instanceof Error ? err.message : String(err)}`)
                $.prompt.fill({ text }).catch(() => {})
              })
            return { drop: `正在${verb}對話，完成後會自動重新送出你的訊息` }
          }
          if (q.reason === 'size') guard.declined(m)
        }
      } catch (err) {
        // 被取消、逾時或 API 出錯：照常送出，但把原因留給 /guard 診斷
        note(`例外（已放行）：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      note(`略過：來源 ${e.origin.kind}${e.text.startsWith('/') ? '、斜線指令' : ''}「${e.text.slice(0, 12)}」`)
    }

    await routePrompt($, router, e.text)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result && result.isError === true) checker.noteError(result.text ?? JSON.stringify(result.result ?? ''))
    } catch {
      // 記錯誤簽名失敗不能影響工具結果
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const override = router.step(undefined)
    const sent = override ? { ...e, ...override } : e
    const result = yield* next(sent)
    const model = result.usage?.model ?? sent.model
    const final = result.stopReason === 'end_turn' && result.toolUses.length === 0
    let rules: Rule[] = []
    let judgment: Judgment | undefined
    if (final && !router.userModel && !router.pinned && !checker.escalated) {
      rules = checker.hits(router.lastPrompt, result.answer)
      if (rules.length) {
        judgment = await judge($, router.lastPrompt, result.answer, rules).catch(() => undefined)
        const up = checker.shouldRetry(judgment) ? escalate(router.current, router.routes.hard) : undefined
        if (up) {
          checker.escalated = true
          try {
            const retry = yield* next({ ...e, model: MODEL[up.tier], effort: up.effort })
            router.current = { tier: up.tier, effort: up.effort }
            $.ui.status(router.status())
            $.ui.toast(`答案未通過檢查，已改以 ${describe(router.current)} 重試一次`)
            await logStep($, router, 'answer', model, sent.effort, result.usage, false, rules, judgment)
            await logStep($, router, 'retry', retry.usage?.model ?? MODEL[up.tier], up.effort, retry.usage, true, rules, judgment)
            checker.noteLength(retry.answer.length)
            return retry
          } catch {
            // 重試失敗就留下原來的回答
          }
        }
      }
      // 被判不行的回答不寫進「正常長度」，避免門檻被壞答案拉高
      if (!checker.escalated && judgment?.ok !== false) checker.noteLength(result.answer.length)
    }
    await logStep($, router, final ? 'answer' : 'step', model, sent.effort, result.usage, false, rules, judgment)
    return result
  })
}
