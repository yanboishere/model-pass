// "Continue with ModelPass" button (protocol §14 branding guide).
import { ActivityIndicator, Pressable, Text, View, useColorScheme } from 'react-native'

export function ModelPassButton({ onPress, loading, title = '使用 ModelPass 继续' }: { onPress: () => void; loading?: boolean; title?: string }) {
  const dark = useColorScheme() === 'dark'
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => ({
        height: 54,
        borderRadius: 14,
        backgroundColor: dark ? '#FFFFFF' : '#0B0B0F',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: '#5B5BF7', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>M</Text>
      </View>
      {loading ? <ActivityIndicator color={dark ? '#000' : '#fff'} /> : <Text style={{ color: dark ? '#0B0B0F' : '#FFFFFF', fontSize: 17, fontWeight: '700' }}>{title}</Text>}
    </Pressable>
  )
}
