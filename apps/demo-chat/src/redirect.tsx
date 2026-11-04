import { useEffect } from 'react'
import * as Linking from 'expo-linking'
import { router } from 'expo-router'
import { modelpass } from './modelpass'

/**
 * Hands every incoming URL to the SDK, the same way a native app forwards `onOpenURL`.
 * The `/modelpass-callback` route does the same; the SDK de-duplicates the exchange.
 */
export function ModelPassRedirectHandler() {
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url || !modelpass.isRedirect(url)) return
      modelpass
        .handleRedirect(url)
        .then((s) => s && router.replace('/'))
        .catch(() => undefined)
    }
    Linking.getInitialURL().then(handle)
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
  }, [])
  return null
}
