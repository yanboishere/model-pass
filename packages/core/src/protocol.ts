// ModelPass Connect protocol v0.1 — shared types and request helpers.
// Public protocol objects (discovery, token response, errors) use snake_case like OAuth;
// the private wallet ↔ hub API uses camelCase.

import { encodeQuery, parseQuery } from './link'

export const PROTOCOL_VERSION = '0.1'
export const DEFAULT_WALLET_AUTHORIZE_URL = 'modelpass://authorize'
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
export const DISCOVERY_PATH = '/.well-known/modelpass-configuration'

// ---- scopes & slots ------------------------------------------------------------------------

export const SCOPES = ['chat', 'vision', 'tools', 'model_choice'] as const
export type Scope = (typeof SCOPES)[number]

export const SCOPE_INFO: Record<Scope, { label: string; description: string }> = {
  chat: { label: '对话', description: '使用你的模型进行对话与文本生成' },
  vision: { label: '图片理解', description: '在请求中发送图片给模型' },
  tools: { label: '工具调用', description: '让模型调用应用提供的函数 / 工具' },
  model_choice: { label: '指定模型', description: '允许应用点名具体模型（你可以在钱包里限制）' },
}

export const SLOTS = ['default', 'fast', 'reasoning', 'vision'] as const
export type SlotId = (typeof SLOTS)[number]

export const SLOT_INFO: Record<SlotId, { label: string; labelEn: string; description: string }> = {
  default: { label: '默认', labelEn: 'Default', description: '通用对话' },
  fast: { label: '快速', labelEn: 'Fast', description: '低延迟、低成本的小任务' },
  reasoning: { label: '推理', labelEn: 'Reasoning', description: '复杂推理与代码' },
  vision: { label: '视觉', labelEn: 'Vision', description: '需要看图的任务' },
}

export function isScope(v: string): v is Scope {
  return (SCOPES as readonly string[]).includes(v)
}

export function isSlot(v: string): v is SlotId {
  return (SLOTS as readonly string[]).includes(v)
}

export function parseScopeString(s: string | undefined | null): Scope[] {
  const out: Scope[] = []
  for (const part of (s ?? '').split(/[\s,+]+/)) if (isScope(part) && !out.includes(part)) out.push(part)
  return out
}

/** Unknown slots are dropped; `default` is always present and first. */
export function parseSlotString(s: string | undefined | null): SlotId[] {
  const out: SlotId[] = ['default']
  for (const part of (s ?? '').split(/[\s,+]+/)) if (isSlot(part) && !out.includes(part)) out.push(part)
  return out
}

// ---- providers & routing --------------------------------------------------------------------

export type UpstreamFormat = 'openai-chat' | 'anthropic-messages' | 'openai-responses'

/** Secret part of a provider; only ever stored sealed under the user's vault key. */
export interface ProviderSecret {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** OAuth credentials for account / subscription connectors (e.g. ChatGPT plan). */
  oauth?: {
    accessToken: string
    refreshToken?: string
    /** epoch seconds */
    expiresAt?: number
    clientId: string
    tokenUrl: string
    resource?: string
    accountLabel?: string
  }
}

export interface ProviderOptions {
  /** Send `stream_options.include_usage` to OpenAI-compatible upstreams (default true). */
  streamUsage?: boolean
}

/** Public provider metadata (synced to the hub in plaintext; no secrets). */
export interface ProviderRecord {
  id: string
  name: string
  presetId: string
  format: UpstreamFormat
  models: string[]
  /** Display-only host name, e.g. "api.deepseek.com". */
  host?: string
  options?: ProviderOptions
  createdAt: number
  updatedAt: number
}

export interface RouteTarget {
  providerId: string
  model: string
}

export type RouteMap = Partial<Record<SlotId, RouteTarget>>

export interface BudgetConfig {
  tokensPerDay: number | null
  requestsPerDay: number | null
}

// ---- authorization request (same-device flow) -------------------------------------------------

export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  scope: Scope[]
  state: string
  codeChallenge: string
  slots: SlotId[]
  clientName?: string
  budgetHint?: number
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OAuthErrorCode; description: string; redirectUri?: string; state?: string }

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

