/**
 * dsh-model-router — host half.
 *
 * Model Router & Cost Optimizer for DeepSeek Harness.
 *
 * Routing: every agent step is classified before dispatch (`agent/pre-step`:
 * tool-call depth + keyword + payload size heuristics) and the model for the
 * request is replaced through the `agent/request` waterfall — trivial steps
 * run on the cheap catalog model, agentic work stays on the strong one. The
 * chosen tier is sticky within a turn so the provider's prefix cache is not
 * thrashed by mid-turn flips (every model switch pays a full-miss rebuild of
 * that model's cache).
 *
 * Fallback: transient failures (RATE_LIMIT / SERVER / TIMEOUT /
 * EMPTY_RESPONSE) mark the agent degraded for the turn and return
 * `{ kind: 'retry' }`; the retry re-enters `agent/request` and lands on the
 * cheap model. At most one degradation per turn; everything else delegates to
 * the provider's own retry policy.
 *
 * Metering: a session projection (`modelRouter`) folds the durable log —
 * `request/header` events track the active provider/model and its changes,
 * `assistant/message` events accumulate real adapter token usage (including
 * cache read/write and reasoning tokens) and an estimated cost from a
 * model-class price table. Being a projection, the numbers are replay-safe
 * and survive cold sessions.
 *
 * Manual control: `/router auto|cheap|strong` slash command and the
 * model-visible `route_model` tool (the agent can switch its own tier).
 */
import z from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['llm', 'tools', 'sessionProjections', 'subagents']

const CHEAP_RE = /(flash|chat|mini|turbo|haiku|lite|air|nano)/i
const STRONG_RE = /(pro|reasoner|opus|sonnet|max|ultra|premium|r1)/i

/**
 * Estimated USD per 1M tokens, matched by model-id class. DeepSeek bills
 * cache hits separately from input. Edit freely — the panel labels the number
 * as an estimate.
 */
const PRICE_TABLE = [
  { test: CHEAP_RE, input: 0.27, output: 1.10, cacheHit: 0.07 },
  { test: STRONG_RE, input: 0.55, output: 2.19, cacheHit: 0.14 },
]

const RETRYABLE = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE']

const modelRecordSchema = z.object({
  calls: z.number(),
  inTokens: z.number(),
  outTokens: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
})

const projectionSchema = z.object({
  mode: z.string(),
  quickAnswers: z.number(),
  lastQuick: z.union([z.null(), z.object({
    seq: z.number(),
    turn: z.string(),
    model: z.string(),
    preview: z.string(),
  })]),
  current: z.union([z.null(), z.object({ provider: z.string(), model: z.string() })]),
  totals: z.object({
    calls: z.number(),
    inTokens: z.number(),
    outTokens: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    cost: z.number(),
  }),
  byModel: z.record(z.string(), modelRecordSchema),
  modelChanges: z.array(z.object({
    seq: z.number(),
    provider: z.string(),
    model: z.string(),
  })),
})

function priceFor(model) {
  for (const row of PRICE_TABLE) if (row.test.test(model)) return row
  return null
}

function usageCost(model, usage) {
  const price = priceFor(model)
  if (!price) return 0
  const input = usage.inputTokens || 0
  const output = usage.outputTokens || 0
  const cacheRead = usage.cacheReadTokens || 0
  // Harness TokenUsage is DISJOINT: inputTokens already excludes cache reads
  // (DeepSeek prompt_tokens = hit + miss; the adapter subtracts hits out).
  return (input / 1e6) * price.input
    + (cacheRead / 1e6) * price.cacheHit
    + (output / 1e6) * price.output
}

function newestText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  let text = ''
  for (const b of message.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') text += b.text + ' '
  }
  return text.trim()
}

function classify(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'auto'
  // Only the newest USER message decides the turn tier. Scanning the whole
  // step history lets old keywords dominate: a long agentic conversation
  // would never route a trivial follow-up question cheap. Mid-turn steps
  // end with assistant/tool messages — leave those to the sticky tier.
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return 'auto'
  const content = last.content
  let text = ''
  let toolBlocks = 0
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') text += b.text + ' '
      else if (b.type === 'tool-call' || b.type === 'tool-result') toolBlocks++
    }
  }
  let score = Math.min(toolBlocks, 8) * 0.5
  const strongWords = /(实现|重构|修复|调试|排查|设计|架构|优化|审计|迁移|评审|implement|refactor|debug|design|architect|migrate|audit|investigate|analy[sz]e)/gi
  const cheapWords = /(你好|什么是|是什么|什么意思|解释|总结|翻译|写首诗|讲个笑话|推荐|打招呼|hello|what is|explain|summarize|translate)/gi
  score += (text.match(strongWords) || []).length
  score -= (text.match(cheapWords) || []).length
  if (text.length > 4000) score += 1
  if (score >= 2) return 'strong'
  if (score <= -1) return 'cheap'
  return 'auto'
}

