import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { base64urlDecode, base64urlEncode, concatBytes, utf8Encode } from './encoding'

const NONCE_LENGTH = 12
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

type BytesLike = Uint8Array | string
const toBytes = (v: BytesLike) => (typeof v === 'string' ? utf8Encode(v) : v)

/**
 * Cryptographically secure random bytes. On React Native install a
 * `globalThis.crypto.getRandomValues` polyfill (e.g. from expo-crypto) before use.
 */
export function randomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (!c?.getRandomValues) {
    throw new Error('ModelPass: crypto.getRandomValues is not available; install a secure random polyfill')
  }
  const out = new Uint8Array(length)
  c.getRandomValues(out)
  return out
}

/** Random alphanumeric identifier, e.g. randomId('g_', 16). Uses rejection sampling (no modulo bias). */
export function randomId(prefix: string, length = 16): string {
  let out = prefix
  while (out.length < prefix.length + length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < prefix.length + length) out += ID_ALPHABET[b % 62]
    }
  }
  return out
}

export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes))
}

export function sha256(data: BytesLike): Uint8Array {
  return nobleSha256(toBytes(data))
}

export function sha256Base64url(data: BytesLike): string {
  return base64urlEncode(sha256(data))
}

export function hmacSha256(key: BytesLike, message: BytesLike): Uint8Array {
  return hmac(nobleSha256, toBytes(key), toBytes(message))
}

export function hkdfSha256(ikm: BytesLike, salt: BytesLike, info: BytesLike, length = 32): Uint8Array {
  return hkdf(nobleSha256, toBytes(ikm), toBytes(salt), toBytes(info), length)
}

/** AES-256-GCM. Output = nonce(12) ‖ ciphertext ‖ tag(16). */
export function aesGcmSeal(key: Uint8Array, plaintext: BytesLike, aad: BytesLike, nonce = randomBytes(NONCE_LENGTH)): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key')
  if (nonce.length !== NONCE_LENGTH) throw new Error('AES-GCM nonce must be 12 bytes')
  const ct = gcm(key, nonce, toBytes(aad)).encrypt(toBytes(plaintext))
  return concatBytes(nonce, ct)
}

/** Inverse of {@link aesGcmSeal}. Throws if authentication fails. */
export function aesGcmOpen(key: Uint8Array, sealed: Uint8Array, aad: BytesLike): Uint8Array {
  if (sealed.length < NONCE_LENGTH + 16) throw new Error('sealed payload too short')
  const nonce = sealed.subarray(0, NONCE_LENGTH)
  const ct = sealed.subarray(NONCE_LENGTH)
  return gcm(key, nonce, toBytes(aad)).decrypt(ct)
}

export function aesGcmSealBase64url(key: Uint8Array, plaintext: BytesLike, aad: BytesLike, nonce?: Uint8Array): string {
  return base64urlEncode(aesGcmSeal(key, plaintext, aad, nonce))
}

export function aesGcmOpenBase64url(key: Uint8Array, sealed: string, aad: BytesLike): Uint8Array {
  return aesGcmOpen(key, base64urlDecode(sealed), aad)
}
