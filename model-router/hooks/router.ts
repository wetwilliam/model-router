// 路由狀態機：不碰 `$`，方便單元測試

export type Tier = 'TIER_1_OPUS' | 'TIER_2_SONNET' | 'TIER_3_HAIKU'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Route = { tier: Tier; effort?: Effort }
export type SessionEvent = 'startup' | 'clear' | 'compact' | 'resume' | 'mid'
export type MidSession = 'upgrade' | 'suggest' | 'off'
export type Classified = { route: Route; confidence: number; rationale?: string }

export const MODEL: Record<Tier, string> = {
  TIER_1_OPUS: 'claude-opus-5-5',
  TIER_2_SONNET: 'claude-sonnet-5-5',
  TIER_3_HAIKU: 'claude-haiku-4-5-20251001',
}
export const LABEL: Record<Tier, string> = {
  TIER_1_OPUS: '🔴 opus',
  TIER_2_SONNET: '🟡 sonnet',
  TIER_3_HAIKU: '🟢 haiku',
}
const ALIAS: Record<string, Tier> = { opus: 'TIER_1_OPUS', sonnet: 'TIER_2_SONNET', haiku: 'TIER_3_HAIKU' }
const RANK: Record<Tier, number> = { TIER_3_HAIKU: 0, TIER_2_SONNET: 1, TIER_1_OPUS: 2 }
const BY_RANK: readonly Tier[] = ['TIER_3_HAIKU', 'TIER_2_SONNET', 'TIER_1_OPUS']
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const DEFAULT_ROUTE: Route = { tier: 'TIER_2_SONNET', effort: 'medium' }
export const LOW_CONFIDENCE = 0.6     // 路由窗口內：低於此值往上升一級
export const UPGRADE_CONFIDENCE = 0.8 // 對話中途：至少這個信心才升級
export const HAIKU_MAX_MESSAGES = 40  // resume 的對話超過此訊息數就不選 Haiku

/** 解析分類器回覆的 JSON；格式不對回傳 undefined */
export function parseClassification(text: string): Classified | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const j = JSON.parse(match[0])
    if (!(j.risk_tier in RANK)) return undefined
    const tier = j.risk_tier as Tier
    const effort =
      tier !== 'TIER_3_HAIKU' && EFFORTS.includes(j.effort) ? (j.effort as Effort) : undefined
    const confidence = Number.isFinite(Number(j.confidence)) ? Number(j.confidence) : 0.5
    return { route: { tier, effort }, confidence, rationale: j.routing_rationale }
  } catch {
    return undefined
  }
}

export function describe(route: Route): string {
  return `${LABEL[route.tier]}${route.effort ? ` · ${route.effort}` : ''}`
}

export type PromptOutcome = { toast?: string }
export type Pending = { event: SessionEvent; inWindow: boolean }

export class Router {
  current: Route = DEFAULT_ROUTE
  pinned: Route | undefined         // /route 鎖定
  userModel = false                 // 使用者用 /model 手動換過 → 完全不干預
  window: SessionEvent | undefined = 'startup' // 有值 = 路由窗口開著
  compactSummary = ''
  lastPrompt = ''

  constructor(public midSession: MidSession = 'upgrade') {}

  onSessionStart(source: string) {
    // startup / resume / clear / compact / fork：cache 本來就要重建，開啟路由窗口
    if (source === 'fork') this.window = 'resume'
    else if (source === 'startup' || source === 'resume' || source === 'clear' || source === 'compact') this.window = source
  }

  onCompact(summary: string) {
    this.compactSummary = summary
  }

  onUserModelSwitch() {
    this.userModel = true
  }

  /** 這一句要不要分類、用哪個時機分類；undefined = 不分類 */
  pending(): Pending | undefined {
    if (this.pinned || this.userModel) return undefined
    if (this.window) return { event: this.window, inWindow: true }
    if (this.midSession === 'off' || this.current.tier === 'TIER_1_OPUS') return undefined
    return { event: 'mid', inWindow: false }
  }

