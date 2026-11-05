import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Field, Notice, type IconName } from '../src/components/ui'
import { defaultHubUrl, pingHub } from '../src/lib/hub'
import { useTheme } from '../src/theme'
import { useWallet } from '../src/wallet'

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: 'key-outline', title: '应用里不再填 Key', body: '第三方应用通过「使用 ModelPass 继续」获得访问权，永远拿不到你的 Key。' },
  { icon: 'swap-horizontal-outline', title: '一键切换模型', body: '在这里切换厂商与模型，所有已连接的应用即时生效。' },
  { icon: 'shield-checkmark-outline', title: '逐个应用授权', body: '每个应用独立的权限、每日额度与有效期，随时暂停或撤销。' },
]

export default function Onboarding() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { createWallet, identity } = useWallet()
  const [hubUrl, setHubUrl] = useState(defaultHubUrl())
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const created = useRef(false)

  useEffect(() => {
    if (identity && !created.current) router.replace('/')
  }, [identity])

  useEffect(() => {
    if (!hubUrl.trim()) return setStatus(null)
    const timer = setTimeout(() => pingHub(hubUrl.trim()).then(setStatus), 400)
    return () => clearTimeout(timer)
  }, [hubUrl])

  const create = async () => {
    setBusy(true)
    try {
      created.current = true
      await createWallet(hubUrl.trim().replace(/\/+$/, ''))
      // Opened from a consent screen (e.g. an app asked for access before the wallet existed)? Go back to it.
      if (router.canGoBack()) router.back()
      else router.replace('/')
    } catch (e) {
      created.current = false
      setStatus({ ok: false, message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <LinearGradient colors={[t.brand, t.brand2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingTop: insets.top + 36, paddingBottom: 34, paddingHorizontal: 24, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
          <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 32, fontWeight: '900' }}>M</Text>
          </View>
          <Text style={{ color: '#fff', fontSize: 34, fontWeight: '900', marginTop: 18, letterSpacing: -0.8 }}>ModelPass</Text>
          <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 17, marginTop: 6, lineHeight: 24 }}>用你自己的模型，登录任何应用。{'\n'}移动端的模型通行证 & 一键切换器。</Text>
        </LinearGradient>
        <View style={{ padding: 20, gap: 16 }}>
          {FEATURES.map((f) => (
            <View key={f.title} style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
              <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={f.icon} size={21} color={t.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: t.ink }}>{f.title}</Text>
                <Text style={{ fontSize: 14, color: t.muted, marginTop: 3, lineHeight: 20 }}>{f.body}</Text>
              </View>
            </View>
          ))}
          <View style={{ height: 6 }} />
          <Field
            label="Hub 地址"
            value={hubUrl}
            onChangeText={setHubUrl}
            keyboardType="url"
            placeholder="http://电脑的局域网 IP:8787"
            hint={
              hubUrl.trim()
                ? 'Hub 负责签发授权并转发模型请求，可以使用官方 Hub 或自行部署（npm run hub）。'
                : '在电脑上运行 npm run hub，填写它打印的局域网地址（手机与电脑需在同一 Wi-Fi）。'
            }
            right={status ? <Ionicons name={status.ok ? 'checkmark-circle' : 'close-circle'} size={20} color={status.ok ? t.success : t.danger} /> : null}
          />
          {status && !status.ok ? <Notice tone="danger">{status.message}</Notice> : null}
          <Button title="创建我的钱包" size="lg" icon="sparkles" loading={busy} disabled={!hubUrl.trim()} onPress={create} />
          <Text style={{ fontSize: 12.5, color: t.faint, textAlign: 'center', lineHeight: 18 }}>
            Vault Key 将在本机生成，仅保存在{Platform.OS === 'ios' ? '系统钥匙串中（不随 iCloud 同步）' : ' Android Keystore 保护的加密存储中'}。{'\n'}Hub 上只保存经它加密的密文。
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
