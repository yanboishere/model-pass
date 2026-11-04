import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getUrlParams } from '@modelpass/core'
import { MemoryStorage, ModelPassClient, ModelPassError } from '../src/index'

const make = (extra: Partial<ConstructorParameters<typeof ModelPassClient>[0]> = {}) => {
  let opened = ''
  const client = new ModelPassClient({
    clientId: 'com.example.app',
    redirectUri: 'com.example.app://cb',
    storage: new MemoryStorage(),
    openUrl: (u) => {
      opened = u
    },
    fetch: async () => Response.json({ error: 'x' }, { status: 500 }),
    ...extra,
  })
  return { client, opened: () => opened }
}

describe('ModelPassClient redirect handling', () => {
  it('ignores unrelated URLs and rejects state mismatches', async () => {
    const { client } = make()
    assert.equal(await client.handleRedirect('other://x?code=1'), null)
    await client.createAuthorizationUrl()
    await assert.rejects(client.handleRedirect('com.example.app://cb?code=a&state=wrong&iss=https://hub.example.com'), (e: ModelPassError) => e.code === 'invalid_state')
  })

  it('surfaces access_denied to the pending authorize() call', async () => {
    const { client, opened } = make()
    const p = client.authorize()
    await new Promise((r) => setTimeout(r, 5))
    const { state } = getUrlParams(opened())
    await assert.rejects(client.handleRedirect(`com.example.app://cb?error=access_denied&state=${state}`), (e: ModelPassError) => e.code === 'access_denied')
    await assert.rejects(p, (e: ModelPassError) => e.code === 'access_denied')
  })

  it('validates the issuer before exchanging the code', async () => {
    for (const [iss, ok] of [
      ['http://evil.example.com', false],
      ['http://192.168.1.5:8787', true],
      ['https://hub.example.com', true],
      ['javascript:alert(1)', false],
    ] as const) {
      const calls: string[] = []
      const { client } = make({
        fetch: async (input) => {
          calls.push(String(input))
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        },
      })
      const url = await client.createAuthorizationUrl()
      const { state } = getUrlParams(url)
      await assert.rejects(client.handleRedirect(`com.example.app://cb?code=c&state=${state}&iss=${encodeURIComponent(iss)}`), (e: ModelPassError) =>
        ok ? e.code === 'token_exchange_failed' : e.code === 'untrusted_issuer',
      )
      assert.equal(calls.length > 0, ok)
    }
  })

  it('honours a trusted issuer allowlist', async () => {
    const { client } = make({ trustedIssuers: ['https://hub.example.com'] })
    const { state } = getUrlParams(await client.createAuthorizationUrl())
    await assert.rejects(client.handleRedirect(`com.example.app://cb?code=c&state=${state}&iss=https://other.example.com`), (e: ModelPassError) => e.code === 'untrusted_issuer')
  })
})
