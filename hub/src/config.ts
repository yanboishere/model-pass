import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientMetadata } from '@modelpass/core'

const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface HubConfig {
  port: number
  host: string
  /** Fixed issuer URL. When unset (dev), the issuer is derived from each request's Host header. */
  publicUrl?: string
  dataDir: string
  clients: ClientMetadata[]
  /** Serve the built-in mock upstreams under /mock (demo providers). */
  enableMock: boolean
  /** Allow anyone to register a wallet on this hub. */
  openRegistration: boolean
  /** Upstream request timeout (ms). */
  upstreamTimeoutMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const clientsFile = env.MODELPASS_CLIENTS_FILE ?? resolve(HUB_ROOT, 'clients.json')
  let clients: ClientMetadata[] = []
  try {
    clients = JSON.parse(readFileSync(clientsFile, 'utf8')) as ClientMetadata[]
  } catch {
    clients = []
  }
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    publicUrl: env.MODELPASS_PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    dataDir: env.MODELPASS_DATA_DIR ?? resolve(HUB_ROOT, 'data'),
    clients,
    enableMock: env.MODELPASS_MOCK !== '0',
    openRegistration: env.MODELPASS_OPEN_REGISTRATION !== '0',
    upstreamTimeoutMs: Number(env.MODELPASS_UPSTREAM_TIMEOUT_MS ?? 300_000),
  }
}

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
    }
  }
  return out
}
