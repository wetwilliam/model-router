import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MODEL, parseClassification, Router } from '../hooks/router'
import type { Classified, Tier } from '../hooks/router'

const c = (tier: Tier, confidence: number, effort?: Classified['route']['effort']): Classified => ({
  route: { tier, effort },
  confidence,
})

// 讓 router 跑一句 prompt（分類結果由測試直接給）
function submit(router: Router, out: Classified | undefined, messageCount = 0) {
  const pending = router.pending()
  const outcome = pending ? router.applyClassification(pending, out, messageCount) : {}
  router.finishPrompt('x')
  return { pending, outcome }
}

describe('parseClassification', () => {
  test('解析正常 JSON，Haiku 不帶 effort', () => {
    const r = parseClassification('{"risk_tier":"TIER_3_HAIKU","effort":"low","confidence":0.9}')
    expect(r).toEqual({ route: { tier: 'TIER_3_HAIKU', effort: undefined }, confidence: 0.9, rationale: undefined })
  })
  test('容忍前後多餘文字與 ```json 框', () => {
    const r = parseClassification('```json\n{"risk_tier":"TIER_1_OPUS","effort":"xhigh","confidence":0.95}\n```')
    expect(r?.route).toEqual({ tier: 'TIER_1_OPUS', effort: 'xhigh' })
  })
  test('不合法的 tier 或非 JSON 回傳 undefined', () => {
    expect(parseClassification('{"risk_tier":"GPT"}')).toBeUndefined()
    expect(parseClassification('我覺得用 Opus')).toBeUndefined()
  })
})

describe('路由窗口（startup / clear / compact / resume）', () => {
  test('startup 判成 Haiku → 送 haiku、不帶 effort', () => {
    const r = new Router()
    submit(r, c('TIER_3_HAIKU', 0.9))
    expect(r.step(undefined)).toEqual({ model: MODEL.TIER_3_HAIKU, effort: undefined })
  })
  test('窗口內低信心往上升一級', () => {
    const r = new Router()
    submit(r, c('TIER_3_HAIKU', 0.4))
    expect(r.current).toEqual({ tier: 'TIER_2_SONNET', effort: 'medium' })
  })
  test('compact 後可以降級', () => {
    const r = new Router()
    submit(r, c('TIER_1_OPUS', 0.9, 'high'))
    r.onSessionStart('compact')
    submit(r, c('TIER_3_HAIKU', 0.9))
    expect(r.current.tier).toBe('TIER_3_HAIKU')
  })
  test('resume 長對話不選 Haiku', () => {
    const r = new Router()
    submit(r, c('TIER_2_SONNET', 0.9, 'medium'))
    r.onSessionStart('resume')
    submit(r, c('TIER_3_HAIKU', 0.9), 120)
    expect(r.current).toEqual({ tier: 'TIER_2_SONNET', effort: 'low' })
  })
  test('分類失敗時沿用目前路由，窗口關閉', () => {
    const r = new Router()
    submit(r, undefined)
    expect(r.current).toEqual({ tier: 'TIER_2_SONNET', effort: 'medium' })
    expect(r.window).toBeUndefined()
  })
})

