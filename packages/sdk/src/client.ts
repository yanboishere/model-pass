import {
  DEFAULT_WALLET_AUTHORIZE_URL,
  DEVICE_CODE_GRANT_TYPE,
  DISCOVERY_PATH,
  base64urlEncode,
  buildAuthorizationUrl,
  buildLinkUrl,
  codeChallengeS256,
  createCodeVerifier,
  createLinkSecret,
  createState,
  encodeQuery,
  getUrlParams,
  linkChallenge,
  linkVerifier,
  openLinkPayload,
  type DeviceAuthorizationResponse,
  type DiscoveryDocument,
  type GrantInfo,
  type Scope,
  type SlotId,
  type TokenResponse,
} from '@modelpass/core'
import { ChatApi } from './chat'
import { ModelPassError } from './errors'
import { MemoryStorage, type ModelPassStorage } from './storage'

export interface ModelPassClientOptions {
  /** Your app id, e.g. the iOS bundle id / Android package name. */
  clientId: string
  /** Where the wallet sends the user back, e.g. `myapp://modelpass-callback`. */
  redirectUri: string
  clientName?: string
  scopes?: Scope[]
  slots?: SlotId[]
  /** Wallet entry point. Default `modelpass://authorize`. */
  walletAuthorizeUrl?: string
  /** If set, only these issuers (hubs) are accepted. */
  trustedIssuers?: string[]
  /** Accept plain-http issuers outside localhost / private networks (development only). */
  allowInsecureIssuers?: boolean
  storage?: ModelPassStorage
  /** Defaults to global fetch. On React Native pass `fetch` from `expo/fetch` for streaming. */
  fetch?: typeof fetch
  /** Opens a URL (e.g. `Linking.openURL`). Required for `authorize()`. */
  openUrl?: (url: string) => Promise<unknown> | unknown
  storageKeyPrefix?: string
}

export interface ModelPassSession extends TokenResponse {
  /** epoch seconds */
  obtained_at: number
  /** epoch seconds, when the grant expires (if the user set an expiry) */
  expires_at?: number
}

export interface AuthorizeOptions {
  scopes?: Scope[]
  slots?: SlotId[]
  budgetHint?: number
}

interface PendingAuthorization {
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

const now = () => Math.floor(Date.now() / 1000)

function isPrivateHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').toLowerCase()
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '[::1]'
  )
}

export class ModelPassClient {
  readonly chat: ChatApi
  private readonly opts: Required<Pick<ModelPassClientOptions, 'walletAuthorizeUrl' | 'storageKeyPrefix' | 'scopes' | 'slots'>> & ModelPassClientOptions
  private readonly storage: ModelPassStorage
  private readonly fetchImpl: typeof fetch
  private current: ModelPassSession | null | undefined
  private listeners = new Set<(s: ModelPassSession | null) => void>()
  private waiter: { resolve: (s: ModelPassSession) => void; reject: (e: Error) => void } | null = null
  private inflight = new Map<string, Promise<ModelPassSession | null>>()

