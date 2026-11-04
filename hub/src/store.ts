import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ActivityEntry,
  BudgetConfig,
  GrantStatus,
  ProviderOptions,
  ProviderRecord,
  RouteMap,
  Scope,
  SlotId,
  UpstreamFormat,
} from '@modelpass/core'

export interface GrantRow {
  id: string
  userId: string
  clientId: string
  clientName: string
  scope: Scope[]
  slots: SlotId[]
  routes: RouteMap
  budget: BudgetConfig
  allowedModels: string[]
  shareModelInfo: boolean
  tokenHash: string
  wrappedVk: string
  status: GrantStatus
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
}

export interface StoredProvider extends ProviderRecord {
  sealed: string | null
}

export interface AuthCodeRow {
  codeHash: string
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  sealedToken: string
  expiresAt: number
}

export interface LinkRow {
  deviceCodeHash: string
  userCode: string
  clientId: string
  clientName: string | null
  scope: string
  slots: SlotId[]
  linkChallenge: string
  status: 'pending' | 'approved' | 'denied'
  sealed: string | null
  interval: number
  /** epoch milliseconds */
  lastPollAt: number | null
  createdAt: number
  expiresAt: number
}

export interface UsageInput {
  grantId: string
  userId: string
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  format TEXT NOT NULL,
  models TEXT NOT NULL,
  host TEXT,
  options TEXT,
  sealed TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS routes (
  user_id TEXT PRIMARY KEY,
  routes TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  slots TEXT NOT NULL,
  routes TEXT NOT NULL,
  budget TEXT NOT NULL,
  allowed_models TEXT NOT NULL,
  share_model_info INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  wrapped_vk TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id);
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  sealed_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_sessions (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_name TEXT,
  scope TEXT NOT NULL,
  slots TEXT NOT NULL,
  link_challenge TEXT NOT NULL,
  status TEXT NOT NULL,
  sealed TEXT,
  interval INTEGER NOT NULL,
  last_poll_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  slot TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  error TEXT,
  stream INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_grant_day ON usage(grant_id, day);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage(user_id, ts);
`

type Row = Record<string, unknown>
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

/** Local calendar day used for daily budgets, e.g. "2026-11-05". */
export function dayKey(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const now = () => Math.floor(Date.now() / 1000)

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  static open(dataDir: string): Store {
    return new Store(join(dataDir, 'modelpass.db'))
  }

  close() {
    this.db.close()
  }

  // ---- users ----------------------------------------------------------------------------------

  createUser(id: string, walletTokenHash: string) {
    this.db.prepare('INSERT INTO users (id, wallet_token_hash, created_at) VALUES (?, ?, ?)').run(id, walletTokenHash, now())
  }

  getUserIdByWalletTokenHash(hash: string): string | null {
    const row = this.db.prepare('SELECT id FROM users WHERE wallet_token_hash = ?').get(hash) as Row | undefined
    return row ? String(row.id) : null
  }

  // ---- providers ------------------------------------------------------------------------------

  private toProvider(r: Row): StoredProvider {
    return {
      id: String(r.id),
      name: String(r.name),
      presetId: String(r.preset_id),
      format: r.format as UpstreamFormat,
      models: json<string[]>(r.models, []),
      host: (r.host as string | null) ?? undefined,
      options: json<ProviderOptions | undefined>(r.options, undefined),
      sealed: (r.sealed as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }
  }

  listProviders(userId: string): StoredProvider[] {
    return (this.db.prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY created_at').all(userId) as Row[]).map((r) =>
      this.toProvider(r),
    )
  }

  getProvider(userId: string, id: string): StoredProvider | null {
    const r = this.db.prepare('SELECT * FROM providers WHERE user_id = ? AND id = ?').get(userId, id) as Row | undefined
    return r ? this.toProvider(r) : null
  }

  /** `sealed === undefined` keeps the stored secret (metadata-only update). */
  upsertProvider(userId: string, p: Omit<ProviderRecord, 'createdAt' | 'updatedAt'>, sealed: string | undefined) {
    const existing = this.getProvider(userId, p.id)
    const ts = now()
    if (existing) {
      this.db
        .prepare(
          'UPDATE providers SET name = ?, preset_id = ?, format = ?, models = ?, host = ?, options = ?, sealed = ?, updated_at = ? WHERE user_id = ? AND id = ?',
        )
        .run(
          p.name,
          p.presetId,
          p.format,
          JSON.stringify(p.models),
          p.host ?? null,
          p.options ? JSON.stringify(p.options) : null,
          sealed === undefined ? existing.sealed : sealed,
          ts,
          userId,
          p.id,
        )
    } else {
      this.db
        .prepare(
          'INSERT INTO providers (user_id, id, name, preset_id, format, models, host, options, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(userId, p.id, p.name, p.presetId, p.format, JSON.stringify(p.models), p.host ?? null, p.options ? JSON.stringify(p.options) : null, sealed ?? null, ts, ts)
    }
  }

  updateProviderSealed(userId: string, id: string, sealed: string) {
    this.db.prepare('UPDATE providers SET sealed = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(sealed, now(), userId, id)
  }

  deleteProvider(userId: string, id: string) {
    this.db.prepare('DELETE FROM providers WHERE user_id = ? AND id = ?').run(userId, id)
  }

  // ---- routes ---------------------------------------------------------------------------------

  getRoutes(userId: string): RouteMap {
    const r = this.db.prepare('SELECT routes FROM routes WHERE user_id = ?').get(userId) as Row | undefined
    return json<RouteMap>(r?.routes, {})
  }

  setRoutes(userId: string, routes: RouteMap) {
    this.db
      .prepare('INSERT INTO routes (user_id, routes) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET routes = excluded.routes')
      .run(userId, JSON.stringify(routes))
  }

  // ---- grants ---------------------------------------------------------------------------------

  private toGrant(r: Row): GrantRow {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      clientId: String(r.client_id),
      clientName: String(r.client_name),
      scope: String(r.scope).split(' ').filter(Boolean) as Scope[],
      slots: json<SlotId[]>(r.slots, ['default']),
      routes: json<RouteMap>(r.routes, {}),
      budget: json<BudgetConfig>(r.budget, { tokensPerDay: null, requestsPerDay: null }),
      allowedModels: json<string[]>(r.allowed_models, []),
      shareModelInfo: Boolean(r.share_model_info),
      tokenHash: String(r.token_hash),
      wrappedVk: String(r.wrapped_vk),
      status: r.status as GrantStatus,
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    }
  }

  insertGrant(g: GrantRow) {
    this.db
      .prepare(
        `INSERT INTO grants (id, user_id, client_id, client_name, scope, slots, routes, budget, allowed_models, share_model_info,
          token_hash, wrapped_vk, status, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id,
        g.userId,
        g.clientId,
        g.clientName,
        g.scope.join(' '),
        JSON.stringify(g.slots),
        JSON.stringify(g.routes),
        JSON.stringify(g.budget),
        JSON.stringify(g.allowedModels),
        g.shareModelInfo ? 1 : 0,
        g.tokenHash,
        g.wrappedVk,
        g.status,
        g.createdAt,
        g.expiresAt,
        g.lastUsedAt,
      )
  }

