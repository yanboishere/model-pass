import '../src/polyfills'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useTheme } from '../src/theme'
import { InitialLinkFallback } from '../src/lib/initial-link'
import { WalletProvider } from '../src/wallet'

export default function RootLayout() {
  const t = useTheme()
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerTintColor: t.brand,
            headerTitleStyle: { color: t.ink, fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="authorize" options={{ presentation: 'modal', title: '授权请求' }} />
          <Stack.Screen name="link" options={{ presentation: 'modal', title: '扫码授权' }} />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', headerShown: false }} />
          <Stack.Screen name="setup" options={{ presentation: 'modal', title: '设置 Hub' }} />
          <Stack.Screen name="provider/new" options={{ title: '添加模型厂商' }} />
          <Stack.Screen name="provider/[id]" options={{ title: '厂商设置' }} />
          <Stack.Screen name="grants/[id]" options={{ title: '应用详情' }} />
          <Stack.Screen name="import/provider" options={{ presentation: 'modal', title: '导入厂商' }} />
          <Stack.Screen name="connect/chatgpt" options={{ title: 'ChatGPT 订阅（实验）' }} />
          <Stack.Screen name="oauth/openrouter" options={{ headerShown: false }} />
        </Stack>
        <InitialLinkFallback />
      </WalletProvider>
    </SafeAreaProvider>
  )
}
