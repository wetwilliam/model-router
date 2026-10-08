import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_GUARD, Guard, parseRelevance, RELEVANCE_SYSTEM, relevanceInput } from './guard'
import type { Relevance } from './guard'
import { ROUTER_SYSTEM } from './prompt'
import { parseClassification, Router } from './router'
import type { Classified, MidSession, SessionEvent } from './router'

const CLASSIFY_TIMEOUT_MS = 4000 // 分類逾時就沿用目前路由

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
  const router = new Router(mid === 'suggest' || mid === 'off' ? (mid as MidSession) : 'upgrade')

  on('classic.SessionStart', ($, e, next) => {
    router.onSessionStart(e.source)
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
        const canClear = !e.attachments?.length && !/(^|\s)@\S/.test(e.text)
        const q = guard.decide(m, rel, canClear)
        note(`「${e.text.slice(0, 12)}」 src=${source} tokens=${m.tokens} percent=${m.percent} messages=${messages.length} relevance=${rel ? `${rel.related}@${rel.confidence}` : '未偵測/失敗'} canClear=${canClear} → ${q ? `詢問(${q.reason})` : '不詢問'}`)
        if (q) {
          const answer = await $.ui.ask(q.question, { options: q.options, header: q.header })
          const choice = guard.choice(answer)
          if (choice === 'clear') {
            await $.command.run({ command: 'clear' })
            guard.reset()
            void $.prompt.submit({ text: e.text, asUser: true }) // 清除後原樣重送，router 會在新窗口重新分類
            return { drop: '已清除對話，正在重新送出你的訊息' }
          }
          if (choice === 'compact') {
            await $.session.compact()
            guard.reset()
          } else if (q.reason === 'size') {
            guard.declined(m)
          }
        }
      } catch (err) {
        // 被取消、逾時或 API 出錯：照常送出，但把原因留給 /guard 診斷
        note(`例外（已放行）：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      note(`略過：來源 ${e.origin.kind}${e.text.startsWith('/') ? '、斜線指令' : ''}「${e.text.slice(0, 12)}」`)
    }

    const pending = router.pending()
    if (pending) {
      try {
        const event: SessionEvent = pending.event
        const out = await classify($, router.classifierInput(e.text, event))
        const messageCount = event === 'resume' ? (await $.session.messages()).length : 0
        const { toast } = router.applyClassification(pending, out, messageCount)
        if (toast) $.ui.toast(toast)
      } catch {
        // 分類器出錯絕不影響主流程：沿用目前路由
      }
      $.ui.status(router.status())
    }
    router.finishPrompt(e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const override = router.step(e.agentId)
    return yield* next(override ? { ...e, ...override } : e)
  })
}
