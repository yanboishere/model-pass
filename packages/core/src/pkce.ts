import { constantTimeEqual } from './encoding'
import { randomToken, sha256Base64url } from './crypto'

/** 32 random bytes → 43-character base64url string (RFC 7636 §4.1). */
export function createCodeVerifier(): string {
  return randomToken(32)
}

/** S256 transform: base64url(SHA256(ASCII(verifier))). Also used for the link flow's link_challenge. */
export function codeChallengeS256(verifier: string): string {
  return sha256Base64url(verifier)
}

export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  return constantTimeEqual(codeChallengeS256(verifier), challenge)
}

export function createState(): string {
  return randomToken(16)
}
