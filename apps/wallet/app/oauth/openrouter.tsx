// Landing route for the OpenRouter OAuth callback when the OS delivers it as a deep link
// (the provider form already receives the code through the auth session).
import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '../../src/theme'

export default function OpenRouterCallback() {
  const t = useTheme()
  useEffect(() => {
    const timer = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/')), 300)
    return () => clearTimeout(timer)
  }, [])
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <ActivityIndicator color={t.brand} />
    </View>
  )
}
