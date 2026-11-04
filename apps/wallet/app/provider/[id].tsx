import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { Ionicons } from '@expo/vector-icons'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { getPreset, getUrlParams, resolvePresetBaseUrl, type ProviderSecret } from '@modelpass/core'
import { ProviderAvatar } from '../../src/components/ModelPicker'
import { Button, Card, Field, Label, Muted, Notice, Screen } from '../../src/components/ui'
import { openRouterAuthUrl, openRouterExchange, testProvider, type TestResult } from '../../src/lib/providers'
import { useTheme } from '../../src/theme'
import { useWallet } from '../../src/wallet'

export default function ProviderForm() {
  const t = useTheme()
  const w = useWallet()
  const params = useLocalSearchParams<{ id: string; preset?: string; name?: string; base_url?: string; models?: string; api_key?: string }>()
  const existing = w.providers.find((p) => p.record.id === params.id)
  const presetId = existing?.record.presetId ?? params.preset ?? 'custom-openai'
  const preset = getPreset(presetId)
  const initialSecret = useMemo<ProviderSecret | null>(() => (existing ? w.revealSecret(existing.record.id) : null), [existing?.record.id])
  const hubUrl = w.identity?.hubUrl ?? ''

  const [name, setName] = useState(existing?.record.name ?? params.name ?? preset?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initialSecret?.baseUrl ?? params.base_url ?? (preset ? resolvePresetBaseUrl(preset, hubUrl) : ''))
  const [apiKey, setApiKey] = useState(initialSecret?.apiKey ?? params.api_key ?? '')
  const [models, setModels] = useState<string[]>(existing?.record.models ?? (params.models ? params.models.split(',').map((m) => m.trim()).filter(Boolean) : preset?.models ?? []))
  const [newModel, setNewModel] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [manualCode, setManualCode] = useState<{ verifier: string } | null>(null)
  const [code, setCode] = useState('')
  const oauthProvider = existing?.auth === 'oauth'
  const editableUrl = !!preset?.baseUrlEditable || !preset || preset.category === 'custom' || preset.category === 'local'
  const needsKey = preset?.auth === 'api-key'

  useEffect(() => {
    if (!existing && params.api_key) {
      Alert.alert('来自链接的 Key', '导入链接中包含 API Key。请确认来源可信，链接可能已被浏览器或聊天记录保存。')
    }
  }, [])

  const runTest = async (key = apiKey) => {
    setTesting(true)
    const r = await testProvider(preset?.format ?? 'openai-chat', baseUrl.trim(), key.trim() || undefined, initialSecret?.headers)
    setResult(r)
    if (r.ok && r.models.length) setModels((cur) => Array.from(new Set([...cur.filter((m) => r.models.includes(m) || !preset?.models.includes(m)), ...r.models])))
    setTesting(false)
    return r
  }

  const save = async () => {
    if (!baseUrl.trim()) return Alert.alert('请填写 Base URL')
    if (needsKey && !apiKey.trim() && !oauthProvider) return Alert.alert('请填写 API Key')
    if (!models.length) return Alert.alert('还没有可用模型', '点击「测试并获取模型」，或手动添加一个模型 ID。')
    setSaving(true)
    try {
      const secret: ProviderSecret = oauthProvider && initialSecret ? { ...initialSecret, baseUrl: baseUrl.trim() } : { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, headers: initialSecret?.headers }
      await w.saveProvider({
        id: existing?.record.id,
        presetId,
        name,
        format: preset?.format ?? existing?.record.format ?? 'openai-chat',
        models,
        secret,
        auth: oauthProvider ? 'oauth' : apiKey.trim() ? 'api-key' : 'none',
        accountLabel: existing?.accountLabel,
        options: existing?.record.options,
      })
      router.back()
    } catch (e) {
      Alert.alert('保存失败', (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const connectOpenRouter = async () => {
    const callback = Linking.createURL('oauth/openrouter')
    const { url, verifier } = openRouterAuthUrl(callback)
    const res = await WebBrowser.openAuthSessionAsync(url, callback)
    if (res.type !== 'success') return
    const c = getUrlParams(res.url).code
    if (!c) return Alert.alert('授权未完成', '没有收到授权码，可以改用「手动输入授权码」。')
    await finishOpenRouter(c, verifier)
  }

  const finishOpenRouter = async (c: string, verifier: string) => {
    try {
      const key = await openRouterExchange(c.trim(), verifier)
      setApiKey(key)
      setManualCode(null)
      await runTest(key)
    } catch (e) {
      Alert.alert('OpenRouter 授权失败', (e as Error).message)
    }
  }

  const visibleModels = showAll ? models : models.slice(0, 24)

  return (
    <Screen>
      <Stack.Screen options={{ title: existing ? existing.record.name : `添加 ${preset?.name ?? '厂商'}` }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ProviderAvatar presetId={presetId} size={48} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: t.ink }}>{preset?.name ?? '自定义厂商'}</Text>
          <Text style={{ fontSize: 13, color: t.muted }}>{preset?.format === 'anthropic-messages' ? 'Anthropic Messages 协议' : preset?.format === 'openai-responses' ? 'OpenAI Responses 协议' : 'OpenAI 兼容协议'}</Text>
        </View>
      </View>
      {preset?.note ? <Notice tone="brand" icon="information-circle">{preset.note}</Notice> : null}

      {preset?.auth === 'oauth-openrouter' && !existing ? (
        <Card style={{ gap: 10 }}>
          <Label>推荐：使用 OpenRouter 账户授权</Label>
          <Muted>登录 OpenRouter 后会自动生成一个由你控制、可随时删除的 Key，无需手动复制。</Muted>
          <Button title="使用 OpenRouter 账户授权" icon="log-in-outline" variant="dark" onPress={connectOpenRouter} />
          {manualCode ? (
            <>
              <Field label="授权码" value={code} onChangeText={setCode} placeholder="粘贴 OpenRouter 页面上显示的授权码" />
              <Button title="完成授权" variant="secondary" onPress={() => finishOpenRouter(code, manualCode.verifier)} />
            </>
          ) : (
            <Pressable
              onPress={() => {
                const { url, verifier } = openRouterAuthUrl(null)
                setManualCode({ verifier })
                WebBrowser.openBrowserAsync(url)
              }}
            >
              <Text style={{ color: t.brand, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>无法自动跳转？手动输入授权码</Text>
            </Pressable>
          )}
        </Card>
      ) : null}

      <Card style={{ gap: 14 }}>
        <Field label="名称" value={name} onChangeText={setName} placeholder={preset?.name} />
        <Field
          label="Base URL"
          value={baseUrl}
          onChangeText={setBaseUrl}
          editable={editableUrl}
          keyboardType="url"
          placeholder="https://api.example.com/v1"
          hint={editableUrl ? '请求由 Hub 转发：自建服务的地址需要能被 Hub 访问。' : undefined}
          style={editableUrl ? undefined : { color: t.muted }}
        />
        {oauthProvider ? (
          <Notice tone="success" icon="person-circle">已通过账户授权连接：{existing?.accountLabel ?? 'OAuth'}。令牌由 Hub 自动刷新并重新加密。</Notice>
        ) : (
          <Field
            label={needsKey ? 'API Key' : 'API Key（可选）'}
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            placeholder={preset?.keyPlaceholder ?? 'sk-...'}
            hint="只在本机明文出现；保存时用 Vault Key 加密。"
            right={
              <Pressable onPress={async () => setApiKey((await Clipboard.getStringAsync()).trim())} hitSlop={8}>
                <Ionicons name="clipboard-outline" size={20} color={t.brand} />
              </Pressable>
            }
          />
        )}
        {preset?.keyUrl && !oauthProvider ? (
          <Pressable onPress={() => WebBrowser.openBrowserAsync(preset.keyUrl!)}>
            <Text style={{ color: t.brand, fontSize: 13, fontWeight: '600' }}>没有 Key？前往 {preset.name} 控制台获取 →</Text>
          </Pressable>
        ) : null}
        <Button title="测试并获取模型" icon="pulse-outline" variant="secondary" loading={testing} onPress={() => runTest()} />
        {result ? <Notice tone={result.ok ? 'success' : 'danger'} icon={result.ok ? 'checkmark-circle' : 'close-circle'}>{result.message}</Notice> : null}
        <Muted>测试从手机直接发起；实际使用时请求由 Hub 转发。</Muted>
      </Card>

      <Card style={{ gap: 12 }}>
        <Label>可用模型（{models.length}）</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {visibleModels.map((m) => (
            <Pressable key={m} onLongPress={() => setModels((cur) => cur.filter((x) => x !== m))} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.input, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ fontSize: 13, color: t.text }}>{m}</Text>
              <Pressable onPress={() => setModels((cur) => cur.filter((x) => x !== m))} hitSlop={8}>
                <Ionicons name="close" size={14} color={t.faint} />
              </Pressable>
            </Pressable>
          ))}
        </View>
        {models.length > 24 ? (
          <Pressable onPress={() => setShowAll((v) => !v)}>
            <Text style={{ color: t.brand, fontWeight: '600', fontSize: 13 }}>{showAll ? '收起' : `显示全部 ${models.length} 个`}</Text>
          </Pressable>
        ) : null}
        <Field
          label="手动添加模型 ID"
          value={newModel}
          onChangeText={setNewModel}
          placeholder="例如 deepseek-flash"
          onSubmitEditing={() => {
            if (newModel.trim()) setModels((cur) => Array.from(new Set([...cur, newModel.trim()])))
            setNewModel('')
          }}
          returnKeyType="done"
        />
      </Card>

      <Button title={existing ? '保存修改' : '保存并加密上传'} size="lg" icon="lock-closed" loading={saving} onPress={save} />
      {existing ? (
        <Button
          title="删除厂商"
          variant="danger"
          onPress={() =>
            Alert.alert('删除该厂商？', '使用它的槽位与应用将回落到其他配置。', [
              { text: '取消', style: 'cancel' },
              {
                text: '删除',
                style: 'destructive',
                onPress: async () => {
                  await w.removeProvider(existing.record.id)
                  router.back()
                },
              },
            ])
          }
        />
      ) : null}
    </Screen>
  )
}
