// The wallet sends the user back here: `<redirect_uri>?code=…&state=…&iss=…`.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { appendQuery, encodeQuery } from '@modelpass/core'
import { ModelPassError } from '@modelpass/sdk'
import { modelpass, REDIRECT_URI } from '../src/modelpass'
import { useDemoTheme } from '../src/theme'

export default function ModelPassCallback() {
  const t = useDemoTheme()
  const params = useLocalSearchParams<Record<string, string>>()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = appendQuery(REDIRECT_URI, encodeQuery(params))
    modelpass
      .handleRedirect(url)
      .then(() => router.replace('/'))
      .catch((e: ModelPassError) => setError(e.code === 'access_denied' ? '你在 ModelPass 中取消了授权。' : e.message))
  }, [])

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, backgroundColor: t.bg }}>
      {error ? (
        <>
          <Text style={{ fontSize: 18, fontWeight: '700', color: t.ink }}>未完成连接</Text>
          <Text style={{ fontSize: 15, color: t.muted, textAlign: 'center' }}>{error}</Text>
          <Pressable onPress={() => router.replace('/')}>
            <Text style={{ color: t.accent, fontSize: 16, fontWeight: '700' }}>返回</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted }}>正在完成 ModelPass 连接…</Text>
        </>
      )}
    </View>
  )
}
