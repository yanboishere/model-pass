import { useEffect, useState } from 'react'
import { Alert, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { SCOPE_INFO, SLOT_INFO, slotTarget, type RouteMap, type SlotId } from '@modelpass/core'
import { ModelPicker } from '../../src/components/ModelPicker'
import { Avatar, Button, Card, EmptyState, Label, ListRow, Pill, Screen, SectionHeader, Segmented, ToggleRow } from '../../src/components/ui'
import { clock, compact, expiryLabel, timeAgo } from '../../src/lib/format'
import { BUDGET_OPTIONS, EXPIRY_OPTIONS, expiresAtFromDays } from '../../src/lib/options'
import { useTheme } from '../../src/theme'
import { describeTarget, useWallet } from '../../src/wallet'

export default function GrantDetail() {
  const t = useTheme()
  const w = useWallet()
  const { id } = useLocalSearchParams<{ id: string }>()
  const g = w.grants.find((x) => x.id === id)
  const [picker, setPicker] = useState<SlotId | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    w.refresh()
    w.loadActivity()
  }, [id])

  if (!g) {
    return (
      <Screen>
        <EmptyState icon="search-outline" title="找不到这个授权" body="它可能已被撤销，或属于另一个 Hub。" />
      </Screen>
    )
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      Alert.alert('操作失败', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const ctx = { grantRoutes: g.routes, globalRoutes: w.routes, providers: w.providers.map((p) => ({ id: p.record.id })) }
  const budget = g.budget.tokensPerDay
  const used = g.usageToday.tokens
  const activity = w.activity.filter((a) => a.grantId === g.id).slice(0, 8)
  const expiryDays = g.expiresAt ? Math.max(1, Math.round((g.expiresAt - Date.now() / 1000) / 86400)) : null

  return (
    <Screen refreshing={w.syncing} onRefresh={w.refresh}>
      <Stack.Screen options={{ title: g.clientName }} />
      <Card style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <Avatar emoji={g.client.icon && g.client.icon.length <= 2 ? g.client.icon : undefined} label={g.clientName.slice(0, 1)} size={54} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 19, fontWeight: '800', color: t.ink }}>{g.clientName}</Text>
          <Text style={{ fontSize: 12, color: t.faint }}>{g.clientId}</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {g.client.verified ? <Pill text="已验证" tone="brand" icon="shield-checkmark" /> : <Pill text="未验证" tone="warning" />}
            <Pill text={expiryLabel(g.expiresAt)} />
          </View>
        </View>
      </Card>

      <Card padded={false}>
        <ToggleRow
          title={g.status === 'paused' ? '已暂停' : '允许访问'}
          subtitle={g.status === 'paused' ? '应用的请求会被拒绝（403 grant_paused）' : `授权于 ${timeAgo(g.createdAt)} · 最近使用 ${timeAgo(g.lastUsedAt)}`}
          value={g.status === 'active'}
          onValueChange={(v) => run(() => w.updateGrant(g.id, { status: v ? 'active' : 'paused' }))}
          last
        />
      </Card>

      <SectionHeader title="今日用量" />
      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 26, fontWeight: '800', color: t.ink }}>
            {compact(used)}
            <Text style={{ fontSize: 14, color: t.muted, fontWeight: '600' }}>{budget ? ` / ${compact(budget)} tokens` : ' tokens'}</Text>
          </Text>
          <Text style={{ fontSize: 14, color: t.muted, alignSelf: 'flex-end' }}>{g.usageToday.requests} 次请求</Text>
        </View>
        {budget ? (
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.input, overflow: 'hidden' }}>
            <View style={{ width: `${Math.min(100, (used / budget) * 100)}%`, height: 8, backgroundColor: used >= budget ? t.danger : t.brand }} />
          </View>
        ) : null}
        <Text style={{ fontSize: 12, color: t.faint }}>累计 {compact(g.usageTotal.tokens)} tokens · {g.usageTotal.requests} 次</Text>
      </Card>

      <SectionHeader title="模型（单独指定 / 跟随全局）" />
      <Card padded={false}>
        {g.slots.map((slot, i) => {
          const d = describeTarget(w.providers, slotTarget(slot, ctx))
          const custom = !!g.routes[slot]
          return (
            <ListRow
              key={slot}
              last={i === g.slots.length - 1}
              title={`${SLOT_INFO[slot].label} · ${slot}`}
              subtitle={`${d.model}${d.provider ? ` · ${d.provider}` : ''}`}
              right={custom ? <Pill text="单独指定" tone="brand" /> : <Pill text="跟随全局" />}
              onPress={() => setPicker(slot)}
            />
          )
        })}
      </Card>

      <SectionHeader title="限制" />
      <Card padded={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View>
            <Label>每日 token 额度</Label>
            <Segmented options={BUDGET_OPTIONS} value={BUDGET_OPTIONS.some((o) => o.value === budget) ? budget : null} onChange={(v) => run(() => w.updateGrant(g.id, { budget: { tokensPerDay: v, requestsPerDay: g.budget.requestsPerDay } }))} />
          </View>
          <View>
            <Label>有效期（从现在起）</Label>
            <Segmented options={EXPIRY_OPTIONS} value={EXPIRY_OPTIONS.some((o) => o.value === expiryDays) ? expiryDays : null} onChange={(v) => run(() => w.updateGrant(g.id, { expiresAt: expiresAtFromDays(v) }))} />
          </View>
        </View>
        <ToggleRow title="向应用展示模型名称" value={g.shareModelInfo} onValueChange={(v) => run(() => w.updateGrant(g.id, { shareModelInfo: v }))} last />
      </Card>

      <SectionHeader title="权限" />
      <Card style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {g.scope.map((s) => (
          <Pill key={s} text={SCOPE_INFO[s].label} tone="brand" />
        ))}
      </Card>

      {activity.length ? (
        <>
          <SectionHeader title="最近请求" />
          <Card padded={false}>
            {activity.map((a, i) => (
              <ListRow
                key={a.id}
                last={i === activity.length - 1}
                title={`${a.slot} → ${a.model ?? '—'}`}
                subtitle={`${clock(a.ts)} · ${a.promptTokens + a.completionTokens} tokens · ${a.latencyMs}ms${a.status >= 300 ? ` · ${a.status}` : ''}`}
                chevron={false}
              />
            ))}
          </Card>
        </>
      ) : null}

      <Button
        title="撤销授权"
        variant="danger"
        icon="trash-outline"
        loading={busy}
        onPress={() =>
          Alert.alert(`撤销「${g.clientName}」？`, '应用将立即失去访问权，需要重新授权才能再次使用你的模型。', [
            { text: '取消', style: 'cancel' },
            {
              text: '撤销',
              style: 'destructive',
              onPress: () =>
                run(async () => {
                  await w.revokeGrant(g.id)
                  router.back()
                }),
            },
          ])
        }
      />

      <ModelPicker
        visible={!!picker}
        title={picker ? `「${SLOT_INFO[picker].label}」模型` : ''}
        providers={w.providers}
        value={picker ? g.routes[picker] : null}
        followLabel="跟随全局设置"
        onClose={() => setPicker(null)}
        onSelect={(target) => {
          if (!picker) return
          const routes: RouteMap = { ...g.routes }
          if (target) routes[picker] = target
          else delete routes[picker]
          run(() => w.updateGrant(g.id, { routes }))
        }}
      />
    </Screen>
  )
}
