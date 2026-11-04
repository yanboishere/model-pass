import { Hono, type Context } from 'hono'
import {
  SLOTS,
  hashToken,
  isSlot,
  parseScopeString,
  randomId,
  randomToken,
  type CreateGrantBody,
  type PutProviderBody,
  type RouteMap,
  type UpdateGrantBody,
  type UpstreamFormat,
  type WalletRegisterResponse,
  type WalletStateResponse,
} from '@modelpass/core'
import { now } from '../store'
import { buildTokenResponse, grantSummary, issuerOf, redirectAllowed, type HubDeps } from '../util'
import { CODE_TTL } from './oauth'

const FORMATS: UpstreamFormat[] = ['openai-chat', 'anthropic-messages', 'openai-responses']
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

type Env = { Variables: { userId: string } }

function sanitizeRoutes(routes: unknown, providerIds: Set<string>): RouteMap {
  const out: RouteMap = {}
  if (!routes || typeof routes !== 'object') return out
  for (const [slot, t] of Object.entries(routes as Record<string, { providerId?: unknown; model?: unknown }>)) {
    if (!isSlot(slot) || !t || typeof t !== 'object') continue
    if (typeof t.providerId === 'string' && typeof t.model === 'string' && t.model && providerIds.has(t.providerId)) {
      out[slot] = { providerId: t.providerId, model: t.model.slice(0, 200) }
    }
  }
  return out
}

const bad = (c: Context, message: string, status = 400) => c.json({ error: message }, status as 400)

