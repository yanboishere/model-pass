// Generates deterministic test vectors (docs/test-vectors.json) so SDKs in other languages
// (Swift, Kotlin, …) can verify their PKCE and link-flow implementations byte-for-byte.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  base64urlEncode,
  codeChallengeS256,
  hkdfSha256,
  linkChallenge,
  linkVerifier,
  normalizeUserCode,
  sealLinkPayload,
} from '../src/index'

const seq = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

const verifier = base64urlEncode(seq(32))
const s = seq(32, 0xa0)
const nonce = seq(12, 0x10)
const userCode = 'BCDF-GHJK'
const payload = {
  access_token: 'mpk_test-vector-token',
  token_type: 'Bearer',
  scope: 'chat',
  grant_id: 'g_testvector000001',
  sub: 'u_test',
  issuer: 'https://hub.example.com',
  api_base: 'https://hub.example.com/v1',
  api_formats: ['openai-chat-completions'],
  slots: [{ id: 'default', label: '默认' }],
}
const lv = linkVerifier(s)

const vectors = {
  description: 'ModelPass Connect v0.1 test vectors. All binary values are hex unless suffixed _b64url.',
  pkce: {
    code_verifier: verifier,
    code_challenge: codeChallengeS256(verifier),
    rfc7636_appendix_b: {
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    },
  },
  link: {
    secret_hex: hex(s),
    secret_b64url: base64urlEncode(s),
    link_verifier: lv,
    link_challenge: linkChallenge(lv),
    user_code: userCode,
    aad: `modelpass/v1/link/${normalizeUserCode(userCode)}`,
    seal_key_hex: hex(hkdfSha256(s, 'modelpass/v1', 'link-seal')),
    nonce_hex: hex(nonce),
    payload_json: JSON.stringify(payload),
    sealed_b64url: sealLinkPayload(s, userCode, payload, nonce),
    qr_example: `https://hub.example.com/link#v=1&uc=${userCode}&s=${base64urlEncode(s)}`,
  },
}

const out = fileURLToPath(new URL('../../../docs/test-vectors.json', import.meta.url))
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n')
console.log('wrote', out)
