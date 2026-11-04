import { useCallback } from 'react'
import { getPreset, resolvePresetBaseUrl } from '@modelpass/core'
import { useWallet } from '../wallet'

/** Adds the hub's two built-in mock providers so the whole flow can be tried without real keys. */
export function useAddDemoProviders() {
  const { identity, saveProvider, setRoute } = useWallet()
  return useCallback(async () => {
    if (!identity) return
    const ids: Record<string, string> = {}
    for (const presetId of ['demo-openai', 'demo-anthropic']) {
      const p = getPreset(presetId)!
      const saved = await saveProvider({
        presetId,
        name: p.name,
        format: p.format,
        models: p.models,
        secret: { baseUrl: resolvePresetBaseUrl(p, identity.hubUrl), apiKey: 'demo' },
        auth: 'api-key',
      })
      ids[presetId] = saved.record.id
    }
    await setRoute('reasoning', { providerId: ids['demo-anthropic'], model: 'mock-claude-opus' })
  }, [identity, saveProvider, setRoute])
}

