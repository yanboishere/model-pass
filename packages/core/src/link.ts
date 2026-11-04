// Cross-device "link" flow (protocol §7): QR code carries a one-time secret `s`;
// the token response travels end-to-end encrypted through the rendezvous hub.

import { aesGcmOpenBase64url, aesGcmSealBase64url, hkdfSha256, hmacSha256, randomBytes } from './crypto'
import { base64urlDecode, base64urlEncode, utf8Decode } from './encoding'
import { codeChallengeS256 } from './pkce'

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ' // RFC 8628 §6.1: no vowels, no ambiguous characters

export function createLinkSecret(): Uint8Array {
  return randomBytes(32)
}

/** link_verifier = base64url(HMAC-SHA256(key = s, msg = "modelpass/v1/link-verifier")) */
export function linkVerifier(secret: Uint8Array): string {
  return base64urlEncode(hmacSha256(secret, 'modelpass/v1/link-verifier'))
}

/** link_challenge = base64url(SHA256(ASCII(link_verifier))) — identical to the PKCE S256 transform. */
export function linkChallenge(verifier: string): string {
  return codeChallengeS256(verifier)
}

export function normalizeUserCode(userCode: string): string {
  return userCode.replace(/[^A-Za-z]/g, '').toUpperCase()
}

export function formatUserCode(normalized: string): string {
  const n = normalizeUserCode(normalized)
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n
}

export function generateUserCode(): string {
  let out = ''
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      if (b < 240 && out.length < 8) out += USER_CODE_ALPHABET[b % 20]
    }
  }
  return formatUserCode(out)
}

function linkKey(secret: Uint8Array) {
  return hkdfSha256(secret, 'modelpass/v1', 'link-seal')
}

const linkAad = (userCode: string) => `modelpass/v1/link/${normalizeUserCode(userCode)}`

export function sealLinkPayload(secret: Uint8Array, userCode: string, payload: unknown, nonce?: Uint8Array): string {
  return aesGcmSealBase64url(linkKey(secret), JSON.stringify(payload), linkAad(userCode), nonce)
}

export function openLinkPayload<T = unknown>(secret: Uint8Array, userCode: string, sealed: string): T {
  return JSON.parse(utf8Decode(aesGcmOpenBase64url(linkKey(secret), sealed, linkAad(userCode)))) as T
}

/** QR content: `{verification_uri}#v=1&uc=BCDF-GHJK&s=<base64url(s)>` */
export function buildLinkUrl(verificationUri: string, userCode: string, secret: Uint8Array): string {
  const frag = new URLSearchParamsLite({ v: '1', uc: formatUserCode(userCode), s: base64urlEncode(secret) })
  return `${verificationUri}#${frag}`
}

/** Deep link used by the landing page to hand the QR payload to the wallet app. */
export function buildWalletLinkUrl(rendezvous: string, userCode: string, secret: Uint8Array, scheme = 'modelpass://link'): string {
  const q = new URLSearchParamsLite({ rv: rendezvous, uc: formatUserCode(userCode), s: base64urlEncode(secret) })
  return `${scheme}?${q}`
}

export interface ParsedLink {
  rendezvous: string
  userCode: string
  secret: Uint8Array
}

/**
 * Parses either form:
 *   https://hub.example.com/link#v=1&uc=…&s=…
 *   modelpass://link?rv=https%3A%2F%2Fhub.example.com&uc=…&s=…   (any scheme/host, e.g. exp://…/--/link?…)
 */
export function parseLinkUrl(raw: string): ParsedLink | null {
  try {
    const text = raw.trim()
    const hashIdx = text.indexOf('#')
    const qIdx = text.indexOf('?')
    let params: Record<string, string> = {}
    let rendezvous = ''
    if (hashIdx >= 0 && /^https?:\/\//i.test(text)) {
      params = parseQuery(text.slice(hashIdx + 1))
      const base = text.slice(0, hashIdx)
      rendezvous = base.replace(/\/link\/?$/, '')
    } else if (qIdx >= 0) {
      params = parseQuery(text.slice(qIdx + 1).split('#')[0])
      rendezvous = params.rv ?? ''
    }
    if (!params.uc || !params.s || !rendezvous) return null
    const secret = base64urlDecode(params.s)
    if (secret.length !== 32) return null
    return { rendezvous: rendezvous.replace(/\/+$/, ''), userCode: formatUserCode(params.uc), secret }
  } catch {
    return null
  }
}

// Minimal query helpers (URLSearchParams is incomplete on some React Native versions).
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of query.replace(/^[?#]/, '').split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '))
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '))
    out[k] = v
  }
  return out
}

export function encodeQuery(params: Record<string, string | number | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

class URLSearchParamsLite {
  constructor(private readonly params: Record<string, string>) {}
  toString() {
    return encodeQuery(this.params)
  }
}
