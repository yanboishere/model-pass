// Wallet-side client for the hub's private API. Holds the vault key in memory and performs all
// sealing locally, so provider secrets and access tokens never reach the hub in plaintext at rest.

import { randomId } from './crypto'
import { linkVerifier, sealLinkPayload, type ParsedLink } from './link'
import {
  buildRedirectUrl,
  type ActivityEntry,
  type AuthorizationRequest,
  type BudgetConfig,
  type CreateGrantBody,
  type GrantSummary,
  type LinkInfo,
  type ProviderRecord,
  type ProviderSecret,
  type PutProviderBody,
  type RouteMap,
  type Scope,
  type SlotId,
  type TokenResponse,
  type UpdateGrantBody,
  type WalletRegisterResponse,
  type WalletStateResponse,
} from './protocol'
import {
  generateAccessToken,
  generateAuthCode,
  generateVaultKey,
  hashAuthCode,
  hashToken,
  sealProviderSecret,
  sealTokenWithCode,
  wrapVaultKey,
} from './vault'

export interface GrantOptions {
  scope: Scope[]
  slots: SlotId[]
  routes: RouteMap
  budget: BudgetConfig
  expiresAt: number | null
  shareModelInfo: boolean
  allowedModels: string[]
  clientName?: string
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type FetchLike = typeof fetch

export interface WalletIdentity {
  hubUrl: string
  userId: string
  walletToken: string
  vaultKey: Uint8Array
}

export class WalletClient {
  readonly hubUrl: string
  private readonly fetchImpl: FetchLike

