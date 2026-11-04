// End-to-end protocol test: a wallet (WalletClient), a third-party app (ModelPassClient SDK) and the
// hub (in-process) talking to the built-in mock upstreams — OpenAI, Anthropic and Responses formats.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import {
  WalletClient,
  codeChallengeS256,
  createCodeVerifier,
  getUrlParams,
  parseAuthorizationRequest,
  parseLinkUrl,
  type AuthorizationRequest,
  type GrantOptions,
  type ProviderSecret,
} from '@modelpass/core'
import { MemoryStorage, ModelPassClient, ModelPassError, type ChatCompletionChunk } from '@modelpass/sdk'
import { createApp } from '../src/app'
import { loadConfig } from '../src/config'
import { Store } from '../src/store'

const HUB = 'http://hub.test'
const KEY_OPENAI = 'sk-demo-secret-123456'
const KEY_ANTHROPIC = 'sk-ant-demo-secret-abcdef'
const fast = { 'x-mock-delay-ms': '0' }

const store = new Store(':memory:')
const config = { ...loadConfig({}), publicUrl: undefined, upstreamTimeoutMs: 10_000 }
const refreshCalls: URLSearchParams[] = []
// eslint-disable-next-line prefer-const
let app: ReturnType<typeof createApp>
const testFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init)
  if (req.url === 'http://auth.test/token') {
    refreshCalls.push(new URLSearchParams(await req.text()))
    return Response.json({ access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' })
  }
  return app.fetch(req)
}
app = createApp({ store, config, fetch: testFetch })
const hub = (path: string, init?: RequestInit) => testFetch(`${HUB}${path}`, init)

let wallet: WalletClient
let client: ModelPassClient
let grantId = ''
let lastWalletUrl = ''

const grantOptions = (req: AuthorizationRequest, extra: Partial<GrantOptions> = {}): GrantOptions => ({
  scope: req.scope,
  slots: req.slots,
  routes: {},
  budget: { tokensPerDay: null, requestsPerDay: null },
  expiresAt: null,
  shareModelInfo: true,
  allowedModels: [],
  clientName: req.clientName,
  ...extra,
})

async function collect(params: Parameters<ModelPassClient['chat']['stream']>[0]) {
  const chunks: ChatCompletionChunk[] = []
  let text = ''
  const toolCalls: { id?: string; name?: string; args: string }[] = []
  for await (const ch of client.chat.stream(params)) {
    chunks.push(ch)
    const d = ch.choices?.[0]?.delta
    if (d?.content) text += d.content
    for (const tc of (d?.tool_calls as unknown as { index: number; id?: string; function?: { name?: string; arguments?: string } }[]) ?? []) {
      const t = (toolCalls[tc.index] ??= { args: '' })
      if (tc.id) t.id = tc.id
      if (tc.function?.name) t.name = tc.function.name
      if (tc.function?.arguments) t.args += tc.function.arguments
    }
  }
  return { chunks, text, toolCalls }
}

describe('ModelPass end-to-end', () => {
  before(async () => {
    const identity = await WalletClient.register(HUB, testFetch)
    wallet = new WalletClient(identity, testFetch)
    const put = (id: string, presetId: string, format: 'openai-chat' | 'anthropic-messages' | 'openai-responses', models: string[], secret: ProviderSecret) =>
      wallet.putProvider({ id, name: id, presetId, format, models, host: 'hub.test' }, secret)
    await put('p_openai', 'demo-openai', 'openai-chat', ['mock-gpt-mini', 'mock-gpt-pro'], { baseUrl: `${HUB}/mock/openai/v1`, apiKey: KEY_OPENAI, headers: fast })
    await put('p_claude', 'demo-anthropic', 'anthropic-messages', ['mock-claude-haiku', 'mock-claude-opus'], { baseUrl: `${HUB}/mock/anthropic/v1`, apiKey: KEY_ANTHROPIC, headers: fast })
    await put('p_resp', 'chatgpt', 'openai-responses', ['mock-gpt-pro'], {
      baseUrl: `${HUB}/mock/openai/v1`,
      headers: fast,
      oauth: { accessToken: 'old-access', refreshToken: 'rt-1', expiresAt: Math.floor(Date.now() / 1000) - 10, clientId: 'app_test', tokenUrl: 'http://auth.test/token', resource: 'https://api.openai.com/v1' },
    })
    await put('p_bad', 'custom-openai', 'openai-chat', ['x'], { baseUrl: `${HUB}/mock/openai/v1`, apiKey: 'invalid-key', headers: fast })
    await wallet.putRoutes({
      default: { providerId: 'p_openai', model: 'mock-gpt-mini' },
      reasoning: { providerId: 'p_claude', model: 'mock-claude-opus' },
    })
    client = new ModelPassClient({
      clientId: 'dev.modelpass.demochat',
      redirectUri: 'modelpass-demochat://modelpass-callback',
      clientName: 'Demo Chat',
      scopes: ['chat', 'tools'],
      slots: ['default', 'fast', 'reasoning'],
      fetch: testFetch,
      storage: new MemoryStorage(),
      allowInsecureIssuers: true,
      openUrl: async (url) => {
        lastWalletUrl = url
      },
    })
  })

  it('serves discovery and client metadata', async () => {
    const d = await (await hub('/.well-known/modelpass-configuration')).json()
    assert.equal(d.issuer, HUB)
    assert.equal(d.token_endpoint, `${HUB}/oauth/token`)
    const meta = await (await hub('/v1/clients/dev.modelpass.demochat')).json()
    assert.equal(meta.verified, true)
    const unknown = await (await hub('/v1/clients/com.unknown.app')).json()
    assert.equal(unknown.verified, false)
  })

  it('completes the same-device authorization (code + PKCE + iss)', async () => {
    const pending = client.authorize()
    await new Promise((r) => setTimeout(r, 10))
    assert.match(lastWalletUrl, /^modelpass:\/\/authorize\?/)
    const req = parseAuthorizationRequest(getUrlParams(lastWalletUrl))
    assert.ok(req.ok)
    if (!req.ok) return
    assert.deepEqual(req.value.slots, ['default', 'fast', 'reasoning'])
    const { redirectUrl, grant } = await wallet.approveAuthorization(req.value, grantOptions(req.value))
    grantId = grant.id
    assert.equal(grant.status, 'pending')
    const params = getUrlParams(redirectUrl)
    assert.equal(params.iss, HUB)
    const session = await client.handleRedirect(redirectUrl)
    assert.ok(session)
    assert.equal(await pending, session)
    assert.equal(session!.api_base, `${HUB}/v1`)
    assert.match(session!.access_token, /^mpk_/)
    assert.equal(session!.slots.find((s) => s.id === 'default')?.model, 'mock-gpt-mini')
    // the same code cannot be exchanged twice
    const replay = await hub('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: 'modelpass-demochat://modelpass-callback', client_id: 'dev.modelpass.demochat', code_verifier: 'x'.repeat(43) }),
    })
    assert.equal(replay.status, 400)
    assert.equal((await replay.json()).error, 'invalid_grant')
    const state = await wallet.getState()
    assert.equal(state.grants.find((g) => g.id === grantId)?.status, 'active')
  })

  it('rejects a wrong PKCE verifier and unregistered redirect URIs', async () => {
    const verifier = createCodeVerifier()
    const req: AuthorizationRequest = {
      clientId: 'dev.modelpass.demochat',
      redirectUri: 'modelpass-demochat://modelpass-callback',
      scope: ['chat'],
      state: 'state-state-state-1',
      codeChallenge: codeChallengeS256(verifier),
      slots: ['default'],
    }
    const { redirectUrl } = await wallet.approveAuthorization(req, grantOptions(req))
    const res = await hub('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: getUrlParams(redirectUrl).code, redirect_uri: req.redirectUri, client_id: req.clientId, code_verifier: createCodeVerifier() }),
    })
    assert.equal(res.status, 400)
    await assert.rejects(wallet.approveAuthorization({ ...req, redirectUri: 'evil://steal' }, grantOptions(req)), /redirect_uri/)
  })

  it('relays chat completions to an OpenAI-compatible upstream (non-stream, stream, fallback)', async () => {
    const r = await client.chat.create({ model: 'default', messages: [{ role: 'user', content: '你好' }] })
    assert.match(String(r.choices[0].message.content), /mock-gpt-mini/)
    assert.equal(r.model, 'mock-gpt-mini')
    assert.equal(r.modelpass.slot, 'default')
    assert.equal(r.modelpass.provider, 'p_openai')
    const s = await collect({ model: 'fast', messages: [{ role: 'user', content: 'stream please' }] })
    assert.match(s.text, /mock-gpt-mini/)
    assert.ok(s.chunks.every((c) => c.choices.length > 0), 'usage-only chunk must be stripped when not requested')
    const fb = await client.chat.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(fb.modelpass.fallback, true)
    assert.equal(fb.modelpass.slot, 'default')
  })

  it('switches the model for every app instantly when the wallet changes routes', async () => {
    await wallet.putRoutes({ default: { providerId: 'p_claude', model: 'mock-claude-haiku' }, reasoning: { providerId: 'p_claude', model: 'mock-claude-opus' } })
    const r = await client.chat.create({ model: 'default', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: '换模型了吗' }] })
    assert.match(String(r.choices[0].message.content), /Anthropic/)
    assert.equal(r.model, 'mock-claude-haiku')
    assert.ok((r.usage?.prompt_tokens ?? 0) > 0)
    const s = await collect({ model: 'default', messages: [{ role: 'user', content: 'stream via anthropic' }], stream_options: { include_usage: true } })
    assert.match(s.text, /mock-claude-haiku/)
    assert.ok(s.chunks.some((c) => c.usage && c.usage.completion_tokens > 0), 'usage chunk requested')
  })

  it('translates tool calls through Anthropic and replays thinking blocks', async () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
    const first = await collect({ model: 'reasoning', tools, messages: [{ role: 'user', content: '上海天气怎么样？' }] })
    assert.equal(first.toolCalls.length, 1)
    assert.equal(first.toolCalls[0].name, 'get_weather')
    assert.deepEqual(JSON.parse(first.toolCalls[0].args), { city: '上海' })
    const followUp = await client.chat.create({
      model: 'reasoning',
      tools,
      messages: [
        { role: 'user', content: '上海天气怎么样？' },
        { role: 'assistant', content: null, tool_calls: [{ id: first.toolCalls[0].id!, type: 'function', function: { name: 'get_weather', arguments: first.toolCalls[0].args } }] },
        { role: 'tool', tool_call_id: first.toolCalls[0].id!, content: '晴，22°C' },
      ],
    })
    assert.match(String(followUp.choices[0].message.content), /晴，22°C/)
    // non-streaming tool call + replay
    const nf = await client.chat.create({ model: 'reasoning', tools, messages: [{ role: 'user', content: '北京天气' }] })
    const call = nf.choices[0].message.tool_calls![0]
    assert.equal(nf.choices[0].finish_reason, 'tool_calls')
    const nf2 = await client.chat.create({
      model: 'reasoning',
      tools,
      messages: [{ role: 'user', content: '北京天气' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '多云' }],
    })
    assert.match(String(nf2.choices[0].message.content), /多云/)
  })

  it('uses the Responses API connector and refreshes + re-seals OAuth credentials', async () => {
    await wallet.putRoutes({ default: { providerId: 'p_openai', model: 'mock-gpt-mini' }, fast: { providerId: 'p_resp', model: 'mock-gpt-pro' } })
    const before = store.getProvider(wallet.identity.userId, 'p_resp')!.sealed
    const r = await client.chat.create({ model: 'fast', temperature: 0.3, messages: [{ role: 'user', content: 'plan usage' }] })
    assert.match(String(r.choices[0].message.content), /OpenAI Responses/)
    assert.equal(refreshCalls.length, 1)
    assert.equal(refreshCalls[0].get('grant_type'), 'refresh_token')
    assert.equal(refreshCalls[0].get('refresh_token'), 'rt-1')
    assert.equal(refreshCalls[0].get('resource'), 'https://api.openai.com/v1')
    assert.notEqual(store.getProvider(wallet.identity.userId, 'p_resp')!.sealed, before)
    const s = await collect({ model: 'fast', messages: [{ role: 'user', content: 'stream plan usage' }] })
    assert.match(s.text, /mock-gpt-pro/)
    assert.equal(refreshCalls.length, 1, 'fresh token is reused')
  })

  it('enforces scopes', async () => {
    await assert.rejects(
      client.chat.create({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }),
      (e: ModelPassError) => e.code === 'insufficient_scope' && e.status === 403,
    )
    const models = await (await client.apiFetch('/models')).json()
    assert.deepEqual(
      models.data.map((m: { id: string }) => m.id),
      ['default', 'fast', 'reasoning'],
    )
  })

  it('passes /v1/messages through to Anthropic upstreams only', async () => {
    await wallet.putRoutes({ default: { providerId: 'p_openai', model: 'mock-gpt-mini' }, reasoning: { providerId: 'p_claude', model: 'mock-claude-opus' } })
    const token = client.session!.access_token
    const headers = { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    const unsupported = await hub('/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'default', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(unsupported.status, 400)
    assert.equal((await unsupported.json()).error.code, 'unsupported_format')
    const ok = await hub('/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'reasoning', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.model, 'mock-claude-opus')
    assert.match(body.content[0].text, /Anthropic/)
    const st = await hub('/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'reasoning', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) })
    const text = await st.text()
    assert.match(text, /event: message_start/)
    assert.match(text, /event: message_stop/)
  })

  it('maps upstream auth failures, budgets and pausing', async () => {
    await wallet.putRoutes({ default: { providerId: 'p_bad', model: 'x' } })
    await assert.rejects(client.chat.create({ messages: [{ role: 'user', content: 'hi' }] }), (e: ModelPassError) => e.code === 'upstream_auth_failed')
    await wallet.putRoutes({ default: { providerId: 'p_openai', model: 'mock-gpt-mini' } })

    const used = (await client.grantInfo()).budget.requests_today
    assert.ok(used > 5)
    await wallet.updateGrant(grantId, { budget: { tokensPerDay: null, requestsPerDay: used + 1 } })
    await client.chat.create({ messages: [{ role: 'user', content: 'one more' }] })
    await assert.rejects(client.chat.create({ messages: [{ role: 'user', content: 'over budget' }] }), (e: ModelPassError) => e.code === 'budget_exceeded' && e.status === 429)
    await wallet.updateGrant(grantId, { budget: { tokensPerDay: null, requestsPerDay: null } })

    await wallet.updateGrant(grantId, { status: 'paused' })
    await assert.rejects(client.chat.create({ messages: [{ role: 'user', content: 'paused' }] }), (e: ModelPassError) => e.code === 'grant_paused')
    await wallet.updateGrant(grantId, { status: 'active' })

    // per-app override wins over the global route
    await wallet.updateGrant(grantId, { routes: { default: { providerId: 'p_claude', model: 'mock-claude-haiku' } } })
    const r = await client.chat.create({ messages: [{ role: 'user', content: 'override' }] })
    assert.equal(r.model, 'mock-claude-haiku')
    await wallet.updateGrant(grantId, { routes: {} })
  })

  it('records metadata-only activity and never stores secrets in plaintext', async () => {
    const activity = await wallet.activity(100)
    assert.ok(activity.length >= 10)
    assert.ok(activity.some((a) => a.status === 429 || a.status === 200))
    const dump = JSON.stringify(
      ['users', 'providers', 'routes', 'grants', 'auth_codes', 'link_sessions', 'usage'].map((t) => store.db.prepare(`SELECT * FROM ${t}`).all()),
    )
    for (const secret of [KEY_OPENAI, KEY_ANTHROPIC, 'rt-1', 'rt-2', 'new-access', client.session!.access_token, wallet.identity.walletToken, '上海天气怎么样']) {
      assert.ok(!dump.includes(secret), `database must not contain ${secret.slice(0, 12)}…`)
    }
  })

  it('revokes on sign-out', async () => {
    const token = client.session!.access_token
    await client.signOut()
    assert.equal(client.session, null)
    const res = await hub('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error.code, 'grant_revoked')
  })

  it('completes the cross-device link flow end-to-end encrypted', async () => {
    const web = new ModelPassClient({ clientId: 'dev.modelpass.webdemo', redirectUri: 'https://unused.example/cb', clientName: 'Web Demo', fetch: testFetch, allowInsecureIssuers: true })
    const link = await web.startLink(HUB, { slots: ['default', 'fast'] })
    assert.match(link.qrUrl, /^http:\/\/hub\.test\/link#v=1&uc=[A-Z]{4}-[A-Z]{4}&s=/)
    const parsed = parseLinkUrl(link.qrUrl)!
    assert.equal(parsed.rendezvous, HUB)
    const info = await wallet.getLinkInfo(parsed)
    assert.equal(info.client.verified, true)
    assert.equal(info.status, 'pending')
    // a wrong verifier cannot complete the request
    const forged = await hub(`/v1/link/${parsed.userCode}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link_verifier: 'A'.repeat(43), sealed: 'xx' }) })
    assert.equal(forged.status, 400)
    const waiting = link.waitForSession()
    await wallet.approveLink(parsed, info, { scope: ['chat'], slots: info.slots, routes: {}, budget: { tokensPerDay: 50_000, requestsPerDay: null }, expiresAt: null, shareModelInfo: false, allowedModels: [], clientName: info.client_name })
    const session = await waiting
    assert.equal(session.issuer, HUB)
    assert.equal(session.slots[0].model, undefined, 'model names hidden when shareModelInfo is false')
    const r = await web.chat.create({ messages: [{ role: 'user', content: '扫码登录成功' }] })
    assert.equal(r.model, 'default', 'real model name hidden')
    assert.equal(r.modelpass.budgetRemaining !== undefined, true)
    const again = await hub(`/v1/link/${parsed.userCode}`)
    assert.equal(again.status, 404, 'link session is single-use')
  })

  it('lets the user deny a link request', async () => {
    const web = new ModelPassClient({ clientId: 'dev.modelpass.webdemo', redirectUri: 'https://unused.example/cb', fetch: testFetch, allowInsecureIssuers: true })
    const link = await web.startLink(HUB)
    const parsed = parseLinkUrl(link.qrUrl)!
    await wallet.denyLink(parsed)
    await assert.rejects(link.waitForSession(), (e: ModelPassError) => e.code === 'access_denied')
  })

  it('protects the wallet API', async () => {
    const res = await hub('/wallet/v1/state', { headers: { authorization: 'Bearer mpw_nope' } })
    assert.equal(res.status, 401)
  })
})
