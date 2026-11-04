// Talking to providers directly from the phone: listing models, testing keys, and the two
// account connectors (OpenRouter OAuth PKCE, ChatGPT plan via "Sign in with ChatGPT").

import {
  codeChallengeS256,
  createCodeVerifier,
  createState,
  encodeQuery,
  getUrlParams,
  upstreamAuthHeaders,
  upstreamEndpoints,
  type UpstreamFormat,
} from '@modelpass/core'

export interface TestResult {
  ok: boolean
  models: string[]
  message: string
  latencyMs: number
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms = 15000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await p(ctrl.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Lists models and doubles as a credential check. */
export async function testProvider(format: UpstreamFormat, baseUrl: string, credential?: string, headers?: Record<string, string>): Promise<TestResult> {
  const started = Date.now()
  const url = upstreamEndpoints(format, baseUrl).models
  try {
    const res = await withTimeout((signal) =>
      fetch(url, { headers: { accept: 'application/json', ...upstreamAuthHeaders(format, credential), ...(headers ?? {}) }, signal }),
    )
    const latencyMs = Date.now() - started
    const text = await res.text()
    if (!res.ok) {
      let msg = text.slice(0, 200)
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string }
        msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? msg
      } catch {
        // keep raw text
      }
      return { ok: false, models: [], latencyMs, message: res.status === 401 || res.status === 403 ? `Key 无效或无权限（${res.status}）：${msg}` : `请求失败（${res.status}）：${msg}` }
    }
    const body = JSON.parse(text) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] }
    const models = (body.data ?? body.models ?? [])
      .map((m) => (m as { id?: string }).id ?? (m as { name?: string }).name ?? '')
      .filter(Boolean)
      .sort()
    return { ok: true, models, latencyMs, message: `连接成功 · ${models.length} 个模型 · ${latencyMs}ms` }
  } catch (e) {
    return { ok: false, models: [], latencyMs: Date.now() - started, message: `无法连接：${(e as Error).message}` }
  }
}

// ---- OpenRouter (official OAuth PKCE → user-controlled API key) ------------------------------

export function openRouterAuthUrl(callbackUrl: string | null) {
  const verifier = createCodeVerifier()
  const params: Record<string, string> = { code_challenge: codeChallengeS256(verifier), code_challenge_method: 'S256' }
  if (callbackUrl) params.callback_url = callbackUrl
  return { url: `https://openrouter.ai/auth?${encodeQuery(params)}`, verifier }
}

export async function openRouterExchange(code: string, verifier: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  })
  const body = (await res.json().catch(() => ({}))) as { key?: string; error?: { message?: string } | string }
  if (!res.ok || !body.key) {
    throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? `OpenRouter 返回 ${res.status}`)
  }
  return body.key
}

// ---- ChatGPT plan ("Sign in with ChatGPT", experimental) -------------------------------------
// Open-source clients register dynamically: the first authorization uses client_id=dynamic_agent_client
// plus a stable opaque ext_agent_host_id; the callback returns the issued client_id. The redirect
// must be an HTTP loopback URL, so on a phone the user copies the final URL back into the wallet.

export const CHATGPT = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  redirectUri: 'http://127.0.0.1:1455/auth/callback',
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  resource: 'https://api.openai.com/v1',
}

export function chatGptAuthorize(opts: { clientId?: string; hostId: string }) {
  const verifier = createCodeVerifier()
  const state = createState()
  const query = encodeQuery({
    response_type: 'code',
    client_id: opts.clientId ?? 'dynamic_agent_client',
    redirect_uri: CHATGPT.redirectUri,
    scope: CHATGPT.scope,
    resource: CHATGPT.resource,
    state,
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
    ext_agent_host_id: opts.hostId,
    agent_name_hint: 'ModelPass',
  })
  return { url: `${CHATGPT.authorize}?${query}`, verifier, state }
}

export interface ChatGptTokens {
  clientId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: string
}

export async function chatGptExchange(callbackUrl: string, pending: { verifier: string; state: string; clientId?: string }): Promise<ChatGptTokens> {
  const p = getUrlParams(callbackUrl)
  if (p.error) throw new Error(p.error_description || p.error)
  if (!p.code) throw new Error('链接中没有 code，请复制浏览器最终跳转到的完整地址')
  if (p.state !== pending.state) throw new Error('state 不匹配，请重新发起')
  const clientId = p.client_id || pending.clientId
  if (!clientId || clientId === 'dynamic_agent_client') throw new Error('回调中缺少签发的 client_id')
  const res = await fetch(CHATGPT.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: encodeQuery({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: p.code,
      code_verifier: pending.verifier,
      redirect_uri: CHATGPT.redirectUri,
      resource: CHATGPT.resource,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string; error?: string }
  if (!res.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `换取令牌失败（${res.status}）`)
  const scope = body.scope ?? ''
  if (!scope.split(' ').includes('chatgpt.tokens.use.direct')) {
    throw new Error('登录成功，但你没有授权「使用 ChatGPT 套餐额度」，无法用于模型调用')
  }
  return {
    clientId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    scope,
  }
}
