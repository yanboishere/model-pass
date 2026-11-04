// Building blocks shared by the same-device (authorize) and cross-device (link) consent screens.

import { useState } from 'react'
import { Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import {
  SCOPE_INFO,
  SLOT_INFO,
  slotTarget,
  type ClientMetadata,
  type GrantOptions,
  type RouteMap,
  type Scope,
  type SlotId,
} from '@modelpass/core'
import { useAddDemoProviders } from '../lib/demo'
import { BUDGET_OPTIONS, EXPIRY_OPTIONS, expiresAtFromDays } from '../lib/options'
import type { LocalProvider } from '../storage'
import { useTheme } from '../theme'
import { describeTarget, useWallet } from '../wallet'
import { ModelPicker } from './ModelPicker'
import { Avatar, Button, Card, Label, ListRow, Notice, Pill, Segmented, ToggleRow, type IconName } from './ui'

const SCOPE_ICONS: Record<Scope, IconName> = { chat: 'chatbubbles-outline', vision: 'image-outline', tools: 'construct-outline', model_choice: 'options-outline' }

export interface ConsentState {
  overrides: RouteMap
  tokensPerDay: number | null
  expiryDays: number | null
  share: boolean
  allowModelChoice: boolean
}

export function useConsentState(budgetHint?: number) {
  const { settings } = useWallet()
  return useState<ConsentState>({
    overrides: {},
    tokensPerDay: budgetHint ?? settings.defaultTokensPerDay,
    expiryDays: null,
    share: settings.shareModelInfo,
    allowModelChoice: false,
  })
}

export function grantOptionsFrom(state: ConsentState, scope: Scope[], slots: SlotId[], providers: LocalProvider[], clientName: string): GrantOptions {
  return {
    scope,
    slots,
    routes: state.overrides,
    budget: { tokensPerDay: state.tokensPerDay, requestsPerDay: null },
    expiresAt: expiresAtFromDays(state.expiryDays),
    shareModelInfo: state.share,
    allowedModels: state.allowModelChoice ? providers.flatMap((p) => p.record.models.map((m) => `${p.record.id}:${m}`)) : [],
    clientName,
  }
}

export function ClientHeader({ client, name, clientId, detail }: { client: ClientMetadata | null; name: string; clientId: string; detail?: string }) {
  const t = useTheme()
  const verified = client?.verified
  const icon = client?.icon && client.icon.length <= 2 ? client.icon : undefined
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingTop: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar emoji={icon} label={name.slice(0, 1).toUpperCase()} size={64} />
        <Ionicons name="swap-horizontal" size={22} color={t.faint} />
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900' }}>M</Text>
        </View>
      </View>
      <Text style={{ fontSize: 22, fontWeight: '800', color: t.ink, textAlign: 'center', marginTop: 4 }}>{name}</Text>
      <Text style={{ fontSize: 15, color: t.muted }}>想要使用你在 ModelPass 中的 AI 模型</Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        {verified ? <Pill text="已验证应用" tone="brand" icon="shield-checkmark" /> : <Pill text="未验证应用" tone="warning" icon="warning" />}
        <Text style={{ fontSize: 12, color: t.faint }}>{clientId}</Text>
      </View>
      {!verified ? (
        <Notice tone="warning">该应用未在 Hub 登记，无法核实开发者身份。{detail ? `回调地址：${detail}。` : ''}只在你信任它时继续。</Notice>
      ) : null}
    </View>
  )
}