const emptyTotals = () => ({
  calls: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0,
})

export function apply(ctx) {
  // ---- live routing state (process-local; durable stats live in the projection) ----
  const state = {
    globalMode: 'auto',
    agentModes: new Map(), // agentId -> 'auto' | 'cheap' | 'strong'
    degraded: new Map(),   // agentId -> turn number where degraded began
    sticky: new Map(),     // agentId -> { turn, tier }
    preStep: new Map(),    // agentId -> { turn, tier }
    quickKids: new Set(),  // agentIds of quick-answer children (recursion guard)
    fallbacks: 0,
    baseModel: new Map(),  // agentId -> machine's original model
    provider: new Map(),   // agentId -> provider route
    catalogCache: new Map(),
  }

  async function getCatalog(provider) {
    const cached = state.catalogCache.get(provider)
    if (cached) return cached
    const entry = { cheap: null, strong: null }
    try {
      const models = await ctx.llm.listModels(provider)
      if (Array.isArray(models)) {
        for (const m of models) {
          const id = String((m && m.id) || '')
          if (!id) continue
          if (entry.cheap === null && CHEAP_RE.test(id) && !STRONG_RE.test(id)) entry.cheap = id
          if (entry.strong === null && STRONG_RE.test(id)) entry.strong = id
        }
      }
    } catch (error) {
      console.error(`dsh-model-router: model catalog failed for ${provider}: ${String(error)}`)
    }
    state.catalogCache.set(provider, entry)
    return entry
  }

  // ---- session projection: durable per-session stats folded from the log ----
  ctx.sessionProjections.register({
    key: 'modelRouter',
    schema: projectionSchema,
    init: () => ({ mode: 'auto', quickAnswers: 0, lastQuick: null, current: null, totals: emptyTotals(), byModel: {}, modelChanges: [] }),
    apply(state, event) {
      // SessionEvent shape: { type, seq, time, data: <payload>, ... } — the
      // payload lives under `data`.
      if (event.type === 'user/message') {
        // Quick-answer relay injections (our plugin-sourced context):
        // count them and remember the latest one for the toast.
        const msg = event.data
        if (msg && msg.source && msg.source.kind === 'plugin' && msg.source.plugin === 'dsh-model-router') {
          const id = String(msg.id || '')
          const prefix = 'mrtr-qa-'
          const turn = id.startsWith(prefix) && id.lastIndexOf('-') >= prefix.length
            ? id.slice(id.lastIndexOf('-') + 1)
            : ''
          const model = id.startsWith(prefix) && id.lastIndexOf('-') >= prefix.length
            ? id.slice(prefix.length, id.lastIndexOf('-'))
            : ''
          const texts = Array.isArray(msg.content)
            ? msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
            : []
          const preview = (texts.slice(1).join(' ').trim() || '').slice(0, 200)
          return {
            ...state,
            quickAnswers: state.quickAnswers + 1,
            lastQuick: { seq: Number(event.seq ?? 0), turn, model, preview },
          }
        }
        return state
      }
      if (event.type === 'request/header') {
        const cfg = event.data && event.data.header && event.data.header.config
        if (!cfg) return state
        const next = { provider: String(cfg.provider || ''), model: String(cfg.model || '') }
        const cur = state.current
        if (cur && cur.provider === next.provider && cur.model === next.model) return state
        const changes = state.modelChanges.length >= 40
          ? state.modelChanges.slice(-39)
          : state.modelChanges.slice()
        changes.push({ seq: Number(event.seq ?? 0), provider: next.provider, model: next.model })
        return { ...state, current: next, modelChanges: changes }
      }
      if (event.type === 'command/run' && event.data && event.data.name === 'router') {
        const args = String(event.data.args || '').trim().toLowerCase()
        const mode = ['auto', 'cheap', 'strong'].includes(args) ? args : null
        if (mode === null || state.mode === mode) return state
        return { ...state, mode }
      }
      if (event.type === 'assistant/message' && event.data && event.data.usage) {
        const u = event.data.usage
        const model = String((state.current && state.current.model) || 'unknown')
        const prev = state.byModel[model] || {
          calls: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        }
        const byModel = {
          ...state.byModel,
          [model]: {
            calls: prev.calls + 1,
            inTokens: prev.inTokens + (u.inputTokens || 0),
            outTokens: prev.outTokens + (u.outputTokens || 0),
            cacheRead: prev.cacheRead + (u.cacheReadTokens || 0),
            cacheWrite: prev.cacheWrite + (u.cacheWriteTokens || 0),
            reasoning: prev.reasoning + (u.reasoningTokens || 0),
          },
        }
        const totals = {
          calls: state.totals.calls + 1,
          inTokens: state.totals.inTokens + (u.inputTokens || 0),
          outTokens: state.totals.outTokens + (u.outputTokens || 0),
          cacheRead: state.totals.cacheRead + (u.cacheReadTokens || 0),
          cacheWrite: state.totals.cacheWrite + (u.cacheWriteTokens || 0),
          reasoning: state.totals.reasoning + (u.reasoningTokens || 0),
          cost: state.totals.cost + usageCost(model, u),
        }
        return { ...state, byModel, totals }
      }
      return state
    },
    view(state) {
      return state
    },
    stateVersion: 1,
  })

  // ---- classify each step; route cheap questions to a quick-answer child ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const agentId = String(payload.agent.id)
    try {
      const degTurn = state.degraded.get(agentId)
      if (degTurn !== undefined && degTurn !== payload.turn) state.degraded.delete(agentId)
    } catch (error) {
      console.error(`dsh-model-router: pre-step cleanup failed: ${String(error)}`)
    }

    const mode = state.agentModes.get(agentId) || state.globalMode
    if (mode !== 'auto') return next() // manual mode owns routing entirely
    if (state.quickKids.has(agentId)) return next() // never re-spawn from a child

    const tier = classify(payload.messages)
    if (tier === 'strong') {
      state.preStep.set(agentId, { turn: payload.turn, tier: 'strong' })
      return next()
    }
    if (tier !== 'cheap') return next()

    // Cheap question: answer it in a fresh quick-answer child on the cheap
    // model (zero prefix -> no cache-miss tax), then feed the answer back
    // into this conversation. The main session never flips model, so its
    // prefix cache stays intact.
    try {
      // Only genuine user turns: every claimed message must be user-sourced
      // (tool results / steering / our own relay injections are excluded).
      if (payload.messages.length === 0
        || !payload.messages.every((m) => m && m.source && m.source.kind === 'user')) return next()
      const question = newestText(payload.messages[payload.messages.length - 1])
      if (!question) return next()
      const provider = state.provider.get(agentId) || String(payload.agent.options?.provider || '')
      if (!provider) return next()
      const catalog = await getCatalog(provider)
      if (!catalog.cheap) return next()
      const subagentProviders = ctx.subagents.list()
      if (!Array.isArray(subagentProviders) || subagentProviders.length === 0) return next()

      const run = await ctx.subagents.start(subagentProviders[0], {
        label: 'quick-answer',
        prompt: [{
          type: 'text',
          text: 'Answer the following question directly and concisely. Do not use tools. Output only the answer.\n\n' + question,
        }],
        parent: payload.agent,
        signal: payload.signal,
        agentOptions: { provider, model: catalog.cheap },
      })
      state.quickKids.add(String(run.id))
      try {
        const result = await run.result
        const output = Array.isArray(result.output)
          ? result.output.filter((b) => b && b.type === 'text')
          : []
        if (result.stopReason === 'completed' && output.length > 0) {
          // Re-queue the original question (claim removed it from the inbox)
          // and the relay instruction, then reject this step so the main
          // model never answers the question itself.
          for (const message of payload.messages) payload.agent.inject(message)
          payload.agent.inject({
            id: `mrtr-qa-${catalog.cheap}-${payload.turn}`,
            role: 'user',
            content: [
              { type: 'text', text: `⚡ Quick-answer subagent (${catalog.cheap}, isolated session) already answered the question above. Reply to the user with that answer exactly as written — do not re-answer, add analysis, or call tools.` },
              ...output,
            ],
            source: { kind: 'plugin', plugin: 'dsh-model-router' },
          })
          console.log(`dsh-model-router: quick-answer #${payload.turn} via ${catalog.cheap}`)
          return { kind: 'reject' }
        }
      } finally {
        await run.dispose().catch(() => {})
        state.quickKids.delete(String(run.id))
      }
    } catch (error) {
      console.error(`dsh-model-router: quick-answer failed: ${String(error)}`)
    }
    return next()
  })

  // ---- the router itself ----
  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    if (!base || !base.provider || !base.model) return base
    const agentId = String(payload.agent.id)
    state.provider.set(agentId, base.provider)
    state.baseModel.set(agentId, base.model)
    const turn = payload.turn

    let tier = null
    let reason = null
    const mode = state.agentModes.get(agentId) || state.globalMode
    if (mode !== 'auto') { tier = mode; reason = 'manual' }
    else if (state.degraded.get(agentId) === turn) { tier = 'cheap'; reason = 'degraded' }
    else {
      const sticky = state.sticky.get(agentId)
      if (sticky && sticky.turn === turn) { tier = sticky.tier; reason = 'sticky' }
      else {
        const pre = state.preStep.get(agentId)
        if (pre && pre.turn === turn) { tier = pre.tier; reason = 'heuristic' }
      }
    }
    if (tier === null || tier === 'auto' || tier === 'base') return base

    const catalog = await getCatalog(base.provider)
    const target = tier === 'cheap' ? catalog.cheap : catalog.strong
    if (!target || target === base.model) {
      state.sticky.set(agentId, { turn, tier: 'base' })
      return base
    }
    state.sticky.set(agentId, { turn, tier })
    console.log(`dsh-model-router: #${turn} ${base.model} -> ${target} (${reason})`)
    return { ...base, model: target }
  })

  // ---- fallback on transient provider failures ----
  ctx.on('agent/request-error', async (payload, next) => {
    const code = payload.failure && payload.failure.code
    if (!code || !RETRYABLE.includes(code)) return next()
    try {
      const agentId = String(payload.agent.id)
      const turn = payload.turn
      if (state.degraded.get(agentId) === turn) return next()
      const provider = payload.provider || state.provider.get(agentId)
      if (!provider) return next()
      const catalog = await getCatalog(provider)
      const baseModel = state.baseModel.get(agentId)
      if (!catalog.cheap || (baseModel && catalog.cheap === baseModel)) return next()
      state.degraded.set(agentId, turn)
      state.fallbacks++
      console.log(`dsh-model-router: turn ${turn} degraded to ${catalog.cheap} after ${code}`)
      return { kind: 'retry' }
    } catch (error) {
      console.error(`dsh-model-router: fallback failed: ${String(error)}`)
      return next()
    }
  })

  ctx.on('llm/adapters-updated', () => { state.catalogCache.clear() })

  // ---- /router slash command: manual tier control ----
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'router',
      description: 'set the model routing tier for this session (auto | cheap | strong)',
      input: { hint: 'auto|cheap|strong' },
      handler: (invocation) => {
        const arg = String(invocation.rawInput || '').trim().toLowerCase()
        const tier = ['auto', 'cheap', 'strong'].includes(arg) ? arg : null
        if (tier === null) return { kind: 'error', text: 'usage: /router auto|cheap|strong' }
        const agentId = String(invocation.agent.id)
        state.agentModes.set(agentId, tier)
        return { kind: 'success', text: `model router tier set to "${tier}" for this session` }
      },
    })
  }

  // ---- route_model tool: the agent can switch its own tier ----
  ctx.tools.register(defineTool({
    name: 'route_model',
    description: 'Set the model tier used for the following steps of this session. cheap picks the cheapest catalog model (faster, lower cost), strong picks the strongest one, auto restores heuristic routing. Use when the task clearly deserves a stronger or cheaper model than the router is currently using.',
    parameters: {
      tier: {
        type: 'string',
        required: true,
        enum: ['auto', 'cheap', 'strong'],
        description: "Routing tier for this session: 'auto' heuristic, 'cheap' cheapest model, 'strong' strongest model.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tier: { type: 'string' },
          cheap: { type: 'string' },
          strong: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render(args, value) {
        const v = value || {}
        const summary = 'model router tier: ' + String(v.tier || '?')
          + (v.cheap ? ', cheap=' + v.cheap : '')
          + (v.strong ? ', strong=' + v.strong : '')
          + (v.note ? ' — ' + v.note : '')
        return [{ type: 'text', text: summary }]
      },
    },
    async execute(args, exec) {
      const tier = args && args.tier
      if (!['auto', 'cheap', 'strong'].includes(tier)) {
        return { tier: String(tier), cheap: null, strong: null, note: 'invalid tier; use auto | cheap | strong' }
      }
      const agent = exec && exec.agent
      if (!agent) {
        state.globalMode = tier
      } else {
        state.agentModes.set(String(agent.id), tier)
      }
      const provider = agent ? state.provider.get(String(agent.id)) : null
      const catalog = provider ? await getCatalog(provider) : { cheap: null, strong: null }
      return {
        tier,
        cheap: catalog.cheap,
        strong: catalog.strong,
        note: 'applies from the next model request; auto restores heuristic routing',
      }
    },
  }))
}
