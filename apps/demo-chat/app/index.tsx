import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import * as ImagePicker from 'expo-image-picker'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ModelPassError, type ChatMessage, type ModelPassSession, type TokenResponse } from '@modelpass/sdk'
import { ModelPassButton } from '../src/ModelPassButton'
import { modelpass, useModelPassSession, WALLET_BASE } from '../src/modelpass'
import { useDemoTheme } from '../src/theme'

export default function Index() {
  const t = useDemoTheme()
  const session = useModelPassSession()
  if (session === undefined) return <ActivityIndicator style={{ flex: 1, backgroundColor: t.bg }} color={t.accent} />
  return session ? <Chat session={session} /> : <Welcome />
}

// ---- welcome ------------------------------------------------------------------------------------

function Welcome() {
  const t = useDemoTheme()
  const insets = useSafeAreaInsets()
  const [busy, setBusy] = useState(false)

  const connect = async () => {
    setBusy(true)
    try {
      await modelpass.authorize()
    } catch (e) {
      const err = e as ModelPassError
      if (err.code === 'wallet_not_installed') {
        Alert.alert('没有找到 ModelPass', '请先安装 ModelPass 钱包，或在另一台设备上扫码授权。', [
          { text: '取消', style: 'cancel' },
          { text: '扫码授权', onPress: () => router.push('/link') },
        ])
      } else if (err.code !== 'cancelled') {
        Alert.alert('连接失败', err.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const points: [React.ComponentProps<typeof Ionicons>['name'], string, string][] = [
    ['key-outline', '不需要 API Key', '本应用不会向你索要任何 Key，也从来拿不到它。'],
    ['swap-horizontal-outline', '用你选择的模型', 'DeepSeek、Claude、GPT、Gemini、自建 Ollama……在 ModelPass 里决定。'],
    ['shield-checkmark-outline', '随时撤销', '额度、有效期、暂停与撤销都在你的钱包里。'],
  ]

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <LinearGradient colors={[t.accent, t.accent2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingTop: insets.top + 40, paddingBottom: 40, paddingHorizontal: 24, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="chatbubble-ellipses" size={34} color="#fff" />
        </View>
        <Text style={{ color: '#fff', fontSize: 34, fontWeight: '900', marginTop: 18, letterSpacing: -0.8 }}>Demo Chat</Text>
        <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 17, marginTop: 6, lineHeight: 24 }}>一个接入了 ModelPass 的第三方 AI 应用示例</Text>
      </LinearGradient>
      <View style={{ flex: 1, padding: 24, gap: 18 }}>
        {points.map(([icon, title, body]) => (
          <View key={title} style={{ flexDirection: 'row', gap: 14 }}>
            <Ionicons name={icon} size={24} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: t.ink }}>{title}</Text>
              <Text style={{ fontSize: 14, color: t.muted, marginTop: 3, lineHeight: 20 }}>{body}</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={{ padding: 24, paddingBottom: insets.bottom + 20, gap: 14 }}>
        <ModelPassButton onPress={connect} loading={busy} />
        <Pressable onPress={() => router.push('/link')} style={{ alignItems: 'center', padding: 6 }}>
          <Text style={{ color: t.muted, fontSize: 15, fontWeight: '600' }}>在另一台设备上扫码授权</Text>
        </Pressable>
      </View>
    </View>
  )
}

// ---- chat ---------------------------------------------------------------------------------------

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  image?: { uri: string; dataUrl: string }
  model?: string
  fallback?: boolean
  streaming?: boolean
  error?: { message: string; code: string; fixInWallet: boolean; reconnect: boolean }
}

const SUGGESTIONS = ['用一句话介绍你自己', '写一首关于春天的五言绝句', '解释一下什么是 OAuth PKCE']
const uid = () => Math.random().toString(36).slice(2)

function toChat(m: Msg): ChatMessage {
  if (m.role === 'user' && m.image) return { role: 'user', content: [{ type: 'text', text: m.text || '请描述这张图片' }, { type: 'image_url', image_url: { url: m.image.dataUrl } }] }
  return { role: m.role, content: m.text }
}

function Chat({ session }: { session: ModelPassSession }) {
  const t = useDemoTheme()
  const insets = useSafeAreaInsets()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [slot, setSlot] = useState(session.slots[0]?.id ?? 'default')
  const [image, setImage] = useState<Msg['image'] | null>(null)
  const [sending, setSending] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const list = useRef<FlatList<Msg>>(null)
  // The user can re-route slots in ModelPass at any time; refresh what we show from the hub.
  const [slots, setSlots] = useState<TokenResponse['slots']>(session.slots)
  const refreshSlots = useCallback(() => {
    modelpass
      .grantInfo()
      .then((g) => setSlots(g.slots))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    refreshSlots()
    const sub = AppState.addEventListener('change', (st) => st === 'active' && refreshSlots())
    return () => sub.remove()
  }, [refreshSlots])
  const manageUrl = `${WALLET_BASE}grants/${session.grant_id}`
  const issuerHost = session.issuer.replace(/^https?:\/\//, '')

  const patch = (id: string, p: Partial<Msg> | ((m: Msg) => Partial<Msg>)) =>
    setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)))

  const send = async (text = input) => {
    if ((!text.trim() && !image) || sending) return
    const user: Msg = { id: uid(), role: 'user', text: text.trim(), image: image ?? undefined }
    const ai: Msg = { id: uid(), role: 'assistant', text: '', streaming: true }
    const history = [...messages.filter((m) => !m.error && !m.streaming), user].map(toChat)
    setMessages((m) => [...m, user, ai])
    setInput('')
    setImage(null)
    setSending(true)
    abort.current = new AbortController()
    try {
      const stream = modelpass.chat.stream(
        { model: user.image ? 'vision' : slot, messages: history },
        { signal: abort.current.signal, onResponse: (meta) => patch(ai.id, { model: meta.model ?? meta.slot, fallback: meta.fallback }) },
      )
      for await (const chunk of stream) {
        if (chunk.error) throw new ModelPassError(chunk.error.code ?? 'upstream_error', chunk.error.message)
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) patch(ai.id, (m) => ({ text: m.text + delta }))
      }
    } catch (e) {
      const err = e instanceof ModelPassError ? e : new ModelPassError('network', (e as Error).message)
      if ((e as Error).name !== 'AbortError') patch(ai.id, { error: { message: err.message, code: String(err.code), fixInWallet: err.fixableInWallet, reconnect: err.needsReconnect } })
    } finally {
      patch(ai.id, { streaming: false })
      setSending(false)
      refreshSlots()
    }
  }

  const pickImage = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.4 })
    if (!r.canceled && r.assets[0]?.base64) {
      const a = r.assets[0]
      setImage({ uri: a.uri, dataUrl: `data:${a.mimeType ?? 'image/jpeg'};base64,${a.base64}` })
    }
  }

  const menu = () => {
    const actions = [
      { label: '在 ModelPass 中管理', run: () => Linking.openURL(manageUrl).catch(() => Alert.alert('无法打开 ModelPass')) },
      {
        label: '查看本应用的授权',
        run: async () => {
          try {
            const g = await modelpass.grantInfo()
            const slots = g.slots.map((s) => `${s.label}：${s.model ?? '（未公开）'}`).join('\n')
            const budget = g.budget.tokens_per_day ? `${g.budget.tokens_used_today} / ${g.budget.tokens_per_day}` : `${g.budget.tokens_used_today}（不限）`
            Alert.alert('ModelPass 授权', `${slots}\n\n今日 tokens：${budget}\n今日请求：${g.budget.requests_today}\n权限：${g.scope}`)
          } catch (e) {
            Alert.alert('读取失败', (e as Error).message)
          }
        },
      },
      { label: '断开连接', run: () => modelpass.signOut() },
    ]
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: [...actions.map((a) => a.label), '取消'], cancelButtonIndex: actions.length, destructiveButtonIndex: 2 }, (i) => actions[i]?.run())
    } else {
      Alert.alert('ModelPass', undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run })), { text: '取消', style: 'cancel' as const }])
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 10, backgroundColor: t.card, borderBottomWidth: 0.5, borderBottomColor: t.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <LinearGradient colors={[t.accent, t.accent2]} style={{ width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chatbubble-ellipses" size={19} color="#fff" />
          </LinearGradient>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: t.ink }}>Demo Chat</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.accent }} />
              <Text numberOfLines={1} style={{ fontSize: 12, color: t.muted, flexShrink: 1 }}>ModelPass · {issuerHost}</Text>
            </View>
          </View>
          <Pressable onPress={() => !sending && setMessages([])} hitSlop={10} style={{ padding: 4 }} accessibilityLabel="新对话">
            <Ionicons name="create-outline" size={25} color={t.muted} />
          </Pressable>
          <Pressable onPress={menu} hitSlop={10} style={{ padding: 4 }} accessibilityLabel="ModelPass 菜单">
            <Ionicons name="ellipsis-horizontal-circle" size={28} color={t.mp} />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {slots
            .filter((s) => s.id !== 'vision')
            .map((s) => {
              const active = s.id === slot
              return (
                <Pressable key={s.id} onPress={() => setSlot(s.id)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: active ? t.accent : t.bg, borderWidth: 1, borderColor: active ? t.accent : t.line }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : t.muted }}>
                    {s.label}
                    {s.model ? ` · ${s.model}` : ''}
                  </Text>
                </Pressable>
              )
            })}
        </View>
      </View>

      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 40 }}>
            <Text style={{ fontSize: 15, color: t.muted, textAlign: 'center', lineHeight: 22 }}>
              这个应用里没有任何 API Key。{'\n'}模型由你在 ModelPass 中选择，切换后立即生效。
            </Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: t.card, borderWidth: 0.5, borderColor: t.line }}>
                <Text style={{ color: t.ink, fontSize: 14 }}>{s}</Text>
              </Pressable>
            ))}
          </View>
        }
        renderItem={({ item: m }) => (
          <View style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 4 }}>
            {m.image ? <Image source={{ uri: m.image.uri }} style={{ width: 160, height: 160, borderRadius: 14 }} /> : null}
            {m.text || m.role === 'assistant' ? (
              <View
                style={{
                  maxWidth: '86%',
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 18,
                  backgroundColor: m.role === 'user' ? t.accent : t.bubble,
                  borderBottomRightRadius: m.role === 'user' ? 6 : 18,
                  borderBottomLeftRadius: m.role === 'user' ? 18 : 6,
                  borderWidth: m.role === 'user' ? 0 : 0.5,
                  borderColor: t.line,
                }}
              >
                {m.error ? (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: t.danger, fontSize: 15, lineHeight: 21 }}>⚠️ {m.error.message}</Text>
                    {m.error.fixInWallet ? (
                      <Pressable onPress={() => Linking.openURL(manageUrl)}>
                        <Text style={{ color: t.mp, fontWeight: '700' }}>在 ModelPass 中处理 →</Text>
                      </Pressable>
                    ) : m.error.reconnect ? (
                      <Pressable onPress={() => modelpass.signOut({ revoke: false })}>
                        <Text style={{ color: t.mp, fontWeight: '700' }}>重新连接 →</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : (
                  <Text style={{ color: m.role === 'user' ? '#fff' : t.ink, fontSize: 15.5, lineHeight: 22 }}>{m.text || (m.streaming ? '…' : '')}</Text>
                )}
              </View>
            ) : null}
            {m.role === 'assistant' && m.model && !m.error ? (
              <Text style={{ fontSize: 11.5, color: t.muted, marginLeft: 6 }}>
                {m.model}
                {m.fallback ? '（已回落到默认）' : ''} · via ModelPass
              </Text>
            ) : null}
          </View>
        )}
      />

      <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: insets.bottom + 8, backgroundColor: t.card, borderTopWidth: 0.5, borderTopColor: t.line, gap: 8 }}>
        {image ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Image source={{ uri: image.uri }} style={{ width: 44, height: 44, borderRadius: 8 }} />
            <Text style={{ flex: 1, color: t.muted, fontSize: 13 }}>将使用「视觉」槽位发送</Text>
            <Pressable onPress={() => setImage(null)}>
              <Ionicons name="close-circle" size={22} color={t.muted} />
            </Pressable>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Pressable onPress={pickImage} style={{ padding: 8 }}>
            <Ionicons name="image-outline" size={24} color={t.muted} />
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="发消息…"
            placeholderTextColor={t.muted}
            multiline
            style={{ flex: 1, maxHeight: 120, minHeight: 40, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderRadius: 20, backgroundColor: t.bg, color: t.ink, fontSize: 15.5 }}
          />
          <Pressable
            onPress={() => (sending ? abort.current?.abort() : send())}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: sending || input.trim() || image ? t.accent : t.line, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name={sending ? 'stop' : 'arrow-up'} size={20} color="#fff" />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}
