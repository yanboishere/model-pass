import { serve } from '@hono/node-server'
import { createApp } from './app'
import { lanAddresses, loadConfig } from './config'
import { Store } from './store'

const config = loadConfig()
const store = Store.open(config.dataDir)
const app = createApp({ store, config, fetch: globalThis.fetch.bind(globalThis) }, { log: process.env.MODELPASS_LOG !== '0' })

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  const urls = [`http://localhost:${config.port}`, ...lanAddresses().map((ip) => `http://${ip}:${config.port}`)]
  console.log('\n  ModelPass Hub is running')
  console.log(`  issuer:  ${config.publicUrl ?? '(derived from request host)'}`)
  for (const u of urls) console.log(`  ➜ ${u}`)
  console.log(`  web demo: http://localhost:${config.port}/demo`)
  console.log(`  data:    ${config.dataDir}\n`)
})

const shutdown = () => {
  store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