/** Validates the parameters a wallet receives on `modelpass://authorize`. */
export function parseAuthorizationRequest(params: Record<string, string | string[] | undefined>): ParseResult<AuthorizationRequest> {
  const get = (k: string) => {
    const v = params[k]
    return Array.isArray(v) ? v[0] : v
  }
  const redirectUri = get('redirect_uri')
  const state = get('state')
  const fail = (error: OAuthErrorCode, description: string, canRedirect = true): ParseResult<AuthorizationRequest> => ({
    ok: false,
    error,
    description,
    redirectUri: canRedirect ? redirectUri : undefined,
    state,
  })

  if (!redirectUri || !/^[a-z][a-z0-9+.-]*:/i.test(redirectUri)) return fail('invalid_request', '缺少或无效的 redirect_uri', false)
  if (/^(javascript|data|file|vbscript):/i.test(redirectUri)) return fail('invalid_request', '不允许的 redirect_uri scheme', false)
  const clientId = get('client_id')
  if (!clientId || clientId.length > 200) return fail('invalid_request', '缺少 client_id')
  if (get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type 必须为 code')
  if (!state || state.length < 16) return fail('invalid_request', 'state 缺失或过短（至少 128 bit）')
  const codeChallenge = get('code_challenge')
  if (get('code_challenge_method') !== 'S256' || !codeChallenge || !CHALLENGE_RE.test(codeChallenge)) {
    return fail('invalid_request', '必须使用 PKCE（code_challenge_method=S256）')
  }
  const scope = parseScopeString(get('scope'))
  if (!scope.includes('chat')) return fail('invalid_scope', 'scope 至少需要包含 chat')
  const budget = Number(get('budget_hint'))
  const clientName = get('client_name')?.slice(0, 60)
  return {
    ok: true,
    value: {
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      slots: parseSlotString(get('slots')),
      clientName: clientName || undefined,
      budgetHint: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : undefined,
    },
  }
}

export function buildAuthorizationUrl(walletUrl: string, req: AuthorizationRequest): string {
  const query = encodeQuery({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: req.scope.join(' '),
    state: req.state,
    code_challenge: req.codeChallenge,
    code_challenge_method: 'S256',
    slots: req.slots.join(' '),
    client_name: req.clientName,
    budget_hint: req.budgetHint,
  })
  return appendQuery(walletUrl, query)
}

/** Appends query parameters to a URL that may already contain a query string. */
export function appendQuery(url: string, query: string): string {
  if (!query) return url
  const hash = url.indexOf('#')
  const base = hash >= 0 ? url.slice(0, hash) : url
  const frag = hash >= 0 ? url.slice(hash) : ''
  return `${base}${base.includes('?') ? '&' : '?'}${query}${frag}`
}

export function buildRedirectUrl(redirectUri: string, params: Record<string, string | undefined>): string {
  return appendQuery(redirectUri, encodeQuery(params))
}

/** Extracts query parameters from any URL (custom schemes included). */
export function getUrlParams(url: string): Record<string, string> {
  const q = url.indexOf('?')
  if (q < 0) return {}
  return parseQuery(url.slice(q + 1).split('#')[0])
}

// ---- public protocol objects -----------------------------------------------------------------

export interface DiscoveryDocument {
  issuer: string
  protocol_version: string
  wallet_authorization_endpoint: string
  token_endpoint: string
  device_authorization_endpoint: string
  link_endpoint: string
  revocation_endpoint: string
  grant_info_endpoint: string
  api_base: string
  api_formats_supported: string[]
  scopes_supported: string[]
  slots_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
}

export interface TokenSlot {
  id: SlotId
  label: string
  model?: string
  provider?: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in?: number
  scope: string
  grant_id: string
  sub: string
  issuer: string
  api_base: string
  api_formats: string[]
  slots: TokenSlot[]
}

export interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface LinkInfo {
  user_code: string
  client_id: string
  client_name: string
  client: ClientMetadata
  scope: string
  slots: SlotId[]
  status: 'pending' | 'approved' | 'denied' | 'expired'
  expires_at: number
}

export interface GrantInfo {
  grant_id: string
  client_id: string
  scope: string
  status: GrantStatus
  slots: TokenSlot[]
  budget: {
    tokens_per_day: number | null
    requests_per_day: number | null
    tokens_used_today: number
    requests_today: number
  }
  created_at: number
  expires_at: number | null
}

export type GrantStatus = 'pending' | 'active' | 'paused' | 'revoked'

export type ApiErrorCode =
  | 'invalid_token'
  | 'grant_revoked'
  | 'grant_expired'
  | 'grant_paused'
  | 'insufficient_scope'
  | 'budget_exceeded'
  | 'no_route'
  | 'upstream_auth_failed'
  | 'upstream_error'
  | 'unsupported_format'
  | 'invalid_request'

export interface ApiErrorBody {
  error: { message: string; type: 'modelpass_error'; code: ApiErrorCode }
}

export interface ClientMetadata {
  client_id: string
  name: string
  verified: boolean
  icon?: string
  homepage?: string
  description?: string
  redirect_uris?: string[]
}

// ---- private wallet ↔ hub API ----------------------------------------------------------------

export interface WalletRegisterResponse {
  userId: string
  walletToken: string
}

export interface PutProviderBody {
  name: string
  presetId: string
  format: UpstreamFormat
  models: string[]
  host?: string
  options?: ProviderOptions
  /** Omit to keep the currently stored sealed secret (metadata-only update). */
  sealed?: string
}

export type GrantDelivery =
  | { type: 'code'; codeHash: string; codeChallenge: string; sealedToken: string; redirectUri: string }
  | { type: 'link' }

export interface CreateGrantBody {
  grantId: string
  clientId: string
  clientName?: string
  scope: Scope[]
  slots: SlotId[]
  /** Per-app overrides; slots without an entry follow the global routes. */
  routes: RouteMap
  budget: BudgetConfig
  expiresAt: number | null
  shareModelInfo: boolean
  allowedModels: string[]
  tokenHash: string
  wrappedVk: string
  delivery: GrantDelivery
}

export interface UpdateGrantBody {
  status?: 'active' | 'paused'
  routes?: RouteMap
  slots?: SlotId[]
  budget?: BudgetConfig
  expiresAt?: number | null
  shareModelInfo?: boolean
  allowedModels?: string[]
}

export interface GrantSummary {
  id: string
  clientId: string
  clientName: string
  client: ClientMetadata
  scope: Scope[]
  slots: SlotId[]
  routes: RouteMap
  budget: BudgetConfig
  status: GrantStatus
  shareModelInfo: boolean
  allowedModels: string[]
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  usageToday: { tokens: number; requests: number }
  usageTotal: { tokens: number; requests: number }
}

export interface ActivityEntry {
  id: number
  grantId: string
  clientName: string
  ts: number
  slot: string
  providerId: string | null
  model: string | null
  promptTokens: number
  completionTokens: number
  latencyMs: number
  status: number
  error: string | null
  stream: boolean
}

export interface WalletStateResponse {
  userId: string
  issuer: string
  providers: (ProviderRecord & { hasSecret: boolean })[]
  routes: RouteMap
  grants: GrantSummary[]
}
