// Headless "wallet" used by the cross-language interop tests (Swift / Kotlin / JS clients):
//   tsx scripts/interop/wallet.mts approve-authorize '<modelpass://authorize?...>'   → prints the redirect URL
//   tsx scripts/interop/wallet.mts approve-link '<https://hub/link#v=1&uc=…&s=…>'   → approves a QR request
// It registers a throwaway wallet on HUB_URL (default http://localhost:8787) with the built-in demo providers.
import {
  WalletClient,
  getPreset,
  getUrlParams,
  parseAuthorizationRequest,
  parseLinkUrl,
  parseScopeString,
  resolvePresetBaseUrl,
  type GrantOptions,
  type Scope,
  type SlotId,
} from '@modelpass/core'

const hub = (process.env.HUB_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const [command, url] = process.argv.slice(2)

async function wallet() {
  const w = new WalletClient(await WalletClient.register(hub))
  for (const id of ['demo-openai', 'demo-anthropic']) {
    const p = getPreset(id)!
    await w.putProvider({ id: id.replace('-', '_'), name: p.name, presetId: p.id, format: p.format, models: p.models }, { baseUrl: resolvePresetBaseUrl(p, hub), apiKey: 'demo', headers: { 'x-mock-delay-ms': '2' } })
  }
  await w.putRoutes({ default: { providerId: 'demo_openai', model: 'mock-gpt-mini' }, reasoning: { providerId: 'demo_anthropic', model: 'mock-claude-opus' } })
  return w
}

const options = (scope: Scope[], slots: SlotId[], clientName?: string): GrantOptions => ({
  scope,
  slots,
  routes: {},
  budget: { tokensPerDay: null, requestsPerDay: null },
  expiresAt: null,
  shareModelInfo: true,
  allowedModels: [],
  clientName,
})

if (command === 'approve-authorize') {
  const req = parseAuthorizationRequest(getUrlParams(url ?? ''))
  if (!req.ok) throw new Error(`invalid authorize URL: ${req.description}`)
  const { redirectUrl } = await (await wallet()).approveAuthorization(req.value, options(req.value.scope, req.value.slots, req.value.clientName))
  console.log(redirectUrl)
} else if (command === 'approve-link') {
  const link = parseLinkUrl(url ?? '')
  if (!link) throw new Error('invalid link URL')
  const w = await wallet()
  const info = await w.getLinkInfo(link)
  const grant = await w.approveLink(link, info, options(parseScopeString(info.scope), info.slots, info.client_name))
  console.log(`approved ${grant.id}`)
} else {
  console.error('usage: wallet.ts approve-authorize <url> | approve-link <url>')
  process.exit(2)
}
