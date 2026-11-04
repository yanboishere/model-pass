// Developer helper: creates a throwaway wallet on a running hub with the two built-in demo
// providers, authorizes a CLI "app" through the real same-device flow (PKCE + sealed code),
// and prints a ready-to-use api_base + access token.
//
//   npm run dev-token -w @modelpass/hub              (hub at http://localhost:8787)
//   HUB_URL=http://192.168.1.5:8787 npm run dev-token -w @modelpass/hub
import {
  WalletClient,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  getUrlParams,
  resolvePresetBaseUrl,
  getPreset,
  type AuthorizationRequest,
} from '@modelpass/core'

const hub = (process.env.HUB_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const identity = await WalletClient.register(hub)
const wallet = new WalletClient(identity)
for (const id of ['demo-openai', 'demo-anthropic'] as const) {
  const p = getPreset(id)!
  await wallet.putProvider(
    { id: `prov_${id.replace('-', '_')}`, name: p.name, presetId: p.id, format: p.format, models: p.models, host: new URL(hub).host },
    { baseUrl: resolvePresetBaseUrl(p, hub), apiKey: 'demo' },
  )
}
await wallet.putRoutes({
  default: { providerId: 'prov_demo_openai', model: 'mock-gpt-mini' },
  fast: { providerId: 'prov_demo_openai', model: 'mock-gpt-mini' },
  reasoning: { providerId: 'prov_demo_anthropic', model: 'mock-claude-opus' },
  vision: { providerId: 'prov_demo_anthropic', model: 'mock-claude-opus' },
})
const verifier = createCodeVerifier()
const req: AuthorizationRequest = {
  clientId: 'dev.modelpass.cli',
  clientName: 'ModelPass CLI (dev-token)',
  redirectUri: 'http://127.0.0.1/callback',
  scope: ['chat', 'vision', 'tools'],
  slots: ['default', 'fast', 'reasoning', 'vision'],
  state: createState(),
  codeChallenge: codeChallengeS256(verifier),
}
const { redirectUrl } = await wallet.approveAuthorization(req, {
  scope: req.scope,
  slots: req.slots,
  routes: {},
  budget: { tokensPerDay: null, requestsPerDay: null },
  expiresAt: null,
  shareModelInfo: true,
  allowedModels: [],
  clientName: req.clientName,
})
const { code, iss } = getUrlParams(redirectUrl)
const res = await fetch(`${iss}/oauth/token`, {
  method: 'POST',
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: req.redirectUri, client_id: req.clientId, code_verifier: verifier }),
})
const token = await res.json()
if (!res.ok) throw new Error(JSON.stringify(token))
console.log(JSON.stringify({ api_base: token.api_base, access_token: token.access_token, slots: token.slots }, null, 2))
console.log(`\ncurl -N ${token.api_base}/chat/completions -H "Authorization: Bearer ${token.access_token}" -H "Content-Type: application/json" \\\n  -d '{"model":"default","stream":true,"messages":[{"role":"user","content":"你好"}]}'`)
