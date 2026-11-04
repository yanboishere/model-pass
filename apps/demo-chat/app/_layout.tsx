import '../src/polyfills'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ModelPassRedirectHandler } from '../src/redirect'
import { useDemoTheme } from '../src/theme'

export default function Layout() {
  const t = useDemoTheme()
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="modelpass-callback" options={{ animation: 'fade' }} />
        <Stack.Screen name="link" options={{ presentation: 'modal' }} />
      </Stack>
      <ModelPassRedirectHandler />
    </SafeAreaProvider>
  )
}
