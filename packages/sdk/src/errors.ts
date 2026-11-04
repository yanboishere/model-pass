export type ModelPassErrorCode =
  | 'wallet_not_installed'
  | 'access_denied'
  | 'invalid_state'
  | 'invalid_request'
  | 'invalid_response'
  | 'untrusted_issuer'
  | 'token_exchange_failed'
  | 'not_connected'
  | 'expired_token'
  | 'cancelled'
  | 'invalid_token'
  | 'grant_revoked'
  | 'grant_expired'
  | 'grant_paused'
  | 'insufficient_scope'
  | 'budget_exceeded'
  | 'no_route'
  | 'upstream_auth_failed'
  | 'upstream_error'
  | 'unsupported_format'
  | (string & {})

export class ModelPassError extends Error {
  constructor(
    readonly code: ModelPassErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ModelPassError'
  }

  /** The user must reconnect (token invalid, revoked or expired). */
  get needsReconnect(): boolean {
    return ['invalid_token', 'grant_revoked', 'grant_expired', 'not_connected'].includes(this.code)
  }

  /** The user can fix this in the ModelPass wallet (paused, no model selected, bad key, budget). */
  get fixableInWallet(): boolean {
    return ['grant_paused', 'no_route', 'upstream_auth_failed', 'budget_exceeded', 'insufficient_scope'].includes(this.code)
  }
}
