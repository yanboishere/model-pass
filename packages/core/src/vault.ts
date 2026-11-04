// Credential sealing between the wallet and the hub (protocol §10).
//
//   VK            32 random bytes, generated and kept on the wallet device only
//   K_prov        HKDF(VK, "modelpass/v1", "provider-seal")
//   provider blob nonce ‖ AES-GCM(K_prov, JSON(secret), AAD = provider/{user}/{provider})
//   access token  "mpk_" + base64url(secret32) — handed to the third-party app
//   wrapped VK    nonce ‖ AES-GCM(HKDF(secret32, "modelpass/v1", "wrap-vk|{grant}"), VK, AAD = grant/{grant})
//
// The hub stores only ciphertexts and SHA-256(token); it can recover a provider key only while
// a request carrying a valid token is in flight.

import { aesGcmOpenBase64url, aesGcmSealBase64url, hkdfSha256, randomBytes, randomToken, sha256Base64url } from './crypto'
import { base64urlDecode, base64urlEncode, utf8Decode } from './encoding'
import type { ProviderSecret } from './protocol'

const SALT = 'modelpass/v1'
export const ACCESS_TOKEN_PREFIX = 'mpk_'

export function generateVaultKey(): Uint8Array {
  return randomBytes(32)
}

function providerKey(vk: Uint8Array): Uint8Array {
  return hkdfSha256(vk, SALT, 'provider-seal')
}

const providerAad = (userId: string, providerId: string) => `modelpass/v1/provider/${userId}/${providerId}`

export function sealProviderSecret(vk: Uint8Array, userId: string, providerId: string, secret: ProviderSecret, nonce?: Uint8Array): string {
  return aesGcmSealBase64url(providerKey(vk), JSON.stringify(secret), providerAad(userId, providerId), nonce)
}

export function openProviderSecret(vk: Uint8Array, userId: string, providerId: string, sealed: string): ProviderSecret {
  const plain = aesGcmOpenBase64url(providerKey(vk), sealed, providerAad(userId, providerId))
  return JSON.parse(utf8Decode(plain)) as ProviderSecret
}

// ---- access tokens --------------------------------------------------------------------------

export function generateAccessToken(): { token: string; secret: Uint8Array } {
  const secret = randomBytes(32)
  return { token: ACCESS_TOKEN_PREFIX + base64urlEncode(secret), secret }
}

/** Returns the 32-byte secret embedded in a token, or null if the token is malformed. */
export function parseAccessToken(token: string): Uint8Array | null {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null
  try {
    const secret = base64urlDecode(token.slice(ACCESS_TOKEN_PREFIX.length))
    return secret.length === 32 ? secret : null
  } catch {
    return null
  }
}

/** Lookup hash stored by the hub: base64url(SHA256(ASCII(token))). */
export function hashToken(token: string): string {
  return sha256Base64url(token)
}

function wrapKey(tokenSecret: Uint8Array, grantId: string) {
  return hkdfSha256(tokenSecret, SALT, `wrap-vk|${grantId}`)
}

const grantAad = (grantId: string) => `modelpass/v1/grant/${grantId}`

export function wrapVaultKey(vk: Uint8Array, tokenSecret: Uint8Array, grantId: string, nonce?: Uint8Array): string {
  return aesGcmSealBase64url(wrapKey(tokenSecret, grantId), vk, grantAad(grantId), nonce)
}

export function unwrapVaultKey(wrapped: string, tokenSecret: Uint8Array, grantId: string): Uint8Array {
  return aesGcmOpenBase64url(wrapKey(tokenSecret, grantId), wrapped, grantAad(grantId))
}

// ---- authorization codes (same-device flow) -------------------------------------------------
// The wallet mints the code itself and uploads SHA256(code) plus the token sealed under a key
// derived from the code. The hub can only release the token when the app presents the code.

export function generateAuthCode(): string {
  return randomToken(32)
}

export function hashAuthCode(code: string): string {
  return sha256Base64url(code)
}

function codeKey(code: string, grantId: string) {
  return hkdfSha256(base64urlDecode(code), SALT, `code-seal|${grantId}`)
}

const codeAad = (grantId: string) => `modelpass/v1/code/${grantId}`

export function sealTokenWithCode(code: string, grantId: string, token: string, nonce?: Uint8Array): string {
  return aesGcmSealBase64url(codeKey(code, grantId), token, codeAad(grantId), nonce)
}

export function openTokenWithCode(code: string, grantId: string, sealed: string): string {
  return utf8Decode(aesGcmOpenBase64url(codeKey(code, grantId), sealed, codeAad(grantId)))
}
