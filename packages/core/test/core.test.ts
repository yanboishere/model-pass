import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  base64urlDecode,
  base64urlEncode,
  buildAuthorizationUrl,
  buildLinkUrl,
  buildRedirectUrl,
  buildWalletLinkUrl,
  codeChallengeS256,
  createCodeVerifier,
  generateAccessToken,
  generateAuthCode,
  generateUserCode,
  generateVaultKey,
  getUrlParams,
  hashToken,
  hkdfSha256,
  linkChallenge,
  linkVerifier,
  openLinkPayload,
  openProviderSecret,
  openTokenWithCode,
  parseAccessToken,
  parseAuthorizationRequest,
  parseLinkUrl,
  randomId,
  resolveRoute,
  sealLinkPayload,
  sealProviderSecret,
  sealTokenWithCode,
  unwrapVaultKey,
  upstreamEndpoints,
  utf8Decode,
  utf8Encode,
  verifyCodeChallenge,
  wrapVaultKey,
  createLinkSecret,
} from '../src/index'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

describe('encoding', () => {
  it('base64url round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      const enc = base64urlEncode(bytes)
      assert.match(enc, /^[A-Za-z0-9_-]*$/)
      assert.deepEqual(base64urlDecode(enc), bytes)
      assert.equal(enc, Buffer.from(bytes).toString('base64url'))
    }
  })
  it('utf8 round-trips CJK and emoji', () => {
    const s = 'ModelPass 模型通行证 🚀 ñ'
    assert.deepEqual(utf8Encode(s), new Uint8Array(Buffer.from(s, 'utf8')))
    assert.equal(utf8Decode(utf8Encode(s)), s)
  })
})