  constructor(
    readonly identity: WalletIdentity,
    fetchImpl?: FetchLike,
  ) {
    this.hubUrl = identity.hubUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args))
  }

  /** Creates a new wallet account on a hub and a fresh vault key (kept on the device only). */
  static async register(hubUrl: string, fetchImpl?: FetchLike): Promise<WalletIdentity> {
    const f = fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args))
    const base = hubUrl.replace(/\/+$/, '')
    const res = await f(`${base}/wallet/v1/register`, { method: 'POST' })
    if (!res.ok) throw new HubError(res.status, `注册失败：${res.status} ${await res.text().catch(() => '')}`)
    const body = (await res.json()) as WalletRegisterResponse
    return { hubUrl: base, userId: body.userId, walletToken: body.walletToken, vaultKey: generateVaultKey() }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.hubUrl}/wallet/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.identity.walletToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) throw new HubError(res.status, (json as { error?: string } | null)?.error ?? `${res.status} ${text.slice(0, 200)}`)
    return json as T
  }

  getState() {
    return this.call<WalletStateResponse>('GET', '/state')
  }

  /** Seals `secret` (if given) with the vault key and uploads the provider. */
  async putProvider(record: Omit<ProviderRecord, 'createdAt' | 'updatedAt'>, secret?: ProviderSecret) {
    const body: PutProviderBody = {
      name: record.name,
      presetId: record.presetId,
      format: record.format,
      models: record.models,
      host: record.host,
      options: record.options,
      sealed: secret ? sealProviderSecret(this.identity.vaultKey, this.identity.userId, record.id, secret) : undefined,
    }
    await this.call('PUT', `/providers/${encodeURIComponent(record.id)}`, body)
  }

  async deleteProvider(id: string) {
    await this.call('DELETE', `/providers/${encodeURIComponent(id)}`)
  }

  async putRoutes(routes: RouteMap): Promise<RouteMap> {
    return (await this.call<{ routes: RouteMap }>('PUT', '/routes', { routes })).routes
  }

  private async createGrant(clientId: string, opts: GrantOptions, delivery: (grantId: string, token: string) => CreateGrantBody['delivery']) {
    const grantId = randomId('g_', 16)
    const { token, secret } = generateAccessToken()
    const body: CreateGrantBody = {
      grantId,
      clientId,
      clientName: opts.clientName,
      scope: opts.scope,
      slots: opts.slots,
      routes: opts.routes,
      budget: opts.budget,
      expiresAt: opts.expiresAt,
      shareModelInfo: opts.shareModelInfo,
      allowedModels: opts.allowedModels,
      tokenHash: hashToken(token),
      wrappedVk: wrapVaultKey(this.identity.vaultKey, secret, grantId),
      delivery: delivery(grantId, token),
    }
    const res = await this.call<{ grant: GrantSummary; tokenResponse: Omit<TokenResponse, 'access_token'> }>('POST', '/grants', body)
    return { ...res, token }
  }

  /**
   * Same-device flow: creates the grant and returns the URL to send the user back to the app
   * (`redirect_uri?code=…&state=…&iss=…`). The code is minted here and never stored in plaintext.
   */
  async approveAuthorization(req: AuthorizationRequest, opts: GrantOptions): Promise<{ redirectUrl: string; grant: GrantSummary }> {
    const code = generateAuthCode()
    const { grant, tokenResponse } = await this.createGrant(req.clientId, opts, (grantId, token) => ({
      type: 'code',
      codeHash: hashAuthCode(code),
      codeChallenge: req.codeChallenge,
      sealedToken: sealTokenWithCode(code, grantId, token),
      redirectUri: req.redirectUri,
    }))
    return { grant, redirectUrl: buildRedirectUrl(req.redirectUri, { code, state: req.state, iss: tokenResponse.issuer }) }
  }

  denyAuthorization(req: Pick<AuthorizationRequest, 'redirectUri' | 'state'>, description = '用户拒绝了授权'): string {
    return buildRedirectUrl(req.redirectUri, { error: 'access_denied', error_description: description, state: req.state })
  }

  async getLinkInfo(link: ParsedLink): Promise<LinkInfo> {
    const res = await this.fetchImpl(`${link.rendezvous}/v1/link/${encodeURIComponent(link.userCode)}`)
    if (!res.ok) throw new HubError(res.status, res.status === 404 ? '授权请求不存在或已失效' : `读取授权请求失败（${res.status}）`)
    return (await res.json()) as LinkInfo
  }

  /** Cross-device flow: creates the grant on this wallet's hub, then hands the sealed token to the rendezvous. */
  async approveLink(link: ParsedLink, info: LinkInfo, opts: GrantOptions): Promise<GrantSummary> {
    const { grant, tokenResponse, token } = await this.createGrant(info.client_id, opts, () => ({ type: 'link' }))
    const payload: TokenResponse = { ...tokenResponse, access_token: token }
    const sealed = sealLinkPayload(link.secret, link.userCode, payload)
    const res = await this.fetchImpl(`${link.rendezvous}/v1/link/${encodeURIComponent(link.userCode)}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link_verifier: linkVerifier(link.secret), sealed }),
    })
    if (!res.ok) {
      await this.revokeGrant(grant.id).catch(() => undefined)
      throw new HubError(res.status, res.status === 410 ? '二维码已过期' : `提交授权失败（${res.status}）`)
    }
    return grant
  }

  async denyLink(link: ParsedLink) {
    await this.fetchImpl(`${link.rendezvous}/v1/link/${encodeURIComponent(link.userCode)}/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link_verifier: linkVerifier(link.secret) }),
    })
  }

  async updateGrant(id: string, patch: UpdateGrantBody): Promise<GrantSummary> {
    return (await this.call<{ grant: GrantSummary }>('PATCH', `/grants/${encodeURIComponent(id)}`, patch)).grant
  }

  async revokeGrant(id: string) {
    await this.call('DELETE', `/grants/${encodeURIComponent(id)}`)
  }

  async activity(limit = 50, grantId?: string): Promise<ActivityEntry[]> {
    const q = `?limit=${limit}${grantId ? `&grantId=${encodeURIComponent(grantId)}` : ''}`
    return (await this.call<{ activity: ActivityEntry[] }>('GET', `/activity${q}`)).activity
  }
}
