import { useEffect, useRef } from 'react'
import * as Linking from 'expo-linking'
import { router, usePathname, useRootNavigationState } from 'expo-router'

const ROUTES = /^(authorize|link|setup|scan|import\/provider|grants\/[A-Za-z0-9_]+)$/

/** `modelpass://authorize?x` and `exp://host:8081/--/authorize?x` → `/authorize?x` */
export function routeFromUrl(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*\/--\/)?([^?#]*)(\?[^#]*)?/i.exec(url)
  if (!m) return null
  const path = m[1].replace(/\/+$/, '')
  return ROUTES.test(path) ? `/${path}${m[2] ?? ''}` : null
}

/**
 * Safety net for cold starts: if the app was launched by a deep link that the router missed
 * (happens when Expo Go switches between projects), navigate to it once navigation is ready.
 */
export function InitialLinkFallback() {
  const nav = useRootNavigationState()
  const pathname = usePathname()
  const done = useRef(false)
  useEffect(() => {
    if (!nav?.key || done.current) return
    done.current = true
    Linking.getInitialURL().then((url) => {
      const target = url ? routeFromUrl(url) : null
      if (target && (pathname === '/' || pathname === '/onboarding')) router.push(target as never)
    })
  }, [nav?.key])
  return null
}
