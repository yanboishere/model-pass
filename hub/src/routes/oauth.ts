import { Hono, type Context } from 'hono'
import {
  DEFAULT_WALLET_AUTHORIZE_URL,
  DEVICE_CODE_GRANT_TYPE,
  DISCOVERY_PATH,
  PROTOCOL_VERSION,
  SCOPES,
  SLOTS,
  codeChallengeS256,
  constantTimeEqual,
  formatUserCode,
  generateUserCode,
  hashAuthCode,
  hashToken,
  normalizeUserCode,
  openTokenWithCode,
  parseScopeString,
  parseSlotString,
  randomToken,
  sha256Base64url,
  verifyCodeChallenge,
  type DeviceAuthorizationResponse,
  type DiscoveryDocument,
  type LinkInfo,
} from '@modelpass/core'
import { now } from '../store'
import { buildTokenResponse, clientMetadata, issuerOf, oauthError, readParams, type HubDeps } from '../util'

const CODE_TTL = 120
const LINK_TTL = 600
const LINK_INTERVAL = 2

export function oauthRoutes(deps: HubDeps) {
  const { store, config } = deps
  const app = new Hono()

  app.get(DISCOVERY_PATH, (c) => {
    const issuer = issuerOf(c, config)
    const doc: DiscoveryDocument = {
      issuer,
      protocol_version: PROTOCOL_VERSION,
      wallet_authorization_endpoint: DEFAULT_WALLET_AUTHORIZE_URL,
      token_endpoint: `${issuer}/oauth/token`,
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      link_endpoint: `${issuer}/v1/link`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      grant_info_endpoint: `${issuer}/v1/modelpass/grant`,
      api_base: `${issuer}/v1`,
      api_formats_supported: ['openai-chat-completions', 'anthropic-messages'],
      scopes_supported: [...SCOPES],
      slots_supported: [...SLOTS],
      grant_types_supported: ['authorization_code', DEVICE_CODE_GRANT_TYPE],
      code_challenge_methods_supported: ['S256'],
    }
    return c.json(doc)
  })

  app.get('/v1/clients/:clientId', (c) => c.json(clientMetadata(config, c.req.param('clientId'))))

  // ---- token endpoint --------------------------------------------------------------------------
  app.post('/oauth/token', async (c) => {
    const p = await readParams(c)
    store.purgeExpired()

    if (p.grant_type === 'authorization_code') {
      if (!p.code || !p.code_verifier || !p.client_id || !p.redirect_uri) return oauthError(c, 'invalid_request', '缺少 code / code_verifier / client_id / redirect_uri')
      const row = store.takeAuthCode(hashAuthCode(p.code))
      if (!row || row.expiresAt < now()) return oauthError(c, 'invalid_grant', '授权码无效或已过期')
      if (row.clientId !== p.client_id || row.redirectUri !== p.redirect_uri) return oauthError(c, 'invalid_grant', 'client_id 或 redirect_uri 不匹配')
      if (!verifyCodeChallenge(p.code_verifier, row.codeChallenge)) return oauthError(c, 'invalid_grant', 'PKCE 校验失败')
      const grant = store.getGrant(row.grantId)
      if (!grant || grant.status === 'revoked') return oauthError(c, 'invalid_grant', '授权已失效')
      let token: string
      try {
        token = openTokenWithCode(p.code, grant.id, row.sealedToken)
      } catch {
        return oauthError(c, 'invalid_grant', '无法解封令牌')
      }
      if (!constantTimeEqual(hashToken(token), grant.tokenHash)) return oauthError(c, 'invalid_grant', '令牌校验失败')
      if (grant.status === 'pending') store.updateGrant(grant.id, { status: 'active' })
      return c.json(buildTokenResponse(store, { ...grant, status: 'active' }, issuerOf(c, config), token), 200, { 'cache-control': 'no-store' })
    }

    if (p.grant_type === DEVICE_CODE_GRANT_TYPE) {
      if (!p.device_code || !p.client_id) return oauthError(c, 'invalid_request', '缺少 device_code / client_id')
      const hash = sha256Base64url(p.device_code)
      const link = store.getLinkByDeviceCodeHash(hash)
      if (!link || link.clientId !== p.client_id) return oauthError(c, 'invalid_grant', 'device_code 无效')
      const ts = now()
      if (link.expiresAt < ts) {
        store.deleteLink(hash)
        return oauthError(c, 'expired_token', '二维码已过期')
      }
      if (link.status === 'denied') {
        store.deleteLink(hash)
        return oauthError(c, 'access_denied', '用户拒绝了授权')
      }
      if (link.status === 'approved' && link.sealed) {
        store.deleteLink(hash)
        return c.json({ modelpass_sealed: link.sealed }, 200, { 'cache-control': 'no-store' })
      }
      const nowMs = Date.now()
      if (link.lastPollAt && nowMs - link.lastPollAt < link.interval * 1000 - 500) {
        store.updateLink(hash, { lastPollAt: nowMs, interval: link.interval + 5 })
        return oauthError(c, 'slow_down', '轮询过快')
      }
      store.updateLink(hash, { lastPollAt: nowMs })
      return oauthError(c, 'authorization_pending', '等待用户在 ModelPass 中确认')
    }

    return oauthError(c, 'unsupported_grant_type', '不支持的 grant_type')
  })

  // ---- revocation (RFC 7009) ---------------------------------------------------------------------
  app.post('/oauth/revoke', async (c) => {
    const p = await readParams(c)
    if (p.token) {
      const grant = store.getGrantByTokenHash(hashToken(p.token))
      if (grant) store.updateGrant(grant.id, { status: 'revoked' })
    }
    return c.body(null, 200)
  })

  // ---- cross-device link flow ---------------------------------------------------------------------
  app.post('/oauth/device_authorization', async (c) => {
    const p = await readParams(c)
    if (!p.client_id) return oauthError(c, 'invalid_request', '缺少 client_id')
    const scope = parseScopeString(p.scope)
    if (!scope.includes('chat')) return oauthError(c, 'invalid_scope', 'scope 至少需要包含 chat')
    if (p.link_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.link_challenge ?? '')) {
      return oauthError(c, 'invalid_request', '需要 link_challenge（S256）')
    }
    const deviceCode = 'dc_' + randomToken(32)
    let userCode = generateUserCode()
    for (let i = 0; i < 5 && store.getLinkByUserCode(normalizeUserCode(userCode)); i++) userCode = generateUserCode()
    const ts = now()
    store.insertLink({
      deviceCodeHash: sha256Base64url(deviceCode),
      userCode: normalizeUserCode(userCode),
      clientId: p.client_id,
      clientName: p.client_name?.slice(0, 60) || null,
      scope: scope.join(' '),
      slots: parseSlotString(p.slots),
      linkChallenge: p.link_challenge,
      status: 'pending',
      sealed: null,
      interval: LINK_INTERVAL,
      lastPollAt: null,
      createdAt: ts,
      expiresAt: ts + LINK_TTL,
    })
    const resp: DeviceAuthorizationResponse = {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${issuerOf(c, config)}/link`,
      expires_in: LINK_TTL,
      interval: LINK_INTERVAL,
    }
    return c.json(resp, 200, { 'cache-control': 'no-store' })
  })

  app.get('/v1/link/:userCode', (c) => {
    const link = store.getLinkByUserCode(normalizeUserCode(c.req.param('userCode')))
    if (!link) return c.json({ error: 'not_found', error_description: '授权请求不存在或已完成' }, 404)
    const expired = link.expiresAt < now()
    const info: LinkInfo = {
      user_code: formatUserCode(link.userCode),
      client_id: link.clientId,
      client_name: link.clientName ?? link.clientId,
      client: clientMetadata(config, link.clientId, link.clientName),
      scope: link.scope,
      slots: link.slots,
      status: expired ? 'expired' : link.status,
      expires_at: link.expiresAt,
    }
    return c.json(info)
  })

  const verifyLink = async (c: Context) => {
    const link = store.getLinkByUserCode(normalizeUserCode(c.req.param('userCode') ?? ''))
    const body = (await c.req.json().catch(() => ({}))) as { link_verifier?: string; sealed?: string }
    if (!link) return { error: c.json({ error: 'not_found' }, 404) }
    if (link.expiresAt < now()) return { error: c.json({ error: 'expired_token' }, 410) }
    if (!body.link_verifier || !constantTimeEqual(codeChallengeS256(body.link_verifier), link.linkChallenge)) {
      return { error: c.json({ error: 'invalid_grant', error_description: 'link_verifier 校验失败' }, 400) }
    }
    if (link.status !== 'pending') return { error: c.json({ error: 'invalid_grant', error_description: '该请求已处理' }, 409) }
    return { link, body }
  }

  app.post('/v1/link/:userCode/complete', async (c) => {
    const r = await verifyLink(c)
    if ('error' in r) return r.error
    if (!r.body.sealed || r.body.sealed.length > 20_000) return c.json({ error: 'invalid_request' }, 400)
    store.updateLink(r.link.deviceCodeHash, { status: 'approved', sealed: r.body.sealed })
    return c.json({ ok: true })
  })

  app.post('/v1/link/:userCode/deny', async (c) => {
    const r = await verifyLink(c)
    if ('error' in r) return r.error
    store.updateLink(r.link.deviceCodeHash, { status: 'denied' })
    return c.json({ ok: true })
  })

  return app
}

export { CODE_TTL }
