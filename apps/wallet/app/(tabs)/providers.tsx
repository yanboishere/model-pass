import { useState } from 'react'
import { Text, View } from 'react-native'
import { router } from 'expo-router'
import { slotTarget, SLOTS, SLOT_INFO, type SlotId } from '@modelpass/core'
import { ModelPicker, ProviderAvatar } from '../../src/components/ModelPicker'
import { Button, Card, EmptyState, IconBadge, LargeTitle, ListRow, Muted, Pill, Screen, SectionHeader } from '../../src/components/ui'
import { useTheme } from '../../src/theme'
import { describeTarget, useWallet } from '../../src/wallet'

const SLOT_ICONS = { default: 'chatbubble-ellipses', fast: 'flash', reasoning: 'bulb', vision: 'eye' } as const

export default function Providers() {
  const t = useTheme()
  const w = useWallet()
  const [slot, setSlot] = useState<SlotId | null>(null)
  const ctx = { grantRoutes: {}, globalRoutes: w.routes, providers: w.providers.map((p) => ({ id: p.record.id })) }

  return (
    <Screen padTop refreshing={w.syncing} onRefresh={w.refresh}>
      <LargeTitle title="模型" subtitle="为每个槽位选择模型，所有应用即时生效" />

      <SectionHeader title="模型槽位" />
      <Card padded={false}>
        {SLOTS.map((s, i) => {
          const own = w.routes[s]
          const d = describeTarget(w.providers, slotTarget(s, ctx))
          return (
            <ListRow
              key={s}
              last={i === SLOTS.length - 1}
              left={<IconBadge name={SLOT_ICONS[s]} />}
              title={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: t.ink }}>{SLOT_INFO[s].label}</Text>
                  <Text style={{ fontSize: 12, color: t.faint }}>{s}</Text>
                </View>
              }
              subtitle={
                <Text numberOfLines={1} style={{ fontSize: 13, color: t.muted, marginTop: 2 }}>
                  {s !== 'default' && !own ? `跟随默认 · ${d.model}` : `${d.model}${d.provider ? ` · ${d.provider}` : ''}`}
                </Text>
              }
              onPress={() => setSlot(s)}
            />
          )
        })}
      </Card>
      <Muted style={{ paddingHorizontal: 4 }}>
        应用请求的是槽位（如 default、fast），而不是具体模型。应用写死的其他模型名会自动回落到「默认」槽位；你也可以在「应用」里为单个应用单独指定。
      </Muted>

      <SectionHeader title="我的厂商" action="添加" onAction={() => router.push('/provider/new')} />
      {w.providers.length === 0 ? (
        <EmptyState icon="key-outline" title="添加第一个厂商" body="支持 OpenAI、Anthropic、Gemini、DeepSeek、Kimi、智谱、通义、OpenRouter、Ollama 及任意兼容接口。">
          <Button title="添加厂商" icon="add" onPress={() => router.push('/provider/new')} />
        </EmptyState>
      ) : (
        <Card padded={false}>
          {w.providers.map((p, i) => (
            <ListRow
              key={p.record.id}
              last={i === w.providers.length - 1}
              left={<ProviderAvatar presetId={p.record.presetId} />}
              title={p.record.name}
              subtitle={`${p.record.host ?? ''} · ${p.keyHint} · ${p.record.models.length} 个模型`}
              right={!p.synced ? <Pill text="未同步" tone="warning" /> : p.auth === 'oauth' ? <Pill text="账户授权" tone="brand" /> : null}
              onPress={() => router.push(`/provider/${p.record.id}`)}
            />
          ))}
        </Card>
      )}

      <ModelPicker
        visible={!!slot}
        title={slot ? `「${SLOT_INFO[slot].label}」槽位` : ''}
        providers={w.providers}
        value={slot ? w.routes[slot] : null}
        followLabel={slot && slot !== 'default' ? '跟随默认槽位' : undefined}
        onClose={() => setSlot(null)}
        onSelect={(target) => slot && w.setRoute(slot, target)}
      />
    </Screen>
  )
}
