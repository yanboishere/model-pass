import { Redirect, Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { ActivityIndicator, View, type ColorValue } from 'react-native'
import { useTheme } from '../../src/theme'
import { useWallet } from '../../src/wallet'

type IconName = React.ComponentProps<typeof Ionicons>['name']
const icon = (name: IconName, active: IconName) =>
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
    return <Ionicons name={focused ? active : name} size={23} color={color as string} />
  }

export default function TabsLayout() {
  const t = useTheme()
  const { ready, identity } = useWallet()
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
        <ActivityIndicator color={t.brand} />
      </View>
    )
  }
  if (!identity) return <Redirect href="/onboarding" />
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.faint,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.line },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: '总览', tabBarIcon: icon('grid-outline', 'grid') }} />
      <Tabs.Screen name="providers" options={{ title: '模型', tabBarIcon: icon('layers-outline', 'layers') }} />
      <Tabs.Screen name="apps" options={{ title: '应用', tabBarIcon: icon('apps-outline', 'apps') }} />
      <Tabs.Screen name="activity" options={{ title: '活动', tabBarIcon: icon('pulse-outline', 'pulse') }} />
      <Tabs.Screen name="settings" options={{ title: '设置', tabBarIcon: icon('settings-outline', 'settings') }} />
    </Tabs>
  )
}
