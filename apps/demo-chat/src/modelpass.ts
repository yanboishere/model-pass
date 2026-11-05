// The only ModelPass-specific setup a third-party app needs.
import { useEffect, useState } from 'react'
import Constants from 'expo-constants'
import * as Linking from 'expo-linking'
import * as SecureStore from 'expo-secure-store'
import { fetch as expoFetch } from 'expo/fetch'
import { ModelPassClient, type ModelPassSession, type ModelPassStorage } from '@modelpass/sdk'

/** Wallet entry point. In Expo Go the wallet runs as exp://<host>:8081/--/authorize. */
export const WALLET_AUTHORIZE_URL = process.env.EXPO_PUBLIC_MODELPASS_WALLET_URL ?? 'modelpass://authorize'
export const WALLET_BASE = WALLET_AUTHORIZE_URL.replace(/authorize\/?$/, '')

/**
 * Hub used as the rendezvous for "scan from another device". Production apps would use a hosted hub;
 * in development it is the machine running Metro. Standalone demo builds ask the user (see app/link.tsx).
 */
export function rendezvousHub(): string {
  if (process.env.EXPO_PUBLIC_MODELPASS_HUB_URL) return process.env.EXPO_PUBLIC_MODELPASS_HUB_URL
  const host = Constants.expoConfig?.hostUri?.split(':')[0]
  return host ? `http://${host}:8787` : ''
}

const HUB_KEY = 'mpdemo.rendezvous'
export const loadSavedHub = () => SecureStore.getItemAsync(HUB_KEY)
export const saveHub = (url: string) => SecureStore.setItemAsync(HUB_KEY, url)

/** Where the wallet sends the user back. Expo Go: exp://<host>:8082/--/modelpass-callback */
export const REDIRECT_URI = Linking.createURL('modelpass-callback')

const storage: ModelPassStorage = {
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  removeItem: (k) => SecureStore.deleteItemAsync(k),
}

export const modelpass = new ModelPassClient({
  clientId: 'dev.modelpass.demochat',
  clientName: 'ModelPass Demo Chat',
  redirectUri: REDIRECT_URI,
  scopes: ['chat', 'vision'],
  slots: ['default', 'fast', 'reasoning', 'vision'],
  walletAuthorizeUrl: WALLET_AUTHORIZE_URL,
  storage,
  // expo/fetch supports streaming response bodies (needed for SSE).
  fetch: expoFetch as unknown as typeof fetch,
  openUrl: (url) => Linking.openURL(url),
})

export function useModelPassSession() {
  const [session, setSession] = useState<ModelPassSession | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    modelpass.getSession().then((s) => alive && setSession(s))
    const off = modelpass.onSessionChange((s) => setSession(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return session
}
