import type { Context } from 'hono'
import {
  SLOT_INFO,
  sha256Base64url,
  type ApiErrorCode,
  type ClientMetadata,
  type GrantSummary,
  type OAuthErrorCode,
  type TokenResponse,
  type TokenSlot,
} from '@modelpass/core'
import type { HubConfig } from './config'
import { dayKey, now, type GrantRow, type Store } from './store'

export interface HubDeps {
  store: Store
  config: HubConfig
  /** Injected for tests (mock upstreams). */
  fetch: typeof fetch
}

export interface ApiFailure {
  status: number
  code: ApiErrorCode
  message: string
}

export function apiError(c: Context, f: ApiFailure, headers?: Record<string, string>) {
  return c.json({ error: { message: f.message, type: 'modelpass_error', code: f.code } }, f.status as 400, headers)
}

export function oauthError(c: Context, error: OAuthErrorCode, description: string, status = 400) {
  return c.json({ error, error_description: description }, status as 400, { 'cache-control': 'no-store' })
}

/** The issuer is fixed by MODELPASS_PUBLIC_URL, otherwise derived from the request (dev mode). */
export function issuerOf(c: Context, config: HubConfig): string {
  if (config.publicUrl) return config.publicUrl
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host
  return `${proto}://${host}`
}

export async function readParams(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  }
  const body = await c.req.parseBody().catch(() => ({}))
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']))
}

// ---- clients ---------------------------------------------------------------------------------

export function findClient(config: HubConfig, clientId: string): ClientMetadata | null {
  return config.clients.find((c) => c.client_id === clientId) ?? null
}

export function clientMetadata(config: HubConfig, clientId: string, fallbackName?: string | null): ClientMetadata {
  return (
    findClient(config, clientId) ?? {
      client_id: clientId,
      name: fallbackName || clientId,
      verified: false,
    }
  )
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/?#]*')
  return new RegExp(`^${escaped}$`)
}

/** Registered clients must use one of their redirect URIs; unregistered clients are shown as unverified. */
export function redirectAllowed(config: HubConfig, clientId: string, redirectUri: string): boolean {
  const client = findClient(config, clientId)
  if (!client?.redirect_uris?.length) return true
  return client.redirect_uris.some((p) => (p.includes('*') ? globToRegExp(p).test(redirectUri) : p === redirectUri))
}

// ---- grants & tokens -------------------------------------------------------------------------

export function pairwiseSub(userId: string, clientId: string): string {
  return 'u' + sha256Base64url(`modelpass-sub|${userId}|${clientId}`).slice(0, 22)
}

export function tokenSlots(store: Store, grant: GrantRow, share: boolean): TokenSlot[] {
  const providers = share ? store.listProviders(grant.userId) : []
  const global = share ? store.getRoutes(grant.userId) : {}
  return grant.slots.map((id) => {
    const slot: TokenSlot = { id, label: SLOT_INFO[id].label }
    if (share) {
      const t = grant.routes[id] ?? global[id] ?? grant.routes.default ?? global.default
      const p = t && providers.find((x) => x.id === t.providerId)
      if (t && p) {
        slot.model = t.model
        slot.provider = p.name
      }
    }
    return slot
  })
}

export function buildTokenResponse(store: Store, grant: GrantRow, issuer: string, accessToken: string): TokenResponse {
  const resp: TokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    scope: grant.scope.join(' '),
    grant_id: grant.id,
    sub: pairwiseSub(grant.userId, grant.clientId),
    issuer,
    api_base: `${issuer}/v1`,
    api_formats: ['openai-chat-completions', 'anthropic-messages'],
    slots: tokenSlots(store, grant, grant.shareModelInfo),
  }
  if (grant.expiresAt) resp.expires_in = Math.max(0, grant.expiresAt - now())
  return resp
}

export function grantSummary(store: Store, config: HubConfig, g: GrantRow): GrantSummary {
  return {
    id: g.id,
    clientId: g.clientId,
    clientName: g.clientName,
    client: clientMetadata(config, g.clientId, g.clientName),
    scope: g.scope,
    slots: g.slots,
    routes: g.routes,
    budget: g.budget,
    status: g.status,
    shareModelInfo: g.shareModelInfo,
    allowedModels: g.allowedModels,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    lastUsedAt: g.lastUsedAt,
    usageToday: store.usageForDay(g.id, dayKey(now())),
    usageTotal: store.usageTotal(g.id),
  }
}