export function PermissionList({ scope }: { scope: Scope[] }) {
  const t = useTheme()
  return (
    <Card padded={false}>
      <View style={{ padding: 16, paddingBottom: 4 }}>
        <Label>它将能够</Label>
      </View>
      {scope.map((s, i) => (
        <View key={s} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', borderBottomWidth: i === scope.length - 1 ? 0 : 0.5, borderBottomColor: t.line }}>
          <Ionicons name={SCOPE_ICONS[s]} size={20} color={t.brand} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: t.ink }}>{SCOPE_INFO[s].label}</Text>
            <Text style={{ fontSize: 13, color: t.muted, marginTop: 1 }}>{SCOPE_INFO[s].description}</Text>
          </View>
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', backgroundColor: t.input }}>
        <Ionicons name="lock-closed" size={18} color={t.success} />
        <Text style={{ flex: 1, fontSize: 13, color: t.muted }}>它不会看到你的 API Key，也无法查看你的其他应用或对话。</Text>
      </View>
    </Card>
  )
}

export function ModelRoutes({ slots, state, setState }: { slots: SlotId[]; state: ConsentState; setState: (s: ConsentState) => void }) {
  const t = useTheme()
  const w = useWallet()
  const addDemo = useAddDemoProviders()
  const [picker, setPicker] = useState<SlotId | null>(null)
  const [busy, setBusy] = useState(false)
  const ctx = { grantRoutes: state.overrides, globalRoutes: w.routes, providers: w.providers.map((p) => ({ id: p.record.id })) }

  if (!w.providers.length) {
    return (
      <Card style={{ gap: 12 }}>
        <Label>将使用的模型</Label>
        <Notice tone="brand" icon="information-circle">你还没有配置任何模型。先添加一个厂商（或使用演示模型），再回到这里完成授权。</Notice>
        <Button
          title="使用演示模型"
          icon="flask-outline"
          loading={busy}
          onPress={async () => {
            setBusy(true)
            await addDemo().finally(() => setBusy(false))
          }}
        />
        <Button title="添加厂商" variant="secondary" icon="add" onPress={() => router.push('/provider/new')} />
      </Card>
    )
  }
  return (
    <Card padded={false}>
      <View style={{ padding: 16, paddingBottom: 4 }}>
        <Label>将使用的模型（可为该应用单独指定）</Label>
      </View>
      {slots.map((slot, i) => {
        const d = describeTarget(w.providers, slotTarget(slot, ctx))
        const custom = !!state.overrides[slot]
        return (
          <ListRow
            key={slot}
            last={i === slots.length - 1}
            title={`${SLOT_INFO[slot].label} · ${slot}`}
            subtitle={`${d.model}${d.provider ? ` · ${d.provider}` : ''}${custom ? '' : '（跟随全局）'}`}
            right={custom ? <Pill text="单独指定" tone="brand" /> : null}
            onPress={() => setPicker(slot)}
          />
        )
      })}
      <ModelPicker
        visible={!!picker}
        title={picker ? `为该应用选择「${SLOT_INFO[picker].label}」模型` : ''}
        providers={w.providers}
        value={picker ? state.overrides[picker] : null}
        followLabel="跟随全局设置（推荐）"
        onClose={() => setPicker(null)}
        onSelect={(target) => {
          if (!picker) return
          const overrides = { ...state.overrides }
          if (target) overrides[picker] = target
          else delete overrides[picker]
          setState({ ...state, overrides })
        }}
      />
    </Card>
  )
}

export function LimitsCard({ state, setState, modelChoice }: { state: ConsentState; setState: (s: ConsentState) => void; modelChoice: boolean }) {
  return (
    <Card padded={false}>
      <View style={{ padding: 16, gap: 14 }}>
        <View>
          <Label>每日 token 额度</Label>
          <Segmented options={BUDGET_OPTIONS} value={state.tokensPerDay} onChange={(v) => setState({ ...state, tokensPerDay: v })} />
        </View>
        <View>
          <Label>有效期</Label>
          <Segmented options={EXPIRY_OPTIONS} value={state.expiryDays} onChange={(v) => setState({ ...state, expiryDays: v })} />
        </View>
      </View>
      <ToggleRow title="向应用展示模型名称" subtitle="关闭后应用只知道槽位名" value={state.share} onValueChange={(v) => setState({ ...state, share: v })} last={!modelChoice} />
      {modelChoice ? (
        <ToggleRow title="允许应用自选模型" subtitle="应用可点名你已配置的任意模型" value={state.allowModelChoice} onValueChange={(v) => setState({ ...state, allowModelChoice: v })} last />
      ) : null}
    </Card>
  )
}
