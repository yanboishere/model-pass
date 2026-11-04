import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  WalletClient,
  getPreset,
  hostOf,
  openProviderSecret,
  randomId,
  sealProviderSecret,
  SLOTS,
  type ActivityEntry,
  type AuthorizationRequest,
  type GrantOptions,
  type GrantSummary,
  type LinkInfo,
  type ParsedLink,
  type ProviderOptions,
  type ProviderRecord,
  type ProviderSecret,
  type RouteMap,
  type RouteTarget,
  type SlotId,
  type UpdateGrantBody,
  type UpstreamFormat,
  type WalletIdentity,
} from '@modelpass/core'
import { keyHint } from './lib/format'
import {
  DEFAULT_SETTINGS,
  loadIdentity,
  loadProviders,
  loadRoutes,
  loadSettings,
  saveIdentity,
  saveProviders,
  saveRoutes,
  saveSettings,
  wipeAll,
  type LocalProvider,
  type Settings,
} from './storage'

export interface SaveProviderInput {
  id?: string
  presetId: string
  name: string
  format: UpstreamFormat
  models: string[]
  secret: ProviderSecret
  auth: LocalProvider['auth']
  accountLabel?: string
  options?: ProviderOptions
}

interface WalletContextValue {
  ready: boolean
  identity: WalletIdentity | null
  providers: LocalProvider[]
  routes: RouteMap
  grants: GrantSummary[]
  activity: ActivityEntry[]
  settings: Settings
  hubOnline: boolean | null
  syncing: boolean
  error: string | null
  createWallet(hubUrl: string): Promise<void>
  switchHub(hubUrl: string): Promise<void>
  resetWallet(): Promise<void>
  refresh(): Promise<void>
  loadActivity(): Promise<void>
  saveProvider(input: SaveProviderInput): Promise<LocalProvider>
  removeProvider(id: string): Promise<void>
  revealSecret(id: string): ProviderSecret | null
  setRoute(slot: SlotId, target: RouteTarget | null): Promise<void>
  switchToProvider(providerId: string, model?: string): Promise<void>
  approveAuthorization(req: AuthorizationRequest, opts: GrantOptions): Promise<string>
  getLinkInfo(link: ParsedLink): Promise<LinkInfo>
  approveLink(link: ParsedLink, info: LinkInfo, opts: GrantOptions): Promise<GrantSummary>
  denyLink(link: ParsedLink): Promise<void>
  updateGrant(id: string, patch: UpdateGrantBody): Promise<void>
  revokeGrant(id: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
}

const WalletContext = createContext<WalletContextValue | null>(null)

const sameRoutes = (a: RouteMap, b: RouteMap) =>
  SLOTS.every((s) => (a[s]?.providerId ?? '') === (b[s]?.providerId ?? '') && (a[s]?.model ?? '') === (b[s]?.model ?? ''))

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [identity, setIdentity] = useState<WalletIdentity | null>(null)
  const [providers, setProviders] = useState<LocalProvider[]>([])
  const [routes, setRoutes] = useState<RouteMap>({})
  const [grants, setGrants] = useState<GrantSummary[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hubOnline, setHubOnline] = useState<boolean | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refs mirror state so async actions always see the latest values.
  const providersRef = useRef(providers)
  const routesRef = useRef(routes)
  providersRef.current = providers
  routesRef.current = routes

  const client = useMemo(() => (identity ? new WalletClient(identity) : null), [identity])
  const requireClient = useCallback(() => {
    if (!client) throw new Error('钱包尚未初始化')
    return client
  }, [client])

  useEffect(() => {
    ;(async () => {
      const [id, ps, rs, st] = await Promise.all([loadIdentity(), loadProviders(), loadRoutes(), loadSettings()])
      setIdentity(id)
      setProviders(ps)
      setRoutes(rs)
      setSettings(st)
      setReady(true)
    })().catch((e) => {
      setError(String(e))
      setReady(true)
    })
  }, [])

  const persistProviders = useCallback(async (list: LocalProvider[]) => {
    providersRef.current = list
    setProviders(list)
    await saveProviders(list)
  }, [])

  const persistRoutes = useCallback(async (next: RouteMap) => {
    routesRef.current = next
    setRoutes(next)
    await saveRoutes(next)
  }, [])

  const open = useCallback(
    (p: LocalProvider, id: WalletIdentity | null = identity): ProviderSecret | null => {
      if (!id) return null
      try {
        return openProviderSecret(id.vaultKey, id.userId, p.record.id, p.sealed)
      } catch {
        return null
      }
    },
    [identity],
  )