export function walletRoutes(deps: HubDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.post('/register', (c) => {
    if (!config.openRegistration) return bad(c, 'registration is closed on this hub', 403)
    const userId = randomId('u_', 16)
    const walletToken = 'mpw_' + randomToken(32)
    store.createUser(userId, hashToken(walletToken))
    const body: WalletRegisterResponse = { userId, walletToken }
    return c.json(body, 201)
  })

  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const userId = token ? store.getUserIdByWalletTokenHash(hashToken(token)) : null
    if (!userId) return bad(c, 'invalid wallet token', 401)
    c.set('userId', userId)
    await next()
  })

  app.get('/state', (c) => {
    const userId = c.get('userId')
    store.purgeStalePending(now() - 600)
    const body: WalletStateResponse = {
      userId,
      issuer: issuerOf(c, config),
      providers: store.listProviders(userId).map(({ sealed, ...p }) => ({ ...p, hasSecret: Boolean(sealed) })),
      routes: store.getRoutes(userId),
      grants: store.listGrants(userId).map((g) => grantSummary(store, config, g)),
    }
    return c.json(body)
  })

  app.put('/providers/:id', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as PutProviderBody | null
    if (!ID_RE.test(id) || !body) return bad(c, 'invalid provider')
    if (!body.name || !FORMATS.includes(body.format) || !Array.isArray(body.models)) return bad(c, 'invalid provider fields')
    if (body.sealed !== undefined && (typeof body.sealed !== 'string' || body.sealed.length > 64_000)) return bad(c, 'invalid sealed secret')
    store.upsertProvider(
      userId,
      {
        id,
        name: String(body.name).slice(0, 80),
        presetId: String(body.presetId ?? 'custom-openai').slice(0, 64),
        format: body.format,
        models: body.models.map(String).slice(0, 500),
        host: body.host?.slice(0, 200),
        options: body.options,
      },
      body.sealed,
    )
    return c.json({ ok: true })
  })

  app.delete('/providers/:id', (c) => {
    store.deleteProvider(c.get('userId'), c.req.param('id'))
    return c.json({ ok: true })
  })

  app.put('/routes', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as { routes?: unknown }
    const ids = new Set(store.listProviders(userId).map((p) => p.id))
    const routes = sanitizeRoutes(body.routes, ids)
    store.setRoutes(userId, routes)
    return c.json({ ok: true, routes })
  })

  app.post('/grants', async (c) => {
    const userId = c.get('userId')
    const b = (await c.req.json().catch(() => null)) as CreateGrantBody | null
    if (!b) return bad(c, 'invalid body')
    if (!/^g_[A-Za-z0-9]{16}$/.test(b.grantId ?? '') || store.getGrant(b.grantId)) return bad(c, 'invalid or duplicate grantId')
    if (!b.clientId || typeof b.clientId !== 'string') return bad(c, 'missing clientId')
    const scope = parseScopeString((b.scope ?? []).join(' '))
    if (!scope.includes('chat')) return bad(c, 'scope must include chat')
    if (!/^[A-Za-z0-9_-]{43}$/.test(b.tokenHash ?? '') || !b.wrappedVk) return bad(c, 'missing token material')
    const providerIds = new Set(store.listProviders(userId).map((p) => p.id))
    const slots = Array.from(new Set(['default', ...(b.slots ?? [])].filter(isSlot)))
    const delivery = b.delivery
    if (delivery?.type === 'code') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(delivery.codeChallenge ?? '') || !delivery.codeHash || !delivery.sealedToken || !delivery.redirectUri) {
        return bad(c, 'invalid code delivery')
      }
      if (!redirectAllowed(config, b.clientId, delivery.redirectUri)) return bad(c, 'redirect_uri is not registered for this client')
    } else if (delivery?.type !== 'link') {
      return bad(c, 'invalid delivery')
    }

    const ts = now()
    const grant = {
      id: b.grantId,
      userId,
      clientId: b.clientId.slice(0, 200),
      clientName: (b.clientName || b.clientId).slice(0, 80),
      scope,
      slots: SLOTS.filter((s) => slots.includes(s)),
      routes: sanitizeRoutes(b.routes, providerIds),
      budget: {
        tokensPerDay: typeof b.budget?.tokensPerDay === 'number' && b.budget.tokensPerDay > 0 ? Math.floor(b.budget.tokensPerDay) : null,
        requestsPerDay: typeof b.budget?.requestsPerDay === 'number' && b.budget.requestsPerDay > 0 ? Math.floor(b.budget.requestsPerDay) : null,
      },
      allowedModels: Array.isArray(b.allowedModels) ? b.allowedModels.map(String).slice(0, 200) : [],
      shareModelInfo: Boolean(b.shareModelInfo),
      tokenHash: b.tokenHash,
      wrappedVk: String(b.wrappedVk),
      status: delivery.type === 'code' ? ('pending' as const) : ('active' as const),
      createdAt: ts,
      expiresAt: typeof b.expiresAt === 'number' && b.expiresAt > ts ? Math.floor(b.expiresAt) : null,
      lastUsedAt: null,
    }
    store.insertGrant(grant)
    if (delivery.type === 'code') {
      store.insertAuthCode({
        codeHash: delivery.codeHash,
        grantId: grant.id,
        clientId: grant.clientId,
        redirectUri: delivery.redirectUri,
        codeChallenge: delivery.codeChallenge,
        sealedToken: delivery.sealedToken,
        expiresAt: ts + CODE_TTL,
      })
    }
    const { access_token: _omit, ...tokenResponse } = buildTokenResponse(store, grant, issuerOf(c, config), '')
    return c.json({ grant: grantSummary(store, config, grant), tokenResponse }, 201)
  })

  app.patch('/grants/:id', async (c) => {
    const userId = c.get('userId')
    const g = store.getGrant(c.req.param('id'))
    if (!g || g.userId !== userId) return bad(c, 'not found', 404)
    if (g.status === 'revoked') return bad(c, 'grant revoked', 409)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as UpdateGrantBody
    const providerIds = new Set(store.listProviders(userId).map((p) => p.id))
    const patch: Parameters<typeof store.updateGrant>[1] = {}
    if (b.status === 'active' || b.status === 'paused') patch.status = b.status
    if (b.routes) patch.routes = sanitizeRoutes(b.routes, providerIds)
    if (b.slots) patch.slots = SLOTS.filter((s) => s === 'default' || b.slots!.includes(s))
    if (b.budget) {
      patch.budget = {
        tokensPerDay: b.budget.tokensPerDay && b.budget.tokensPerDay > 0 ? Math.floor(b.budget.tokensPerDay) : null,
        requestsPerDay: b.budget.requestsPerDay && b.budget.requestsPerDay > 0 ? Math.floor(b.budget.requestsPerDay) : null,
      }
    }
    if (b.expiresAt !== undefined) patch.expiresAt = b.expiresAt && b.expiresAt > now() ? Math.floor(b.expiresAt) : null
    if (b.shareModelInfo !== undefined) patch.shareModelInfo = Boolean(b.shareModelInfo)
    if (b.allowedModels) patch.allowedModels = b.allowedModels.map(String).slice(0, 200)
    store.updateGrant(g.id, patch)
    return c.json({ grant: grantSummary(store, config, store.getGrant(g.id)!) })
  })

  app.delete('/grants/:id', (c) => {
    const g = store.getGrant(c.req.param('id'))
    if (!g || g.userId !== c.get('userId')) return bad(c, 'not found', 404)
    store.updateGrant(g.id, { status: 'revoked' })
    return c.json({ ok: true })
  })

  app.get('/activity', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)))
    return c.json({ activity: store.listActivity(c.get('userId'), limit, c.req.query('grantId') || undefined) })
  })

  return app
}
