import { isSlot, type ProviderRecord, type RouteMap, type RouteTarget, type Scope, type SlotId, type UpstreamFormat } from './protocol'

export interface RoutingContext {
  grantSlots: SlotId[]
  grantScope: Scope[]
  /** Per-app overrides set by the user in the wallet. */
  grantRoutes: RouteMap
  /** The user's global routes ("follow global"). */
  globalRoutes: RouteMap
  /** Explicit models the user allowed for `model_choice`, as "providerId:model". */
  allowedModels: string[]
  providers: Pick<ProviderRecord, 'id'>[]
}

export interface ResolvedRoute {
  slot: SlotId
  target: RouteTarget | null
  /** The requested model did not match anything the app may use; `default` was used instead. */
  fallback: boolean
  /** Resolved through `model_choice` to an explicitly named model. */
  explicit: boolean
}

/**
 * Resolves the `model` field of an API request (protocol §8.3):
 *  1. a granted slot id (or `modelpass/<slot>`) → that slot's route
 *  2. with `model_choice`, a model the user allowed → that provider/model
 *  3. anything else → the `default` slot, flagged as a fallback
 * Slots without their own route fall back to the `default` route.
 */
export function resolveRoute(requested: string | undefined | null, ctx: RoutingContext): ResolvedRoute {
  const name = (requested ?? '').trim()
  const bare = name.startsWith('modelpass/') ? name.slice('modelpass/'.length) : name

  if (isSlot(bare) && ctx.grantSlots.includes(bare)) {
    return { slot: bare, target: slotTarget(bare, ctx), fallback: false, explicit: false }
  }

  if (name && ctx.grantScope.includes('model_choice')) {
    for (const entry of ctx.allowedModels) {
      const sep = entry.indexOf(':')
      if (sep <= 0) continue
      const providerId = entry.slice(0, sep)
      const model = entry.slice(sep + 1)
      if ((model === name || entry === name) && ctx.providers.some((p) => p.id === providerId)) {
        return { slot: 'default', target: { providerId, model }, fallback: false, explicit: true }
      }
    }
  }

  return { slot: 'default', target: slotTarget('default', ctx), fallback: name !== '' && bare !== 'default', explicit: false }
}

export function slotTarget(slot: SlotId, ctx: Pick<RoutingContext, 'grantRoutes' | 'globalRoutes' | 'providers'>): RouteTarget | null {
  const candidates = [ctx.grantRoutes[slot], ctx.globalRoutes[slot]]
  if (slot !== 'default') candidates.push(ctx.grantRoutes.default, ctx.globalRoutes.default)
  for (const t of candidates) {
    if (t && t.model && ctx.providers.some((p) => p.id === t.providerId)) return t
  }
  return null
}

// ---- upstream endpoints -----------------------------------------------------------------------

export function normalizeBaseUrl(format: UpstreamFormat, baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  if (format === 'anthropic-messages') url = url.replace(/\/v1$/, '')
  return url
}

export function upstreamEndpoints(format: UpstreamFormat, baseUrl: string) {
  const base = normalizeBaseUrl(format, baseUrl)
  switch (format) {
    case 'anthropic-messages':
      return { chat: `${base}/v1/messages`, models: `${base}/v1/models` }
    case 'openai-responses':
      return { chat: `${base}/responses`, models: `${base}/models` }
    default:
      return { chat: `${base}/chat/completions`, models: `${base}/models` }
  }
}

/** Auth headers for an upstream request (API key or OAuth bearer). */
export function upstreamAuthHeaders(format: UpstreamFormat, credential: string | undefined): Record<string, string> {
  if (!credential) return {}
  if (format === 'anthropic-messages') return { 'x-api-key': credential, 'anthropic-version': '2023-06-01' }
  return { authorization: `Bearer ${credential}` }
}

export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)
  return m ? m[1] : url
}
