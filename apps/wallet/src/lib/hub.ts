import Constants from 'expo-constants'

/**
 * Default hub URL: `EXPO_PUBLIC_MODELPASS_HUB_URL` if it was set at build time; in development the
 * machine running Metro (the hub runs next to it on port 8787), which works for simulators and
 * phones on the same Wi-Fi; otherwise empty.
 */
export function defaultHubUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_MODELPASS_HUB_URL
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  const hostUri = Constants.expoConfig?.hostUri ?? (Constants as unknown as { manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } } }).manifest2?.extra?.expoGo?.debuggerHost
  const host = hostUri?.split(':')[0]
  // Standalone builds (no Metro) have no way to guess where the hub runs: let the user enter it.
  return host ? `http://${host}:8787` : ''
}

export async function pingHub(url: string): Promise<{ ok: boolean; issuer?: string; message: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/.well-known/modelpass-configuration`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, message: `Hub 返回 ${res.status}` }
    const doc = (await res.json()) as { issuer?: string; protocol_version?: string }
    return { ok: true, issuer: doc.issuer, message: `已连接 · 协议 v${doc.protocol_version ?? '?'}` }
  } catch (e) {
    return { ok: false, message: `无法连接：${(e as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}