describe('crypto primitives', () => {
  it('PKCE matches RFC 7636 appendix B', () => {
    assert.equal(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const v = createCodeVerifier()
    assert.equal(v.length, 43)
    assert.ok(verifyCodeChallenge(v, codeChallengeS256(v)))
    assert.ok(!verifyCodeChallenge(v, codeChallengeS256(v + 'x')))
  })
  it('HKDF matches RFC 5869 test case 1', () => {
    const okm = hkdfSha256(fromHex('0b'.repeat(22)), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42)
    assert.equal(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  })
  it('randomId is alphanumeric with the requested length', () => {
    const id = randomId('g_', 16)
    assert.match(id, /^g_[0-9A-Za-z]{16}$/)
  })
})

describe('vault sealing', () => {
  const vk = generateVaultKey()
  it('seals and opens provider secrets, bound to user and provider', () => {
    const sealed = sealProviderSecret(vk, 'u1', 'p1', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' })
    assert.deepEqual(openProviderSecret(vk, 'u1', 'p1', sealed), { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' })
    assert.throws(() => openProviderSecret(vk, 'u1', 'p2', sealed))
    assert.throws(() => openProviderSecret(generateVaultKey(), 'u1', 'p1', sealed))
  })
  it('wraps the vault key under an access token', () => {
    const { token, secret } = generateAccessToken()
    assert.match(token, /^mpk_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(parseAccessToken(token), secret)
    assert.equal(parseAccessToken('mpk_short'), null)
    assert.equal(parseAccessToken('sk-abc'), null)
    const wrapped = wrapVaultKey(vk, secret, 'g_1')
    assert.deepEqual(unwrapVaultKey(wrapped, secret, 'g_1'), vk)
    assert.throws(() => unwrapVaultKey(wrapped, secret, 'g_2'))
    assert.throws(() => unwrapVaultKey(wrapped, generateAccessToken().secret, 'g_1'))
    assert.equal(hashToken(token).length, 43)
  })
  it('seals the token under the authorization code', () => {
    const code = generateAuthCode()
    const sealed = sealTokenWithCode(code, 'g_1', 'mpk_abc')
    assert.equal(openTokenWithCode(code, 'g_1', sealed), 'mpk_abc')
    assert.throws(() => openTokenWithCode(generateAuthCode(), 'g_1', sealed))
  })
})

describe('link flow', () => {
  it('verifier/challenge and end-to-end sealing', () => {
    const s = createLinkSecret()
    const v = linkVerifier(s)
    assert.equal(linkChallenge(v), codeChallengeS256(v))
    const uc = generateUserCode()
    assert.match(uc, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    const sealed = sealLinkPayload(s, uc, { hello: '世界' })
    assert.deepEqual(openLinkPayload(s, uc.replace('-', '').toLowerCase(), sealed), { hello: '世界' })
    assert.throws(() => openLinkPayload(createLinkSecret(), uc, sealed))
    assert.throws(() => openLinkPayload(s, 'BBBB-BBBB', sealed))
  })
  it('parses QR and wallet deep-link forms', () => {
    const s = createLinkSecret()
    const qr = buildLinkUrl('https://hub.example.com/link', 'bcdf-ghjk', s)
    const a = parseLinkUrl(qr)!
    assert.equal(a.rendezvous, 'https://hub.example.com')
    assert.equal(a.userCode, 'BCDF-GHJK')
    assert.deepEqual(a.secret, s)
    const b = parseLinkUrl(buildWalletLinkUrl('http://192.168.1.5:8787', 'BCDFGHJK', s, 'exp://127.0.0.1:8081/--/link'))!
    assert.equal(b.rendezvous, 'http://192.168.1.5:8787')
    assert.equal(b.userCode, 'BCDF-GHJK')
    assert.equal(parseLinkUrl('https://example.com/nothing'), null)
  })
})

describe('authorization request', () => {
  const base = {
    response_type: 'code',
    client_id: 'com.example.chat',
    redirect_uri: 'com.example.chat:/modelpass/callback',
    scope: 'chat tools',
    state: 'abcdefghijklmnopqrstuv',
    code_challenge: codeChallengeS256(createCodeVerifier()),
    code_challenge_method: 'S256',
    slots: 'fast default bogus',
  }
  it('accepts a valid request and normalises slots', () => {
    const r = parseAuthorizationRequest(base)
    assert.ok(r.ok)
    if (r.ok) {
      assert.deepEqual(r.value.slots, ['default', 'fast'])
      assert.deepEqual(r.value.scope, ['chat', 'tools'])
    }
  })
  it('requires PKCE S256, chat scope and a safe redirect', () => {
    const noPkce = parseAuthorizationRequest({ ...base, code_challenge_method: 'plain' })
    assert.ok(!noPkce.ok && noPkce.error === 'invalid_request' && noPkce.redirectUri)
    const noChat = parseAuthorizationRequest({ ...base, scope: 'vision' })
    assert.ok(!noChat.ok && noChat.error === 'invalid_scope')
    const js = parseAuthorizationRequest({ ...base, redirect_uri: 'javascript:alert(1)' })
    assert.ok(!js.ok && js.redirectUri === undefined)
  })
  it('builds wallet and redirect URLs (including Expo Go style URLs)', () => {
    const r = parseAuthorizationRequest(base)
    assert.ok(r.ok)
    if (!r.ok) return
    const url = buildAuthorizationUrl('exp://127.0.0.1:8081/--/authorize', r.value)
    const back = parseAuthorizationRequest(getUrlParams(url))
    assert.ok(back.ok)
    assert.equal(buildRedirectUrl('app://cb?x=1', { code: 'a b', state: 's' }), 'app://cb?x=1&code=a%20b&state=s')
  })
})

describe('routing', () => {
  const providers = [{ id: 'p1' }, { id: 'p2' }]
  const ctx = {
    grantSlots: ['default', 'fast'] as const,
    grantScope: ['chat'] as const,
    grantRoutes: {},
    globalRoutes: { default: { providerId: 'p1', model: 'm-default' }, reasoning: { providerId: 'p2', model: 'm-reason' } },
    allowedModels: [],
    providers,
  }
  it('routes granted slots and falls back to default', () => {
    const c = { ...ctx, grantSlots: [...ctx.grantSlots], grantScope: [...ctx.grantScope] }
    assert.deepEqual(resolveRoute('fast', c), { slot: 'fast', target: { providerId: 'p1', model: 'm-default' }, fallback: false, explicit: false })
    assert.equal(resolveRoute('modelpass/default', c).fallback, false)
    const fb = resolveRoute('gpt-4o-mini', c)
    assert.equal(fb.slot, 'default')
    assert.equal(fb.fallback, true)
    // reasoning is not granted → default
    assert.equal(resolveRoute('reasoning', c).target?.model, 'm-default')
  })
  it('honours per-app overrides and model_choice', () => {
    const c = {
      ...ctx,
      grantSlots: [...ctx.grantSlots],
      grantScope: ['chat', 'model_choice'] as ('chat' | 'model_choice')[],
      grantRoutes: { fast: { providerId: 'p2', model: 'm-fast' } },
      allowedModels: ['p2:llama3:8b'],
    }
    assert.equal(resolveRoute('fast', c).target?.model, 'm-fast')
    const ex = resolveRoute('llama3:8b', c)
    assert.deepEqual(ex.target, { providerId: 'p2', model: 'llama3:8b' })
    assert.equal(ex.explicit, true)
  })
  it('builds upstream endpoints', () => {
    assert.equal(upstreamEndpoints('anthropic-messages', 'https://api.anthropic.com/v1/').chat, 'https://api.anthropic.com/v1/messages')
    assert.equal(upstreamEndpoints('openai-chat', 'https://api.deepseek.com/v1').chat, 'https://api.deepseek.com/v1/chat/completions')
  })
})
