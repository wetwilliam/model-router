import type { EngineInterface, Register } from 'claude-code'

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

export const register: Register = (on, options) => {
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
    $.ui.status(router.status())
    return next(e)
  })

  on('command.run', { command: 'route' }, ($, e) => {
    const text = router.command(e.args)
    $.ui.status(router.status())
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
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
