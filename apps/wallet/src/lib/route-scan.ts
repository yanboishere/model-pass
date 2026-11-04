import { router } from 'expo-router'
import { getUrlParams, parseLinkUrl } from '@modelpass/core'

/** Routes any ModelPass QR / link payload to the right screen. Returns false if unrecognised. */
export function routeScannedText(raw: string): boolean {
  const text = raw.trim()
  if (parseLinkUrl(text)) {
    router.replace({ pathname: '/link', params: { url: text } })
    return true
  }
  const path = text.replace(/^[a-z][a-z0-9+.-]*:\/\/(--\/)?/i, '').replace(/^[^?]*\/--\//, '')
  const params = getUrlParams(text)
  if (/^setup\b/.test(path) && params.hub) {
    router.replace({ pathname: '/setup', params: { hub: params.hub } })
    return true
  }
  if (/^import\/provider\b/.test(path)) {
    router.replace({ pathname: '/import/provider', params })
    return true
  }
  if (/^authorize\b/.test(path)) {
    router.replace({ pathname: '/authorize', params })
    return true
  }
  return false
}