  getGrant(id: string): GrantRow | null {
    const r = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as Row | undefined
    return r ? this.toGrant(r) : null
  }

  getGrantByTokenHash(hash: string): GrantRow | null {
    const r = this.db.prepare('SELECT * FROM grants WHERE token_hash = ?').get(hash) as Row | undefined
    return r ? this.toGrant(r) : null
  }

  listGrants(userId: string): GrantRow[] {
    return (this.db.prepare('SELECT * FROM grants WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Row[]).map((r) =>
      this.toGrant(r),
    )
  }

  updateGrant(id: string, patch: Partial<Pick<GrantRow, 'status' | 'routes' | 'slots' | 'budget' | 'expiresAt' | 'shareModelInfo' | 'allowedModels'>>) {
    const g = this.getGrant(id)
    if (!g) return
    const next = { ...g, ...patch }
    this.db
      .prepare(
        'UPDATE grants SET status = ?, routes = ?, slots = ?, budget = ?, expires_at = ?, share_model_info = ?, allowed_models = ? WHERE id = ?',
      )
      .run(
        next.status,
        JSON.stringify(next.routes),
        JSON.stringify(next.slots),
        JSON.stringify(next.budget),
        next.expiresAt,
        next.shareModelInfo ? 1 : 0,
        JSON.stringify(next.allowedModels),
        id,
      )
  }

  touchGrant(id: string, ts = now()) {
    this.db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?').run(ts, id)
  }

  deleteGrant(id: string) {
    this.db.prepare('DELETE FROM grants WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM auth_codes WHERE grant_id = ?').run(id)
  }

  /** Approved-but-never-exchanged same-device grants are dropped after a while. */
  purgeStalePending(olderThan: number) {
    this.db.prepare("DELETE FROM grants WHERE status = 'pending' AND created_at < ?").run(olderThan)
  }

  // ---- authorization codes ---------------------------------------------------------------------

  insertAuthCode(a: AuthCodeRow) {
    this.db
      .prepare(
        'INSERT INTO auth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, sealed_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.codeHash, a.grantId, a.clientId, a.redirectUri, a.codeChallenge, a.sealedToken, a.expiresAt)
  }

  /** Fetches and deletes an authorization code (single use). */
  takeAuthCode(codeHash: string): AuthCodeRow | null {
    const r = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(codeHash) as Row | undefined
    if (!r) return null
    this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(codeHash)
    return {
      codeHash: String(r.code_hash),
      grantId: String(r.grant_id),
      clientId: String(r.client_id),
      redirectUri: String(r.redirect_uri),
      codeChallenge: String(r.code_challenge),
      sealedToken: String(r.sealed_token),
      expiresAt: Number(r.expires_at),
    }
  }

  purgeExpired(ts = now()) {
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(ts)
    this.db.prepare('DELETE FROM link_sessions WHERE expires_at < ?').run(ts - 3600)
  }

  // ---- link sessions ----------------------------------------------------------------------------

  private toLink(r: Row): LinkRow {
    return {
      deviceCodeHash: String(r.device_code_hash),
      userCode: String(r.user_code),
      clientId: String(r.client_id),
      clientName: (r.client_name as string | null) ?? null,
      scope: String(r.scope),
      slots: json<SlotId[]>(r.slots, ['default']),
      linkChallenge: String(r.link_challenge),
      status: r.status as LinkRow['status'],
      sealed: (r.sealed as string | null) ?? null,
      interval: Number(r.interval),
      lastPollAt: r.last_poll_at == null ? null : Number(r.last_poll_at),
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }
  }

  insertLink(l: LinkRow) {
    this.db
      .prepare(
        `INSERT INTO link_sessions (device_code_hash, user_code, client_id, client_name, scope, slots, link_challenge, status, sealed,
          interval, last_poll_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.deviceCodeHash,
        l.userCode,
        l.clientId,
        l.clientName,
        l.scope,
        JSON.stringify(l.slots),
        l.linkChallenge,
        l.status,
        l.sealed,
        l.interval,
        l.lastPollAt,
        l.createdAt,
        l.expiresAt,
      )
  }

  getLinkByUserCode(userCode: string): LinkRow | null {
    const r = this.db.prepare('SELECT * FROM link_sessions WHERE user_code = ?').get(userCode) as Row | undefined
    return r ? this.toLink(r) : null
  }

  getLinkByDeviceCodeHash(hash: string): LinkRow | null {
    const r = this.db.prepare('SELECT * FROM link_sessions WHERE device_code_hash = ?').get(hash) as Row | undefined
    return r ? this.toLink(r) : null
  }

  updateLink(deviceCodeHash: string, patch: Partial<Pick<LinkRow, 'status' | 'sealed' | 'lastPollAt' | 'interval'>>) {
    const l = this.getLinkByDeviceCodeHash(deviceCodeHash)
    if (!l) return
    const n = { ...l, ...patch }
    this.db
      .prepare('UPDATE link_sessions SET status = ?, sealed = ?, last_poll_at = ?, interval = ? WHERE device_code_hash = ?')
      .run(n.status, n.sealed, n.lastPollAt, n.interval, deviceCodeHash)
  }

  deleteLink(deviceCodeHash: string) {
    this.db.prepare('DELETE FROM link_sessions WHERE device_code_hash = ?').run(deviceCodeHash)
  }

  // ---- usage ----------------------------------------------------------------------------------

  insertUsage(u: UsageInput) {
    this.db
      .prepare(
        `INSERT INTO usage (grant_id, user_id, ts, day, slot, provider_id, model, prompt_tokens, completion_tokens, latency_ms, status, error, stream)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.grantId,
        u.userId,
        u.ts,
        dayKey(u.ts),
        u.slot,
        u.providerId,
        u.model,
        u.promptTokens,
        u.completionTokens,
        u.latencyMs,
        u.status,
        u.error,
        u.stream ? 1 : 0,
      )
  }

  usageForDay(grantId: string, day: string): { tokens: number; requests: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage WHERE grant_id = ? AND day = ?')
      .get(grantId, day) as Row
    return { tokens: Number(r.tokens), requests: Number(r.requests) }
  }

  usageTotal(grantId: string): { tokens: number; requests: number } {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage WHERE grant_id = ?')
      .get(grantId) as Row
    return { tokens: Number(r.tokens), requests: Number(r.requests) }
  }

  listActivity(userId: string, limit: number, grantId?: string): ActivityEntry[] {
    const rows = (
      grantId
        ? this.db
            .prepare(
              'SELECT u.*, g.client_name FROM usage u LEFT JOIN grants g ON g.id = u.grant_id WHERE u.user_id = ? AND u.grant_id = ? ORDER BY u.id DESC LIMIT ?',
            )
            .all(userId, grantId, limit)
        : this.db
            .prepare('SELECT u.*, g.client_name FROM usage u LEFT JOIN grants g ON g.id = u.grant_id WHERE u.user_id = ? ORDER BY u.id DESC LIMIT ?')
            .all(userId, limit)
    ) as Row[]
    return rows.map((r) => ({
      id: Number(r.id),
      grantId: String(r.grant_id),
      clientName: String(r.client_name ?? r.grant_id),
      ts: Number(r.ts),
      slot: String(r.slot),
      providerId: (r.provider_id as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      latencyMs: Number(r.latency_ms),
      status: Number(r.status),
      error: (r.error as string | null) ?? null,
      stream: Boolean(r.stream),
    }))
  }
}