  constructor(options: ModelPassClientOptions) {
    this.opts = {
      walletAuthorizeUrl: DEFAULT_WALLET_AUTHORIZE_URL,
      storageKeyPrefix: 'modelpass',
      scopes: ['chat'],
      slots: ['default'],
      ...options,
    }
    this.storage = options.storage ?? new MemoryStorage()
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args))
    this.chat = new ChatApi(this, this.fetchImpl)
  }

  private key(name: string) {
    return `${this.opts.storageKeyPrefix}.${this.opts.clientId}.${name}`
  }

  // ---- session --------------------------------------------------------------------------------

  async getSession(): Promise<ModelPassSession | null> {
    if (this.current === undefined) {
      const raw = await this.storage.getItem(this.key('session'))
      this.current = raw ? (JSON.parse(raw) as ModelPassSession) : null
    }
    if (this.current?.expires_at && this.current.expires_at < now()) {
      await this.setSession(null)
    }
    return this.current ?? null
  }

  /** Synchronous view of the session (after `getSession()` has been awaited once). */
  get session(): ModelPassSession | null {
    return this.current ?? null
  }

  onSessionChange(listener: (s: ModelPassSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async setSession(s: ModelPassSession | null) {
    this.current = s
    if (s) await this.storage.setItem(this.key('session'), JSON.stringify(s))
    else await this.storage.removeItem(this.key('session'))
    for (const l of this.listeners) l(s)
  }

  /** Called by the chat helpers when the hub reports the grant is gone. */
  async invalidate() {
    await this.setSession(null)
  }

  private toSession(t: TokenResponse): ModelPassSession {
    const obtained = now()
    return { ...t, obtained_at: obtained, ...(t.expires_in ? { expires_at: obtained + t.expires_in } : {}) }
  }

  // ---- same-device flow --------------------------------------------------------------------------

  /** Builds the wallet URL and persists the pending request (survives app restarts). */
  async createAuthorizationUrl(options: AuthorizeOptions = {}): Promise<string> {
    const pending: PendingAuthorization = {
      state: createState(),
      codeVerifier: createCodeVerifier(),
      redirectUri: this.opts.redirectUri,
      createdAt: now(),
    }
    await this.storage.setItem(this.key('pending'), JSON.stringify(pending))
    return buildAuthorizationUrl(this.opts.walletAuthorizeUrl, {
      clientId: this.opts.clientId,
      redirectUri: this.opts.redirectUri,
      scope: options.scopes ?? this.opts.scopes,
      slots: options.slots ?? this.opts.slots,
      state: pending.state,
      codeChallenge: codeChallengeS256(pending.codeVerifier),
      clientName: this.opts.clientName,
      budgetHint: options.budgetHint,
    })
  }

  /** Opens the ModelPass wallet and resolves once the user approved and the code was exchanged. */
  async authorize(options: AuthorizeOptions = {}): Promise<ModelPassSession> {
    if (!this.opts.openUrl) throw new ModelPassError('invalid_request', 'openUrl is required for authorize()')
    const url = await this.createAuthorizationUrl(options)
    this.waiter?.reject(new ModelPassError('cancelled', '授权已被新的请求取代'))
    const result = new Promise<ModelPassSession>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
    try {
      await this.opts.openUrl(url)
    } catch (e) {
      this.waiter = null
      throw new ModelPassError('wallet_not_installed', `无法打开 ModelPass：${(e as Error).message}`)
    }
    return result
  }

  /** True if `url` is a ModelPass callback for this client. */
  isRedirect(url: string): boolean {
    const base = this.opts.redirectUri.split('?')[0]
    return url.split('?')[0].split('#')[0] === base
  }

  /**
   * Handle an incoming deep link. Returns the session if the URL was a ModelPass callback,
   * `null` if it wasn't. Throws ModelPassError on a failed authorization.
   */
  async handleRedirect(url: string): Promise<ModelPassSession | null> {
    if (!this.isRedirect(url)) return null
    const params = getUrlParams(url)
    // The same callback can arrive twice (initial URL + url event); share one exchange.
    const key = params.state ?? ''
    const running = this.inflight.get(key)
    if (running) return running
    const job = this.processRedirect(params).finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  private async processRedirect(params: Record<string, string>): Promise<ModelPassSession | null> {
    const raw = await this.storage.getItem(this.key('pending'))
    const pending = raw ? (JSON.parse(raw) as PendingAuthorization) : null
    if (!pending) return this.current ?? null
    const settle = (e: ModelPassError | null, s?: ModelPassSession) => {
      const w = this.waiter
      this.waiter = null
      if (e) w?.reject(e)
      else if (s) w?.resolve(s)
    }
    try {
      if (params.state !== pending.state) throw new ModelPassError('invalid_state', 'state 不匹配，已忽略该回调')
      await this.storage.removeItem(this.key('pending'))
      if (params.error) {
        throw new ModelPassError(params.error === 'access_denied' ? 'access_denied' : params.error, params.error_description || '授权未完成')
      }
      if (!params.code || !params.iss) throw new ModelPassError('invalid_response', '回调缺少 code 或 iss')
      const issuer = this.checkIssuer(params.iss)
      const tokenEndpoint = await this.discoverTokenEndpoint(issuer)
      const res = await this.fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: encodeQuery({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: pending.redirectUri,
          client_id: this.opts.clientId,
          code_verifier: pending.codeVerifier,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
      if (!res.ok || !body.access_token) {
        throw new ModelPassError('token_exchange_failed', body.error_description || body.error || `换取令牌失败（${res.status}）`, res.status)
      }
      const session = this.toSession(body)
      await this.setSession(session)
      settle(null, session)
      return session
    } catch (e) {
      const err = e instanceof ModelPassError ? e : new ModelPassError('invalid_response', (e as Error).message)
      settle(err)
      throw err
    }
  }

  private checkIssuer(iss: string): string {
    // Regex instead of URL: React Native's URL implementation is incomplete.
    const m = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?$/i.exec(iss.trim())
    if (!m) throw new ModelPassError('untrusted_issuer', `无效的 issuer：${iss}`)
    const issuer = iss.trim().replace(/\/+$/, '')
    if (this.opts.trustedIssuers && !this.opts.trustedIssuers.map((x) => x.replace(/\/+$/, '')).includes(issuer)) {
      throw new ModelPassError('untrusted_issuer', `不在受信列表中的 Hub：${issuer}`)
    }
    const scheme = m[1].toLowerCase()
    if (scheme === 'https') return issuer
    if (isPrivateHost(m[2]) || this.opts.allowInsecureIssuers) return issuer
    throw new ModelPassError('untrusted_issuer', `Hub 必须使用 https：${issuer}`)
  }

  private async discoverTokenEndpoint(issuer: string): Promise<string> {
    try {
      const res = await this.fetchImpl(`${issuer}${DISCOVERY_PATH}`, { headers: { accept: 'application/json' } })
      if (res.ok) {
        const doc = (await res.json()) as DiscoveryDocument
        if (doc.issuer?.replace(/\/+$/, '') !== issuer) throw new ModelPassError('untrusted_issuer', '发现文档中的 issuer 与回调不一致')
        if (doc.token_endpoint) return doc.token_endpoint
      }
    } catch (e) {
      if (e instanceof ModelPassError) throw e
    }
    return `${issuer}/oauth/token`
  }

  // ---- cross-device link flow ----------------------------------------------------------------

  async startLink(rendezvous: string, options: AuthorizeOptions = {}): Promise<LinkAuthorization> {
    const base = rendezvous.replace(/\/+$/, '')
    const secret = createLinkSecret()
    const res = await this.fetchImpl(`${base}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: encodeQuery({
        client_id: this.opts.clientId,
        client_name: this.opts.clientName,
        scope: (options.scopes ?? this.opts.scopes).join(' '),
        slots: (options.slots ?? this.opts.slots).join(' '),
        link_challenge: linkChallenge(linkVerifier(secret)),
        link_challenge_method: 'S256',
      }),
    })
    const body = (await res.json().catch(() => ({}))) as DeviceAuthorizationResponse & { error?: string; error_description?: string }
    if (!res.ok || !body.device_code) throw new ModelPassError(body.error ?? 'invalid_response', body.error_description ?? `发起扫码授权失败（${res.status}）`, res.status)
    return new LinkAuthorization(this, base, body, secret, this.fetchImpl, (t) => this.completeLink(t))
  }

  private async completeLink(t: TokenResponse): Promise<ModelPassSession> {
    this.checkIssuer(t.issuer)
    const session = this.toSession(t)
    await this.setSession(session)
    return session
  }

  get clientId() {
    return this.opts.clientId
  }

  // ---- grant management -------------------------------------------------------------------------

  async grantInfo(): Promise<GrantInfo> {
    const res = await this.apiFetch('/modelpass/grant', { method: 'GET' })
    return (await res.json()) as GrantInfo
  }

  /** Deep link into the wallet's management page for this app's grant. */
  manageUrl(walletBase = 'modelpass://'): string | null {
    return this.current ? `${walletBase.replace(/\/*$/, '/')}grants/${this.current.grant_id}` : null
  }

  async signOut(options: { revoke?: boolean } = {}) {
    const s = await this.getSession()
    if (s && options.revoke !== false) {
      await this.fetchImpl(`${s.issuer}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: encodeQuery({ token: s.access_token }),
      }).catch(() => undefined)
    }
    await this.setSession(null)
  }

  /** Authorized fetch against `api_base` with ModelPass error mapping. */
  async apiFetch(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
    const s = await this.getSession()
    if (!s) throw new ModelPassError('not_connected', '尚未连接 ModelPass')
    const res = await this.fetchImpl(`${s.api_base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${s.access_token}`, ...(init.headers as Record<string, string> | undefined) },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null
      const code = body?.error?.code ?? 'upstream_error'
      if (res.status === 401 && ['invalid_token', 'grant_revoked', 'grant_expired'].includes(code)) await this.invalidate()
      throw new ModelPassError(code, body?.error?.message ?? `请求失败（${res.status}）`, res.status)
    }
    return res
  }
}

export class LinkAuthorization {
  readonly userCode: string
  readonly qrUrl: string
  /** epoch seconds */
  readonly expiresAt: number
  private interval: number
  private cancelled = false

  constructor(
    private readonly client: ModelPassClient,
    private readonly rendezvous: string,
    private readonly da: DeviceAuthorizationResponse,
    private readonly secret: Uint8Array,
    private readonly fetchImpl: typeof fetch,
    private readonly finish: (t: TokenResponse) => Promise<ModelPassSession>,
  ) {
    this.userCode = da.user_code
    this.qrUrl = buildLinkUrl(da.verification_uri, da.user_code, secret)
    this.expiresAt = now() + da.expires_in
    this.interval = Math.max(1, da.interval || 5)
  }

  /** The wallet deep link carrying the same payload (useful when wallet and app share a device). */
  walletUrl(scheme = 'modelpass://link'): string {
    return `${scheme}${scheme.includes('?') ? '&' : '?'}${encodeQuery({ rv: this.rendezvous, uc: this.userCode, s: base64urlEncode(this.secret) })}`
  }

  cancel() {
    this.cancelled = true
  }

  async waitForSession(signal?: AbortSignal): Promise<ModelPassSession> {
    while (!this.cancelled && !signal?.aborted) {
      if (now() > this.expiresAt) throw new ModelPassError('expired_token', '二维码已过期')
      await new Promise((r) => setTimeout(r, this.interval * 1000))
      if (this.cancelled || signal?.aborted) break
      const res = await this.fetchImpl(`${this.rendezvous}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: encodeQuery({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: this.da.device_code, client_id: this.client.clientId }),
      })
      const body = (await res.json().catch(() => ({}))) as { modelpass_sealed?: string; error?: string; error_description?: string }
      if (res.ok && body.modelpass_sealed) {
        let token: TokenResponse
        try {
          token = openLinkPayload<TokenResponse>(this.secret, this.userCode, body.modelpass_sealed)
        } catch {
          throw new ModelPassError('invalid_response', '无法解密授权结果')
        }
        return this.finish(token)
      }
      switch (body.error) {
        case 'authorization_pending':
          continue
        case 'slow_down':
          this.interval += 5
          continue
        case 'access_denied':
          throw new ModelPassError('access_denied', '用户拒绝了授权')
        case 'expired_token':
          throw new ModelPassError('expired_token', '二维码已过期')
        default:
          throw new ModelPassError(body.error ?? 'invalid_response', body.error_description ?? `轮询失败（${res.status}）`, res.status)
      }
    }
    throw new ModelPassError('cancelled', '已取消')
  }
}

