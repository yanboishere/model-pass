import { useCallback, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Ionicons } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'
import { router, useFocusEffect } from 'expo-router'
import { getPreset, hostOf, slotTarget, SLOT_INFO, type RouteTarget } from '@modelpass/core'
import { ModelPicker, ProviderAvatar } from '../../src/components/ModelPicker'
import { Avatar, Button, Card, EmptyState, LargeTitle, ListRow, Pill, Screen, SectionHeader } from '../../src/components/ui'
import { useAddDemoProviders } from '../../src/lib/demo'
import { compact, timeAgo } from '../../src/lib/format'
import { useTheme } from '../../src/theme'
import { describeTarget, useWallet } from '../../src/wallet'

export default function Home() {
  const t = useTheme()
  const w = useWallet()
  const addDemo = useAddDemoProviders()
  const [picker, setPicker] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useFocusEffect(
    useCallback(() => {
      w.refresh()
    }, [w.refresh]),
  )

  const ctx = { grantRoutes: {}, globalRoutes: w.routes, providers: w.providers.map((p) => ({ id: p.record.id })) }
  const current = describeTarget(w.providers, slotTarget('default', ctx))
  const active = w.grants.filter((g) => g.status === 'active' || g.status === 'paused')
  const today = useMemo(() => active.reduce((acc, g) => ({ req: acc.req + g.usageToday.requests, tok: acc.tok + g.usageToday.tokens }), { req: 0, tok: 0 }), [active])
  const pickerProvider = w.providers.find((p) => p.record.id === picker)

  const switchTo = async (providerId: string, model?: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
    await w.switchToProvider(providerId, model)
  }

  return (
    <Screen padTop refreshing={w.syncing} onRefresh={w.refresh}>
      <LargeTitle
        title="ModelPass"
        subtitle={w.hubOnline === false ? 'Hub 离线 · 修改将在恢复后同步' : `Hub 在线 · ${w.identity ? hostOf(w.identity.hubUrl) : ''}`}
        dot={w.hubOnline === false ? t.danger : w.hubOnline ? t.success : t.faint}
        right={
          <Pressable onPress={() => router.push('/scan')} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.line }}>
            <Ionicons name="scan" size={21} color={t.brand} />
          </Pressable>
        }
      />

      <Pressable onPress={() => router.push('/providers')}>
        <LinearGradient colors={[t.brand, t.brand2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, padding: 20 }}>
          <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '700' }}>当前默认模型</Text>
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 28, fontWeight: '900', marginTop: 6, letterSpacing: -0.5 }}>{current.model}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginTop: 2 }}>{current.provider || '添加一个厂商即可开始'}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            {(['fast', 'reasoning', 'vision'] as const).map((slot) => {
              const d = describeTarget(w.providers, slotTarget(slot, ctx))
              return (
                <View key={slot} style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, flexDirection: 'row', gap: 6 }}>
                  <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: '700' }}>{SLOT_INFO[slot].label}</Text>
                  <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '700', maxWidth: 130 }}>{d.model}</Text>
                </View>
              )
            })}
          </View>
        </LinearGradient>
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        {[
          { label: '已连接应用', value: String(active.length), icon: 'apps' as const },
          { label: '今日请求', value: compact(today.req), icon: 'flash' as const },
          { label: '今日 Tokens', value: compact(today.tok), icon: 'stats-chart' as const },
        ].map((s) => (
          <Card key={s.label} style={{ flex: 1, padding: 14 }}>
            <Ionicons name={s.icon} size={16} color={t.brand} />
            <Text style={{ fontSize: 22, fontWeight: '800', color: t.ink, marginTop: 6 }}>{s.value}</Text>
            <Text style={{ fontSize: 12, color: t.muted, marginTop: 1 }}>{s.label}</Text>
          </Card>
        ))}
      </View>

      <SectionHeader title="一键切换" action={w.providers.length ? '管理' : undefined} onAction={() => router.push('/providers')} />
      {w.providers.length === 0 ? (
        <EmptyState icon="layers-outline" title="还没有模型" body="添加你的 API Key 或授权一个厂商账户；也可以先用 Hub 内置的演示模型体验完整流程。">
          <Button
            title="体验演示模型"
            icon="flask-outline"
            loading={busy}
            onPress={async () => {
              setBusy(true)
              await addDemo().finally(() => setBusy(false))
            }}
          />
          <Button title="添加厂商" variant="secondary" icon="add" onPress={() => router.push('/provider/new')} />
        </EmptyState>
      ) : (
        <Card padded={false}>
          {w.providers.map((p, i) => {
            const using = w.routes.default?.providerId === p.record.id
            const defaultModel = using ? w.routes.default!.model : getPreset(p.record.presetId)?.defaults.default ?? p.record.models[0] ?? '无可用模型'
            return (
              <ListRow
                key={p.record.id}
                last={i === w.providers.length - 1}
                left={<ProviderAvatar presetId={p.record.presetId} />}
                title={p.record.name}
                subtitle={`${defaultModel} · ${p.record.models.length} 个模型`}
                onPress={() => setPicker(p.record.id)}
                chevron={false}
                right={
                  using ? (
                    <Pill text="使用中" tone="success" icon="checkmark" />
                  ) : (
                    <Button title="切换" size="sm" variant="secondary" disabled={!p.record.models.length} onPress={() => switchTo(p.record.id)} />
                  )
                }
              />
            )
          })}
        </Card>
      )}

      <SectionHeader title="已连接的应用" action={active.length ? '全部' : undefined} onAction={() => router.push('/apps')} />
      {active.length === 0 ? (
        <Card>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            还没有应用接入。在任意支持 ModelPass 的应用中点击「使用 ModelPass 继续」，或扫描网页上的授权二维码。
          </Text>
        </Card>
      ) : (
        <Card padded={false}>
          {active.slice(0, 4).map((g, i, arr) => (
            <ListRow
              key={g.id}
              last={i === arr.length - 1}
              left={<Avatar emoji={g.client.icon && g.client.icon.length <= 2 ? g.client.icon : undefined} label={g.clientName.slice(0, 1)} />}
              title={g.clientName}
              subtitle={`今日 ${g.usageToday.requests} 次 · ${compact(g.usageToday.tokens)} tokens · ${timeAgo(g.lastUsedAt)}`}
              right={g.status === 'paused' ? <Pill text="已暂停" tone="warning" /> : null}
              onPress={() => router.push(`/grants/${g.id}`)}
            />
          ))}
        </Card>
      )}

      <ModelPicker
        visible={!!pickerProvider}
        title={pickerProvider ? `用 ${pickerProvider.record.name} 作为默认` : ''}
        providers={pickerProvider ? [pickerProvider] : []}
        value={w.routes.default as RouteTarget | undefined}
        onClose={() => setPicker(null)}
        onSelect={(target) => target && switchTo(target.providerId, target.model)}
      />
    </Screen>
  )
}