  /** 組分類器的 user message */
  classifierInput(text: string, event: SessionEvent): string {
    const context = event === 'compact' ? this.compactSummary.slice(0, 4000) : this.lastPrompt.slice(0, 500)
    return (
      `<session_event>${event}</session_event>\n` +
      `<previous_tier>${this.current.tier}</previous_tier>\n` +
      `<recent_context>${context}</recent_context>\n` +
      `<user_request>\n${text.slice(0, 6000)}\n</user_request>`
    )
  }

  /** 套用分類結果；out 為 undefined（逾時、解析失敗）時沿用目前路由 */
  applyClassification(pending: Pending, out: Classified | undefined, messageCount: number): PromptOutcome {
    if (pending.inWindow) this.window = undefined
    if (!out) return {}
    return pending.inWindow
      ? this.routeInWindow(out, pending.event, messageCount)
      : this.upgradeMidSession(out)
  }

  finishPrompt(text: string) {
    this.lastPrompt = text
  }

  // 路由窗口內：可升可降
  private routeInWindow(out: Classified, event: SessionEvent, messageCount: number): PromptOutcome {
    let { tier, effort } = out.route

    if (out.confidence < LOW_CONFIDENCE && RANK[tier] < 2) {
      tier = BY_RANK[RANK[tier] + 1]!
      effort = tier === 'TIER_1_OPUS' ? 'high' : 'medium'
    }
    if (tier === 'TIER_3_HAIKU' && event === 'resume' && messageCount > HAIKU_MAX_MESSAGES) {
      tier = 'TIER_2_SONNET'
      effort = 'low'
    }
    this.current = { tier, effort: tier === 'TIER_3_HAIKU' ? undefined : effort }
    return {}
  }

  // 對話中途：只升不降
  private upgradeMidSession(out: Classified): PromptOutcome {
    const isHigher = RANK[out.route.tier] > RANK[this.current.tier]
    if (!isHigher || out.confidence < UPGRADE_CONFIDENCE) return {}

    if (this.midSession === 'suggest') {
      const alias = out.route.tier === 'TIER_1_OPUS' ? 'opus' : 'sonnet'
      return { toast: `建議升級：/route ${alias}${out.route.effort ? ` ${out.route.effort}` : ''}` }
    }
    this.current = out.route
    return { toast: `已升級為 ${describe(this.current)}（這一輪會重建 cache）` }
  }

  /** /route 指令；回傳要顯示的文字 */
  command(args: string): string {
    const [which, effort] = args.trim().split(/\s+/)
    if (!which || which === 'auto') {
      this.pinned = undefined
      this.userModel = false
      this.window = 'mid' // 下一句做一次完整分類（可升可降），使用者主動要求所以允許
      return '已恢復自動路由，下一句會重新分類'
    }
    const tier = ALIAS[which]
    if (!tier || (effort !== undefined && !EFFORTS.includes(effort))) {
      return '用法：/route opus|sonnet|haiku [low|medium|high|xhigh|max]，或 /route auto'
    }
    this.pinned = {
      tier,
      effort: tier === 'TIER_3_HAIKU' ? undefined : ((effort as Effort | undefined) ?? 'medium'),
    }
    this.userModel = false
    return `已鎖定 ${describe(this.pinned)}`
  }

  /** turn.step 要送出的 model / effort；undefined = 不改寫 */
  step(agentId: string | undefined): { model: string; effort?: Effort } | undefined {
    if (this.userModel || agentId) return undefined
    const r = this.pinned ?? this.current
    return { model: MODEL[r.tier], effort: r.effort }
  }

  status(): string {
    if (this.userModel) return '🧭 手動 /model'
    return `${describe(this.pinned ?? this.current)}${this.pinned ? ' 📌' : ''}`
  }
}
