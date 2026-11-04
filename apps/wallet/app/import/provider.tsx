// `modelpass://import/provider?name=…&format=…&base_url=…&models=a,b[&api_key=…][&preset=…]`
// Pre-fills the provider form; nothing is saved until the user confirms (protocol §12).
import { Text } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { getPreset, hostOf } from '@modelpass/core'
import { Button, Card, Muted, Notice, Screen } from '../../src/components/ui'
import { useTheme } from '../../src/theme'

export default function ImportProvider() {
  const t = useTheme()
  const p = useLocalSearchParams<{ name?: string; format?: string; base_url?: string; models?: string; api_key?: string; preset?: string }>()
  const preset = p.preset && getPreset(p.preset) ? p.preset : p.format === 'anthropic-messages' ? 'custom-anthropic' : 'custom-openai'
  const valid = !!p.base_url && /^https?:\/\//.test(p.base_url)
  return (
    <Screen>
      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, color: t.muted, fontWeight: '700' }}>即将导入的厂商</Text>
        <Text style={{ fontSize: 20, fontWeight: '800', color: t.ink }}>{p.name ?? '未命名'}</Text>
        <Text style={{ fontSize: 14, color: t.muted }}>{valid ? hostOf(p.base_url!) : '缺少有效的 base_url'}</Text>
        <Text style={{ fontSize: 13, color: t.faint }}>{p.models ? `模型：${p.models}` : '未提供模型列表'}</Text>
      </Card>
      {p.api_key ? <Notice tone="warning">链接中包含 API Key。只导入你信任的来源，并考虑在使用后轮换该 Key。</Notice> : null}
      <Muted>导入只会预填表单，你可以检查、测试后再保存。</Muted>
      <Button
        title="检查并继续"
        disabled={!valid}
        onPress={() => router.replace({ pathname: '/provider/[id]', params: { id: 'create', preset, name: p.name ?? '', base_url: p.base_url ?? '', models: p.models ?? '', api_key: p.api_key ?? '' } })}
      />
    </Screen>
  )
}
