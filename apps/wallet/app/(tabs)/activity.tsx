import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { Card, EmptyState, LargeTitle, Screen } from '../../src/components/ui'
import { clock } from '../../src/lib/format'
import { useTheme } from '../../src/theme'
import { useWallet } from '../../src/wallet'

export default function Activity() {
  const t = useTheme()
  const w = useWallet()
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    await w.loadActivity().finally(() => setLoading(false))
  }, [w.loadActivity])
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )
  const providerName = (id: string | null) => w.providers.find((p) => p.record.id === id)?.record.name ?? ''
  return (
    <Screen padTop refreshing={loading} onRefresh={load}>
      <LargeTitle title="活动" subtitle="只记录元数据，从不记录对话内容" />
      {w.activity.length === 0 ? (
        <EmptyState icon="pulse-outline" title="暂无请求记录" body="应用通过 ModelPass 发出的每一次请求都会出现在这里。" />
      ) : (
        <Card padded={false}>
          {w.activity.map((a, i) => {
            const ok = a.status >= 200 && a.status < 300
            const color = ok ? t.success : a.status === 499 ? t.faint : t.danger
            return (
              <View key={a.id} style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: i === w.activity.length - 1 ? 0 : 0.5, borderBottomColor: t.line, gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name={ok ? 'checkmark-circle' : a.status === 499 ? 'remove-circle' : 'alert-circle'} size={16} color={color} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: t.ink }} numberOfLines={1}>
                    {a.clientName}
                  </Text>
                  <Text style={{ fontSize: 12, color: t.faint }}>{clock(a.ts)}</Text>
                </View>
                <Text style={{ fontSize: 13, color: t.muted }} numberOfLines={1}>
                  {a.slot} → {a.model ?? '—'} {providerName(a.providerId) ? `· ${providerName(a.providerId)}` : ''}
                </Text>
                <Text style={{ fontSize: 12, color: t.faint }}>
                  {a.stream ? '流式 · ' : ''}
                  {a.promptTokens + a.completionTokens} tokens（输入 {a.promptTokens} / 输出 {a.completionTokens}） · {a.latencyMs}ms
                  {a.status === 499 ? ' · 客户端中断' : !ok ? ` · ${a.status}` : ''}
                </Text>
                {!ok && a.error && a.status !== 499 ? (
                  <Text style={{ fontSize: 12, color: t.danger }} numberOfLines={2}>
                    {a.error}
                  </Text>
                ) : null}
              </View>
            )
          })}
        </Card>
      )}
    </Screen>
  )
}
