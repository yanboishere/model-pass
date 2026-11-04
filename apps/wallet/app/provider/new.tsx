import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { PROVIDER_PRESETS, type PresetCategory, type ProviderPreset } from '@modelpass/core'
import { ProviderAvatar } from '../../src/components/ModelPicker'
import { Muted, Screen, SectionHeader } from '../../src/components/ui'
import { useTheme } from '../../src/theme'

const GROUPS: { category: PresetCategory; title: string }[] = [
  { category: 'demo', title: '体验' },
  { category: 'official', title: '官方 API（BYOK）' },
  { category: 'aggregator', title: '聚合平台' },
  { category: 'subscription', title: '订阅授权' },
  { category: 'local', title: '自建' },
  { category: 'custom', title: '自定义' },
]

function Tile({ p }: { p: ProviderPreset }) {
  const t = useTheme()
  const tag = p.auth === 'oauth-openrouter' ? '可账户授权' : p.auth === 'oauth-chatgpt' ? '实验' : p.region === 'cn' ? '国内' : undefined
  return (
    <Pressable
      onPress={() => router.push(p.auth === 'oauth-chatgpt' ? '/connect/chatgpt' : { pathname: '/provider/[id]', params: { id: 'create', preset: p.id } })}
      style={({ pressed }) => ({
        width: '48%',
        backgroundColor: pressed ? t.input : t.card,
        borderRadius: 16,
        borderWidth: 0.5,
        borderColor: t.line,
        padding: 14,
        gap: 10,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <ProviderAvatar presetId={p.id} size={38} />
        {tag ? <Text style={{ fontSize: 11, fontWeight: '700', color: t.brand, backgroundColor: t.brandSoft, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' }}>{tag}</Text> : null}
      </View>
      <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '700', color: t.ink, minHeight: 38 }}>
        {p.name}
      </Text>
    </Pressable>
  )
}

export default function NewProvider() {
  return (
    <Screen>
      <Muted>选择厂商后填写 API Key，或通过账户授权连接。Key 会用你的 Vault Key 加密后再上传到 Hub。</Muted>
      {GROUPS.map((g) => {
        const items = PROVIDER_PRESETS.filter((p) => p.category === g.category)
        if (!items.length) return null
        return (
          <View key={g.category} style={{ gap: 10 }}>
            <SectionHeader title={g.title} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
              {items.map((p) => (
                <Tile key={p.id} p={p} />
              ))}
            </View>
          </View>
        )
      })}
      <Muted style={{ marginTop: 6 }}>
        为什么没有 Claude Pro/Max 或 Gemini 订阅？Anthropic 明确禁止在第三方产品中使用订阅令牌，Google 也没有官方授权途径；国内各家 Coding Plan 仅限官方支持的编程工具。详见仓库 docs/subscriptions.md。
      </Muted>
    </Screen>
  )
}
