import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { apiRoutes } from './routes/api'
import { mockRoutes } from './routes/mock'
import { oauthRoutes } from './routes/oauth'
import { pageRoutes } from './routes/pages'
import { walletRoutes } from './routes/wallet'
import type { HubDeps } from './util'

export function createApp(deps: HubDeps, options: { log?: boolean } = {}) {
  const app = new Hono()
  if (options.log) app.use('*', logger())

  // Bearer tokens only (no cookies), so permissive CORS is safe and lets web apps call the hub.
  const corsAll = cors({
    origin: '*',
    allowHeaders: ['authorization', 'content-type', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
    exposeHeaders: ['x-modelpass-slot', 'x-modelpass-model', 'x-modelpass-provider', 'x-modelpass-fallback', 'x-modelpass-budget-remaining'],
  })
  app.use('/v1/*', corsAll)
  app.use('/oauth/*', corsAll)
  app.use('/.well-known/*', corsAll)

  app.get('/healthz', (c) => c.json({ ok: true }))
  app.route('/', oauthRoutes(deps))
  app.route('/wallet/v1', walletRoutes(deps))
  app.route('/v1', apiRoutes(deps))
  if (deps.config.enableMock) app.route('/mock', mockRoutes())
  app.route('/', pageRoutes(deps))

  app.onError((err, c) => {
    console.error('[hub] unhandled error', err)
    return c.json({ error: { message: 'internal error', type: 'modelpass_error', code: 'upstream_error' } }, 500)
  })
  return app
}
