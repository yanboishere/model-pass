import { Hono, type Context } from 'hono'
import {
  SLOT_INFO,
  hashToken,
  openProviderSecret,
  parseAccessToken,
  resolveRoute,
  sealProviderSecret,
  unwrapVaultKey,
  upstreamAuthHeaders,
  upstreamEndpoints,
  type GrantInfo,
  type ProviderSecret,
  type SlotId,
} from '@modelpass/core'
import { AnthropicStreamTranslator, anthropicToChat, chatToAnthropic } from '../relay/anthropic'
import { ResponsesStreamTranslator, chatToResponses } from '../relay/responses'
import { parseSse, sse, SSE_HEADERS } from '../relay/sse'
import { hasImageContent, toChatUsage, type ChatRequest, type FinishReason, type UsageCounts } from '../relay/types'
import { dayKey, now, type GrantRow, type StoredProvider } from '../store'
import { apiError, tokenSlots, type ApiFailure, type HubDeps } from '../util'

interface GrantContext {
  grant: GrantRow
  vk: Uint8Array
}

interface Upstream {
  slot: SlotId
  fallback: boolean
  provider: StoredProvider
  model: string
  secret: ProviderSecret
  credential: string | undefined
  /** Model name shown to the app (real model only if the user allows it). */
  shownModel: string
  headers: Record<string, string>
}

const fail = (status: number, code: ApiFailure['code'], message: string): ApiFailure => ({ status, code, message })
const isFailure = (v: unknown): v is ApiFailure => !!v && typeof v === 'object' && 'code' in v && 'status' in v && 'message' in v