  /** Pulls grants from the hub and pushes anything the hub is missing (local is the source of truth). */
  const refresh = useCallback(async () => {
    if (!client) return
    setSyncing(true)
    try {
      const state = await client.getState()
      setHubOnline(true)
      setError(null)
      setGrants(state.grants)
      const local = providersRef.current
      let changed = false
      const next = await Promise.all(
        local.map(async (p) => {
          const remote = state.providers.find((r) => r.id === p.record.id)
          const stale = !remote || !remote.hasSecret || remote.name !== p.record.name || remote.models.length !== p.record.models.length
          if (!stale && p.synced) return p
          const secret = !remote || !remote.hasSecret ? open(p) : undefined
          await client.putProvider(p.record, secret ?? undefined)
          changed = true
          return { ...p, synced: true }
        }),
      )
      for (const r of state.providers) if (!local.some((p) => p.record.id === r.id)) await client.deleteProvider(r.id)
      if (changed) await persistProviders(next)
      if (!sameRoutes(state.routes, routesRef.current)) await client.putRoutes(routesRef.current)
    } catch (e) {
      setHubOnline(false)
      setError((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }, [client, open, persistProviders])

  useEffect(() => {
    if (!client) return
    refresh()
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh())
    return () => sub.remove()
  }, [client, refresh])

  const loadActivity = useCallback(async () => {
    if (!client) return
    try {
      setActivity(await client.activity(100))
      setHubOnline(true)
    } catch (e) {
      setHubOnline(false)
      setError((e as Error).message)
    }
  }, [client])

  const createWallet = useCallback(async (hubUrl: string) => {
    const id = await WalletClient.register(hubUrl)
    await saveIdentity(id)
    setIdentity(id)
  }, [])

  const switchHub = useCallback(
    async (hubUrl: string) => {
      if (!identity) return createWallet(hubUrl)
      const fresh = await WalletClient.register(hubUrl)
      const next: WalletIdentity = { ...fresh, vaultKey: identity.vaultKey }
      // Provider blobs are bound to the user id; re-seal them for the new account.
      const resealed = providersRef.current.map((p) => {
        const secret = open(p)
        return secret ? { ...p, sealed: sealProviderSecret(next.vaultKey, next.userId, p.record.id, secret), synced: false } : { ...p, synced: false }
      })
      await persistProviders(resealed)
      await saveIdentity(next)
      setGrants([])
      setActivity([])
      setIdentity(next)
    },
    [identity, createWallet, open, persistProviders],
  )

  const resetWallet = useCallback(async () => {
    // Best effort: revoke every app and delete the sealed providers on the hub before forgetting the vault key.
    if (client) {
      for (const g of grants) if (g.status !== 'revoked') await client.revokeGrant(g.id).catch(() => undefined)
      for (const p of providersRef.current) await client.deleteProvider(p.record.id).catch(() => undefined)
    }
    await wipeAll()
    setIdentity(null)
    setProviders([])
    setRoutes({})
    setGrants([])
    setActivity([])
    setSettings(DEFAULT_SETTINGS)
    setHubOnline(null)
  }, [client, grants])

  const setRoute = useCallback(
    async (slot: SlotId, target: RouteTarget | null) => {
      const next = { ...routesRef.current }
      if (target) next[slot] = target
      else delete next[slot]
      await persistRoutes(next)
      await requireClient().putRoutes(next).catch((e) => setError((e as Error).message))
    },
    [persistRoutes, requireClient],
  )

  /** CC-Switch style one-tap switch: route every slot to this provider (preset defaults where known). */
  const switchToProvider = useCallback(
    async (providerId: string, model?: string) => {
      const p = providersRef.current.find((x) => x.record.id === providerId)
      if (!p) return
      const preset = getPreset(p.record.presetId)
      const has = (m?: string) => !!m && (p.record.models.length === 0 || p.record.models.includes(m))
      const fallback = model ?? (has(preset?.defaults.default) ? preset!.defaults.default! : p.record.models[0])
      if (!fallback) return
      const next: RouteMap = {}
      for (const slot of SLOTS) {
        const preferred = slot === 'default' ? fallback : preset?.defaults[slot]
        next[slot] = { providerId, model: !model && has(preferred) ? preferred! : fallback }
      }
      await persistRoutes(next)
      await requireClient().putRoutes(next).catch((e) => setError((e as Error).message))
    },
    [persistRoutes, requireClient],
  )

  const saveProvider = useCallback(
    async (input: SaveProviderInput) => {
      if (!identity) throw new Error('钱包尚未初始化')
      const id = input.id ?? randomId('p_', 10)
      const ts = Math.floor(Date.now() / 1000)
      const existing = providersRef.current.find((p) => p.record.id === id)
      const record: ProviderRecord = {
        id,
        name: input.name.trim() || getPreset(input.presetId)?.name || '自定义',
        presetId: input.presetId,
        format: input.format,
        models: input.models,
        host: hostOf(input.secret.baseUrl),
        options: input.options,
        createdAt: existing?.record.createdAt ?? ts,
        updatedAt: ts,
      }
      const local: LocalProvider = {
        record,
        sealed: sealProviderSecret(identity.vaultKey, identity.userId, id, input.secret),
        baseUrl: input.secret.baseUrl,
        auth: input.auth,
        keyHint: input.auth === 'oauth' ? input.accountLabel ?? 'OAuth 授权' : keyHint(input.secret.apiKey),
        accountLabel: input.accountLabel,
        synced: false,
      }
      const list = existing ? providersRef.current.map((p) => (p.record.id === id ? local : p)) : [...providersRef.current, local]
      await persistProviders(list)
      try {
        await requireClient().putProvider(record, input.secret)
        local.synced = true
        await persistProviders(list.map((p) => (p.record.id === id ? { ...local } : p)))
        setHubOnline(true)
      } catch (e) {
        setHubOnline(false)
        setError((e as Error).message)
      }
      // First provider (or nothing routed yet): route everything to it.
      if (!routesRef.current.default && record.models.length) await switchToProvider(id)
      return local
    },
    [identity, persistProviders, requireClient, switchToProvider],
  )

  const removeProvider = useCallback(
    async (id: string) => {
      await persistProviders(providersRef.current.filter((p) => p.record.id !== id))
      const next: RouteMap = {}
      for (const slot of SLOTS) {
        const t = routesRef.current[slot]
        if (t && t.providerId !== id) next[slot] = t
      }
      await persistRoutes(next)
      const c = requireClient()
      await c.deleteProvider(id).catch(() => undefined)
      await c.putRoutes(next).catch(() => undefined)
    },
    [persistProviders, persistRoutes, requireClient],
  )

  const revealSecret = useCallback(
    (id: string) => {
      const p = providersRef.current.find((x) => x.record.id === id)
      return p ? open(p) : null
    },
    [open],
  )

  const approveAuthorization = useCallback(
    async (req: AuthorizationRequest, opts: GrantOptions) => {
      const { redirectUrl } = await requireClient().approveAuthorization(req, opts)
      refresh()
      return redirectUrl
    },
    [requireClient, refresh],
  )

  const approveLink = useCallback(
    async (link: ParsedLink, info: LinkInfo, opts: GrantOptions) => {
      const grant = await requireClient().approveLink(link, info, opts)
      refresh()
      return grant
    },
    [requireClient, refresh],
  )

  const getLinkInfo = useCallback((link: ParsedLink) => requireClient().getLinkInfo(link), [requireClient])
  const denyLink = useCallback((link: ParsedLink) => requireClient().denyLink(link), [requireClient])

  const updateGrant = useCallback(
    async (id: string, patch: UpdateGrantBody) => {
      const g = await requireClient().updateGrant(id, patch)
      setGrants((list) => list.map((x) => (x.id === id ? g : x)))
    },
    [requireClient],
  )

  const revokeGrant = useCallback(
    async (id: string) => {
      await requireClient().revokeGrant(id)
      setGrants((list) => list.map((x) => (x.id === id ? { ...x, status: 'revoked' } : x)))
    },
    [requireClient],
  )

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  const value: WalletContextValue = {
    ready,
    identity,
    providers,
    routes,
    grants,
    activity,
    settings,
    hubOnline,
    syncing,
    error,
    createWallet,
    switchHub,
    resetWallet,
    refresh,
    loadActivity,
    saveProvider,
    removeProvider,
    revealSecret,
    setRoute,
    switchToProvider,
    approveAuthorization,
    getLinkInfo,
    approveLink,
    denyLink,
    updateGrant,
    revokeGrant,
    updateSettings,
  }
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider')
  return ctx
}

/** Human label for a route target, e.g. "mock-gpt-mini · 演示模型". */
export function describeTarget(providers: LocalProvider[], t: RouteTarget | null | undefined) {
  if (!t) return { model: '未设置', provider: '', presetId: '' }
  const p = providers.find((x) => x.record.id === t.providerId)
  return { model: t.model, provider: p?.record.name ?? '已删除的厂商', presetId: p?.record.presetId ?? '' }
}
