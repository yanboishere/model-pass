// Device persistence. Only the vault key and the hub session live in the Keychain / Keystore
// (this-device-only, never backed up); provider secrets are stored sealed with the vault key —
// the very same ciphertext that is uploaded to the hub.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { base64urlDecode, base64urlEncode, type ProviderRecord, type RouteMap, type WalletIdentity } from '@modelpass/core'

const KEYS = {
  identity: 'mpw.identity.v1',
  providers: 'mpw.providers.v1',
  routes: 'mpw.routes.v1',
  settings: 'mpw.settings.v1',
  chatgptClient: 'mpw.chatgpt.client.v1',
}

const SECURE_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

export interface LocalProvider {
  record: ProviderRecord
  /** sealProviderSecret(VK, userId, id, secret) */
  sealed: string
  /** Display copy of the base URL (the authoritative one is inside `sealed`). */
  baseUrl: string
  auth: 'api-key' | 'oauth' | 'none'
  keyHint: string
  accountLabel?: string
  synced: boolean
}

export interface Settings {
  biometric: boolean
  shareModelInfo: boolean
  defaultTokensPerDay: number | null
}

export const DEFAULT_SETTINGS: Settings = { biometric: true, shareModelInfo: true, defaultTokensPerDay: null }

export async function loadIdentity(): Promise<WalletIdentity | null> {
  const raw = await SecureStore.getItemAsync(KEYS.identity, SECURE_OPTS)
  if (!raw) return null
  const v = JSON.parse(raw) as Omit<WalletIdentity, 'vaultKey'> & { vaultKey: string }
  return { ...v, vaultKey: base64urlDecode(v.vaultKey) }
}

export async function saveIdentity(id: WalletIdentity) {
  await SecureStore.setItemAsync(KEYS.identity, JSON.stringify({ ...id, vaultKey: base64urlEncode(id.vaultKey) }), SECURE_OPTS)
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export const loadProviders = () => readJson<LocalProvider[]>(KEYS.providers, [])
export const saveProviders = (list: LocalProvider[]) => AsyncStorage.setItem(KEYS.providers, JSON.stringify(list))
export const loadRoutes = () => readJson<RouteMap>(KEYS.routes, {})
export const saveRoutes = (routes: RouteMap) => AsyncStorage.setItem(KEYS.routes, JSON.stringify(routes))
export const loadSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(KEYS.settings, {})) })
export const saveSettings = (s: Settings) => AsyncStorage.setItem(KEYS.settings, JSON.stringify(s))

/** ChatGPT "Sign in with ChatGPT" registration: the issued client_id and this host's opaque id. */
export async function loadChatGptClient(): Promise<{ clientId?: string; hostId: string }> {
  const raw = await SecureStore.getItemAsync(KEYS.chatgptClient, SECURE_OPTS)
  if (raw) return JSON.parse(raw)
  const value = { hostId: `urn:uuid:${uuid()}` }
  await SecureStore.setItemAsync(KEYS.chatgptClient, JSON.stringify(value), SECURE_OPTS)
  return value
}

export async function saveChatGptClient(v: { clientId?: string; hostId: string }) {
  await SecureStore.setItemAsync(KEYS.chatgptClient, JSON.stringify(v), SECURE_OPTS)
}

export async function wipeAll() {
  await SecureStore.deleteItemAsync(KEYS.identity, SECURE_OPTS)
  await SecureStore.deleteItemAsync(KEYS.chatgptClient, SECURE_OPTS)
  await AsyncStorage.multiRemove([KEYS.providers, KEYS.routes, KEYS.settings])
}

function uuid(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