export function apiRoutes(deps: HubDeps) {
  const { store, config } = deps
  const app = new Hono()
  const refreshLocks = new Map<string, Promise<ProviderSecret>>()

  // ---- authentication ------------------------------------------------------------------------------

  function authenticate(c: Context): GrantContext | ApiFailure {
    const auth = c.req.header('authorization') ?? ''
    const token = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : c.req.header('x-api-key') ?? '').trim()
    const secret = parseAccessToken(token)
    if (!secret) return fail(401, 'invalid_token', '缺少或无效的 ModelPass 访问令牌')
    const grant = store.getGrantByTokenHash(hashToken(token))
    if (!grant) return fail(401, 'invalid_token', '访问令牌无效')
    if (grant.status === 'revoked') return fail(401, 'grant_revoked', '用户已在 ModelPass 中撤销了该应用的授权')
    if (grant.status === 'paused') return fail(403, 'grant_paused', '用户已在 ModelPass 中暂停了该应用')
    if (grant.expiresAt && grant.expiresAt < now()) return fail(401, 'grant_expired', '授权已过期，请重新连接 ModelPass')
    try {
      return { grant, vk: unwrapVaultKey(grant.wrappedVk, secret, grant.id) }
    } catch {
      return fail(401, 'invalid_token', '访问令牌无效')
    }
  }

  function budgetCheck(grant: GrantRow): ApiFailure | { remaining: number | null } {
    const { tokensPerDay, requestsPerDay } = grant.budget
    if (!tokensPerDay && !requestsPerDay) return { remaining: null }
    const used = store.usageForDay(grant.id, dayKey(now()))
    if (requestsPerDay && used.requests >= requestsPerDay) return fail(429, 'budget_exceeded', `已达到今日请求次数上限（${requestsPerDay}）`)
    if (tokensPerDay && used.tokens >= tokensPerDay) return fail(429, 'budget_exceeded', `已达到今日 token 额度（${tokensPerDay}）`)
    return { remaining: tokensPerDay ? tokensPerDay - used.tokens : null }
  }

  // Subscription connectors (ChatGPT plan) carry short-lived OAuth tokens. The hub can refresh and
  // re-seal them only while a request (and therefore the vault key) is in flight.
  async function freshSecret(ctx: GrantContext, provider: StoredProvider, secret: ProviderSecret): Promise<ProviderSecret> {
    const o = secret.oauth
    if (!o || !o.refreshToken || !o.expiresAt || o.expiresAt - 120 > now()) return secret
    const key = `${ctx.grant.userId}/${provider.id}`
    const pending = refreshLocks.get(key)
    if (pending) return pending
    const job = (async () => {
      const res = await deps.fetch(o.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: o.clientId, refresh_token: o.refreshToken!, ...(o.resource ? { resource: o.resource } : {}) }),
      })
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
      const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
      const next: ProviderSecret = {
        ...secret,
        oauth: { ...o, accessToken: t.access_token, refreshToken: t.refresh_token ?? o.refreshToken, expiresAt: now() + (t.expires_in ?? 3600) },
      }
      store.updateProviderSealed(ctx.grant.userId, provider.id, sealProviderSecret(ctx.vk, ctx.grant.userId, provider.id, next))
      return next
    })().finally(() => refreshLocks.delete(key))
    refreshLocks.set(key, job)
    return job
  }

  async function selectUpstream(ctx: GrantContext, requested: string | undefined): Promise<Upstream | ApiFailure> {
    const { grant } = ctx
    const providers = store.listProviders(grant.userId)
    const route = resolveRoute(requested, {
      grantSlots: grant.slots,
      grantScope: grant.scope,
      grantRoutes: grant.routes,
      globalRoutes: store.getRoutes(grant.userId),
      allowedModels: grant.allowedModels,
      providers,
    })
    if (!route.target) return fail(503, 'no_route', `尚未在 ModelPass 中为「${SLOT_INFO[route.slot].label}」槽位选择模型`)
    const provider = providers.find((p) => p.id === route.target!.providerId)
    if (!provider?.sealed) return fail(503, 'no_route', '路由指向的厂商缺少凭据，请在 ModelPass 中重新保存')
    let secret: ProviderSecret
    try {
      secret = openProviderSecret(ctx.vk, grant.userId, provider.id, provider.sealed)
      secret = await freshSecret(ctx, provider, secret)
    } catch (e) {
      return fail(502, 'upstream_auth_failed', `无法解封或刷新厂商凭据：${(e as Error).message}`)
    }
    const shownModel = route.explicit || grant.shareModelInfo ? route.target.model : route.slot
    const headers: Record<string, string> = { 'x-modelpass-slot': route.slot }
    if (route.fallback) headers['x-modelpass-fallback'] = 'true'
    if (grant.shareModelInfo) {
      headers['x-modelpass-model'] = route.target.model
      headers['x-modelpass-provider'] = encodeURIComponent(provider.name)
    }
    return {
      slot: route.slot,
      fallback: route.fallback,
      provider,
      model: route.target.model,
      secret,
      credential: secret.oauth?.accessToken ?? secret.apiKey,
      shownModel,
      headers,
    }
  }

  function upstreamHeaders(up: Upstream, stream: boolean, extra?: Record<string, string>): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...upstreamAuthHeaders(up.provider.format, up.credential),
      ...(up.secret.headers ?? {}),
      ...(extra ?? {}),
    }
  }

  async function callUpstream(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response | ApiFailure> {
    try {
      return await deps.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.upstreamTimeoutMs)]),
      })
    } catch (e) {
      return fail(502, 'upstream_error', `无法连接上游：${(e as Error).message}`)
    }
  }

  async function upstreamFailure(res: Response, provider: StoredProvider): Promise<ApiFailure> {
    let message = `${res.status} ${res.statusText}`
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
        message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text.slice(0, 500)
      } catch {
        message = text.slice(0, 500) || message
      }
    } catch {
      // ignore
    }
    if (res.status === 401 || res.status === 403) {
      return fail(502, 'upstream_auth_failed', `「${provider.name}」拒绝了凭据，请在 ModelPass 中检查 Key：${message}`)
    }
    return fail(res.status >= 500 ? 502 : res.status, 'upstream_error', `「${provider.name}」返回错误：${message}`)
  }

  function record(ctx: GrantContext, up: Upstream | null, started: number, status: number, usage: UsageCounts, error: string | null, stream: boolean) {
    const ts = now()
    store.insertUsage({
      grantId: ctx.grant.id,
      userId: ctx.grant.userId,
      ts,
      slot: up?.slot ?? 'default',
      providerId: up?.provider.id ?? null,
      model: up?.model ?? null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - started,
      status,
      error,
      stream,
    })
    store.touchGrant(ctx.grant.id, ts)
  }

  /** Streams translated SSE to the client and records usage when the stream ends. */
  function streamResponse(
    c: Context,
    upstreamBody: ReadableStream<Uint8Array>,
    abort: AbortController,
    headers: Record<string, string>,
    onEvent: (event: string | undefined, data: string, send: (s: string) => void) => void,
    onEnd: (send: (s: string) => void, aborted: boolean, error: Error | null) => void,
  ) {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false
        const send = (s: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(s))
          } catch {
            closed = true
          }
        }
        let error: Error | null = null
        try {
          for await (const ev of parseSse(upstreamBody, abort.signal)) onEvent(ev.event, ev.data, send)
        } catch (e) {
          error = e as Error
        }
        onEnd(send, abort.signal.aborted, error)
        closed = true
        try {
          controller.close()
        } catch {
          // already closed
        }
      },
      cancel() {
        abort.abort()
      },
    })
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...headers } })
  }

  const errorChunk = (message: string, type = 'upstream_error') => sse({ error: { message, type, code: 'upstream_error' } })

  // ---- GET /v1/models ------------------------------------------------------------------------------
  app.get('/models', (c) => {
    const ctx = authenticate(c)
    if (isFailure(ctx)) return apiError(c, ctx)
    const data = ctx.grant.slots.map((id) => ({ id, object: 'model', created: ctx.grant.createdAt, owned_by: 'modelpass' }))
    if (ctx.grant.scope.includes('model_choice')) {
      for (const entry of ctx.grant.allowedModels) {
        const model = entry.slice(entry.indexOf(':') + 1)
        data.push({ id: model as SlotId, object: 'model', created: ctx.grant.createdAt, owned_by: 'user' })
      }
    }
    return c.json({ object: 'list', data })
  })

  // ---- GET /v1/modelpass/grant ---------------------------------------------------------------------
  app.get('/modelpass/grant', (c) => {
    const ctx = authenticate(c)
    if (isFailure(ctx)) return apiError(c, ctx)
    const g = ctx.grant
    const used = store.usageForDay(g.id, dayKey(now()))
    const info: GrantInfo = {
      grant_id: g.id,
      client_id: g.clientId,
      scope: g.scope.join(' '),
      status: g.status,
      slots: tokenSlots(store, g, g.shareModelInfo),
      budget: {
        tokens_per_day: g.budget.tokensPerDay,
        requests_per_day: g.budget.requestsPerDay,
        tokens_used_today: used.tokens,
        requests_today: used.requests,
      },
      created_at: g.createdAt,
      expires_at: g.expiresAt,
    }
    return c.json(info)
  })

  // ---- POST /v1/chat/completions -------------------------------------------------------------------
  app.post('/chat/completions', async (c) => {
    const ctx = authenticate(c)
    if (isFailure(ctx)) return apiError(c, ctx)
    const body = (await c.req.json().catch(() => null)) as ChatRequest | null
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return apiError(c, fail(400, 'invalid_request', '请求体需要包含 messages 数组'))
    }
    if (hasImageContent(body.messages) && !ctx.grant.scope.includes('vision')) {
      return apiError(c, fail(403, 'insufficient_scope', '该应用未获得「图片理解」权限'))
    }
    if (body.tools?.length && !ctx.grant.scope.includes('tools')) {
      return apiError(c, fail(403, 'insufficient_scope', '该应用未获得「工具调用」权限'))
    }
    const budget = budgetCheck(ctx.grant)
    if (isFailure(budget)) return apiError(c, budget)
    const up = await selectUpstream(ctx, body.model)
    if (isFailure(up)) return apiError(c, up)
    if (budget.remaining !== null) up.headers['x-modelpass-budget-remaining'] = String(budget.remaining)

    const started = Date.now()
    const stream = Boolean(body.stream)
    const wantUsage = Boolean(body.stream_options?.include_usage)
    const endpoints = upstreamEndpoints(up.provider.format, up.secret.baseUrl)
    const abort = new AbortController()

    // -- OpenAI-compatible upstream: pass through, rewriting model and collecting usage.
    if (up.provider.format === 'openai-chat') {
      const upstreamBody: Record<string, unknown> = { ...body, model: up.model }
      if (stream && up.provider.options?.streamUsage !== false) {
        upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true }
      }
      const res = await callUpstream(endpoints.chat, upstreamHeaders(up, stream), upstreamBody, abort.signal)
      if (isFailure(res)) {
        record(ctx, up, started, res.status, { promptTokens: 0, completionTokens: 0 }, res.message, stream)
        return apiError(c, res, up.headers)
      }
      if (!res.ok) {
        const f = await upstreamFailure(res, up.provider)
        record(ctx, up, started, f.status, { promptTokens: 0, completionTokens: 0 }, f.message, stream)
        return apiError(c, f, up.headers)
      }
      if (!stream || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (!json) return apiError(c, fail(502, 'upstream_error', '上游返回了无法解析的响应'), up.headers)
        const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
        const usage = { promptTokens: u?.prompt_tokens ?? 0, completionTokens: u?.completion_tokens ?? 0 }
        json.model = up.shownModel
        record(ctx, up, started, 200, usage, null, false)
        return c.json(json, 200, up.headers)
      }
      const usage: UsageCounts = { promptTokens: 0, completionTokens: 0 }
      return streamResponse(
        c,
        res.body!,
        abort,
        up.headers,
        (_event, data, send) => {
          if (data.trim() === '[DONE]') return
          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(data)
          } catch {
            return
          }
          const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined | null
          if (u) {
            usage.promptTokens = u.prompt_tokens ?? usage.promptTokens
            usage.completionTokens = u.completion_tokens ?? usage.completionTokens
          }
          const choices = chunk.choices as unknown[] | undefined
          if (!wantUsage && u && (!choices || choices.length === 0)) return
          if (!wantUsage && u) delete chunk.usage
          if ('model' in chunk) chunk.model = up.shownModel
          send(sse(chunk))
        },
        (send, aborted, error) => {
          if (error && !aborted) send(errorChunk(`上游流中断：${error.message}`))
          send('data: [DONE]\n\n')
          record(ctx, up, started, aborted ? 499 : error ? 502 : 200, usage, error?.message ?? (aborted ? 'client aborted' : null), true)
        },
      )
    }

    // -- Anthropic Messages upstream: translate request, response and stream.
    if (up.provider.format === 'anthropic-messages') {
      const upstreamBody = chatToAnthropic(body, up.model, ctx.grant.id)
      const res = await callUpstream(endpoints.chat, upstreamHeaders(up, stream), upstreamBody, abort.signal)
      if (isFailure(res)) {
        record(ctx, up, started, res.status, { promptTokens: 0, completionTokens: 0 }, res.message, stream)
        return apiError(c, res, up.headers)
      }
      if (!res.ok) {
        const f = await upstreamFailure(res, up.provider)
        record(ctx, up, started, f.status, { promptTokens: 0, completionTokens: 0 }, f.message, stream)
        return apiError(c, f, up.headers)
      }
      if (!stream) {
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (!json) return apiError(c, fail(502, 'upstream_error', '上游返回了无法解析的响应'), up.headers)
        const out = anthropicToChat(json, up.shownModel, ctx.grant.id)
        record(ctx, up, started, 200, out.counts, null, false)
        return c.json(out.body, 200, up.headers)
      }
      const t = new AnthropicStreamTranslator(up.shownModel, ctx.grant.id)
      return streamResponse(
        c,
        res.body!,
        abort,
        up.headers,
        (event, data, send) => {
          for (const chunk of t.handle(event, data)) send(sse(chunk))
        },
        (send, aborted, error) => {
          if (t.error) send(errorChunk(t.error.message, t.error.type))
          else if (error && !aborted) send(errorChunk(`上游流中断：${error.message}`))
          if (wantUsage) send(sse(t.usageChunk()))
          send('data: [DONE]\n\n')
          const status = aborted ? 499 : t.error || error ? 502 : 200
          record(ctx, up, started, status, t.usage, t.error?.message ?? error?.message ?? (aborted ? 'client aborted' : null), true)
        },
      )
    }

    // -- OpenAI Responses upstream (ChatGPT plan): always streamed upstream; aggregate if needed.
    const upstreamBody = chatToResponses(body, up.model)
    const res = await callUpstream(endpoints.chat, upstreamHeaders(up, true), upstreamBody, abort.signal)
    if (isFailure(res)) {
      record(ctx, up, started, res.status, { promptTokens: 0, completionTokens: 0 }, res.message, stream)
      return apiError(c, res, up.headers)
    }
    if (!res.ok) {
      const f = await upstreamFailure(res, up.provider)
      record(ctx, up, started, f.status, { promptTokens: 0, completionTokens: 0 }, f.message, stream)
      return apiError(c, f, up.headers)
    }
    const t = new ResponsesStreamTranslator(up.shownModel)
    if (stream) {
      return streamResponse(
        c,
        res.body!,
        abort,
        up.headers,
        (event, data, send) => {
          for (const chunk of t.handle(event, data)) send(sse(chunk))
        },
        (send, aborted, error) => {
          if (t.error) send(errorChunk(t.error.message, t.error.type))
          else if (error && !aborted) send(errorChunk(`上游流中断：${error.message}`))
          if (wantUsage) send(sse(t.usageChunk()))
          send('data: [DONE]\n\n')
          record(ctx, up, started, aborted ? 499 : t.error || error ? 502 : 200, t.usage, t.error?.message ?? error?.message ?? null, true)
        },
      )
    }
    const agg = new ChunkAggregator()
    try {
      for await (const ev of parseSse(res.body!, abort.signal)) for (const chunk of t.handle(ev.event, ev.data)) agg.add(chunk)
    } catch (e) {
      record(ctx, up, started, 502, t.usage, (e as Error).message, false)
      return apiError(c, fail(502, 'upstream_error', `上游流中断：${(e as Error).message}`), up.headers)
    }
    if (t.error) {
      record(ctx, up, started, 502, t.usage, t.error.message, false)
      return apiError(c, fail(502, 'upstream_error', t.error.message), up.headers)
    }
    record(ctx, up, started, 200, t.usage, null, false)
    return c.json(agg.toCompletion(t.id, up.shownModel, t.created, t.finishReason ?? 'stop', t.usage), 200, up.headers)
  })

  // ---- POST /v1/messages (Anthropic-compatible passthrough) ------------------------------------------
  app.post('/messages', async (c) => {
    const ctx = authenticate(c)
    if (isFailure(ctx)) return apiError(c, ctx)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !Array.isArray(body.messages)) return apiError(c, fail(400, 'invalid_request', '请求体需要包含 messages 数组'))
    const messages = body.messages as { content?: unknown }[]
    const hasImage = messages.some((m) => Array.isArray(m.content) && (m.content as { type?: string }[]).some((b) => b.type === 'image'))
    if (hasImage && !ctx.grant.scope.includes('vision')) return apiError(c, fail(403, 'insufficient_scope', '该应用未获得「图片理解」权限'))
    if (Array.isArray(body.tools) && body.tools.length && !ctx.grant.scope.includes('tools')) {
      return apiError(c, fail(403, 'insufficient_scope', '该应用未获得「工具调用」权限'))
    }
    const budget = budgetCheck(ctx.grant)
    if (isFailure(budget)) return apiError(c, budget)
    const up = await selectUpstream(ctx, body.model as string | undefined)
    if (isFailure(up)) return apiError(c, up)
    if (up.provider.format !== 'anthropic-messages') {
      return apiError(c, fail(400, 'unsupported_format', `当前路由到的「${up.provider.name}」不支持 Anthropic Messages 协议，请改用 /v1/chat/completions`), up.headers)
    }
    const started = Date.now()
    const stream = Boolean(body.stream)
    const extra: Record<string, string> = {}
    const version = c.req.header('anthropic-version')
    if (version) extra['anthropic-version'] = version
    const beta = c.req.header('anthropic-beta')
    if (beta) extra['anthropic-beta'] = beta
    const abort = new AbortController()
    const res = await callUpstream(upstreamEndpoints('anthropic-messages', up.secret.baseUrl).chat, upstreamHeaders(up, stream, extra), { ...body, model: up.model }, abort.signal)
    if (isFailure(res)) return apiError(c, res, up.headers)
    if (!res.ok) {
      const f = await upstreamFailure(res, up.provider)
      record(ctx, up, started, f.status, { promptTokens: 0, completionTokens: 0 }, f.message, stream)
      return apiError(c, f, up.headers)
    }
    if (!stream) {
      const json = (await res.json()) as Record<string, unknown>
      const u = json.usage as Record<string, number> | undefined
      json.model = up.shownModel
      record(ctx, up, started, 200, { promptTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), completionTokens: u?.output_tokens ?? 0 }, null, false)
      return c.json(json, 200, up.headers)
    }
    const usage: UsageCounts = { promptTokens: 0, completionTokens: 0 }
    return streamResponse(
      c,
      res.body!,
      abort,
      up.headers,
      (event, data, send) => {
        try {
          const ev = JSON.parse(data) as Record<string, unknown>
          if (ev.type === 'message_start') {
            const msg = ev.message as Record<string, unknown>
            const u = msg.usage as Record<string, number> | undefined
            usage.promptTokens = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
            msg.model = up.shownModel
          } else if (ev.type === 'message_delta') {
            const u = ev.usage as Record<string, number> | undefined
            if (u?.output_tokens !== undefined) usage.completionTokens = u.output_tokens
          }
          send(sse(ev, event ?? (ev.type as string)))
        } catch {
          send(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`)
        }
      },
      (_send, aborted, error) => {
        record(ctx, up, started, aborted ? 499 : error ? 502 : 200, usage, error?.message ?? null, true)
      },
    )
  })

  return app
}

/** Rebuilds a non-streaming chat.completion from translated chunks. */
class ChunkAggregator {
  private content = ''
  private reasoning = ''
  private tools: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = []

  add(chunk: Record<string, unknown>) {
    const choice = (chunk.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0]
    const delta = choice?.delta
    if (!delta) return
    if (typeof delta.content === 'string') this.content += delta.content
    if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content
    for (const tc of (delta.tool_calls as { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
      const t = (this.tools[tc.index] ??= { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } })
      if (tc.id) t.id = tc.id
      if (tc.function?.name) t.function.name = tc.function.name
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments
    }
  }

  toCompletion(id: string, model: string, created: number, finish: FinishReason, usage: UsageCounts) {
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.content || (this.tools.length ? null : ''),
            ...(this.tools.length ? { tool_calls: this.tools.filter(Boolean) } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage: toChatUsage(usage),
    }
  }
}