describe('對話中途（只升不降）', () => {
  test('中途判成 Haiku 不降級', () => {
    const r = new Router()
    submit(r, c('TIER_2_SONNET', 0.9, 'medium'))
    submit(r, c('TIER_3_HAIKU', 0.99))
    expect(r.current.tier).toBe('TIER_2_SONNET')
  })
  test('中途升級需要信心 ≥ 0.8', () => {
    const r = new Router()
    submit(r, c('TIER_2_SONNET', 0.9, 'medium'))
    submit(r, c('TIER_1_OPUS', 0.7, 'xhigh'))
    expect(r.current.tier).toBe('TIER_2_SONNET')
    const { outcome } = submit(r, c('TIER_1_OPUS', 0.9, 'xhigh'))
    expect(r.current).toEqual({ tier: 'TIER_1_OPUS', effort: 'xhigh' })
    expect(outcome.toast).toMatch(/已升級/)
  })
  test('已是 Opus 時中途不呼叫分類器', () => {
    const r = new Router()
    submit(r, c('TIER_1_OPUS', 0.9, 'high'))
    expect(r.pending()).toBeUndefined()
  })
  test('midSession=suggest 只提示不切換', () => {
    const r = new Router('suggest')
    submit(r, c('TIER_2_SONNET', 0.9, 'medium'))
    const { outcome } = submit(r, c('TIER_1_OPUS', 0.9, 'xhigh'))
    expect(r.current.tier).toBe('TIER_2_SONNET')
    expect(outcome.toast).toBe('建議升級：/route opus xhigh')
  })
  test('midSession=off 中途不分類', () => {
    const r = new Router('off')
    submit(r, c('TIER_2_SONNET', 0.9, 'medium'))
    expect(r.pending()).toBeUndefined()
  })
})

describe('手動優先', () => {
  test('/route opus high 鎖定，且不再分類', () => {
    const r = new Router()
    expect(r.command('opus high')).toMatch(/已鎖定/)
    expect(r.pending()).toBeUndefined()
    expect(r.step(undefined)).toEqual({ model: MODEL.TIER_1_OPUS, effort: 'high' })
  })
  test('/route 錯誤參數顯示用法', () => {
    expect(new Router().command('gpt')).toMatch(/用法/)
    expect(new Router().command('opus turbo')).toMatch(/用法/)
  })
  test('使用者 /model 後不改寫；/route auto 恢復並完整重新分類（可降級）', () => {
    const r = new Router()
    submit(r, c('TIER_1_OPUS', 0.9, 'high'))
    r.onUserModelSwitch()
    expect(r.step(undefined)).toBeUndefined()
    r.command('auto')
    submit(r, c('TIER_3_HAIKU', 0.9))
    expect(r.current.tier).toBe('TIER_3_HAIKU')
  })
  test('subagent 不改寫', () => {
    const r = new Router()
    expect(r.step('agent-1')).toBeUndefined()
  })
})

// ---------- 透過引擎的整合測試 ----------

const say = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const reply = (json: object) => ({
  isAnswered: true as const,
  text: JSON.stringify(json),
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

function engineBottom(on: On, classifierReplies: object[]) {
  const sent: { model: string; effort?: unknown }[] = []
  let classifierCalls = 0
  on('model.complete', () => ({ value: reply(classifierReplies[Math.min(classifierCalls++, classifierReplies.length - 1)]!) }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { sent, calls: () => classifierCalls }
}

async function step($: Engine, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    // drain
  }
  return s.result
}

test('引擎：startup 分類成 Haiku，主迴圈請求改送 Haiku，subagent 不動', async ($, on) => {
  const bottom = engineBottom(on, [{ risk_tier: 'TIER_3_HAIKU', effort: null, confidence: 0.9 }])
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(say('把這段 YAML 轉成 JSON'))
  await step($)
  await step($, 'agent-1')
  expect(bottom.sent[0]).toEqual({ model: MODEL.TIER_3_HAIKU, effort: undefined })
  expect(bottom.sent[1]?.model).toBe('claude-opus-5-5')
})

test('引擎：中途高信心升級到 Opus，之後已是 Opus 不再分類', async ($, on) => {
  const bottom = engineBottom(on, [
    { risk_tier: 'TIER_2_SONNET', effort: 'medium', confidence: 0.9 },
    { risk_tier: 'TIER_1_OPUS', effort: 'xhigh', confidence: 0.9 },
  ])
  await $.classic.SessionStart({ source: 'startup' })
  await $.prompt.submit(say('幫 UserService 補單元測試'))
  await $.prompt.submit(say('上線後資料庫有資料被覆蓋，幫我查'))
  await $.prompt.submit(say('繼續'))
  await step($)
  expect(bottom.sent[0]).toEqual({ model: MODEL.TIER_1_OPUS, effort: 'xhigh' })
  expect(bottom.calls()).toBe(2)
})
