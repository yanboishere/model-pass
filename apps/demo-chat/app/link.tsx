// Cross-device authorization: show a QR code that the ModelPass wallet on another device scans.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { LinkAuthorization, ModelPassError } from '@modelpass/sdk'
import { modelpass, rendezvousHub, WALLET_BASE } from '../src/modelpass'
import { QRCode } from '../src/QRCode'
import { useDemoTheme } from '../src/theme'

export default function LinkScreen() {
  const t = useDemoTheme()
  const insets = useSafeAreaInsets()
  const [link, setLink] = useState<LinkAuthorization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState(0)
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current: LinkAuthorization | null = null
    setError(null)
    setLink(null)
    modelpass
      .startLink(rendezvousHub())
      .then((l) => {
        current = l
        setLink(l)
        return l.waitForSession()
      })
      .then(() => router.replace('/'))
      .catch((e: ModelPassError) => {
        if (e.code === 'cancelled') return
        setError(e.code === 'access_denied' ? '对方在 ModelPass 中拒绝了授权。' : e.code === 'expired_token' ? '二维码已过期。' : e.message)
      })
    return () => current?.cancel()
  }, [attempt])

  useEffect(() => {
    if (!link) return
    const tick = () => setLeft(Math.max(0, link.expiresAt - Math.floor(Date.now() / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [link])

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + 12, paddingHorizontal: 24 }}>
      <Pressable onPress={() => router.back()} style={{ alignSelf: 'flex-end', padding: 6 }}>
        <Ionicons name="close" size={26} color={t.muted} />
      </Pressable>
      <View style={{ alignItems: 'center', gap: 14, marginTop: 8 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: t.ink }}>扫码授权</Text>
        <Text style={{ fontSize: 15, color: t.muted, textAlign: 'center', lineHeight: 22 }}>打开另一台设备上的 ModelPass，点击右上角「扫码」{'\n'}扫描下方二维码并确认。</Text>
        <View style={{ padding: 16, backgroundColor: '#fff', borderRadius: 24, marginTop: 6, minHeight: 252, minWidth: 252, alignItems: 'center', justifyContent: 'center' }}>
          {link ? <QRCode value={link.qrUrl} size={220} /> : error ? <Ionicons name="alert-circle" size={44} color={t.danger} /> : <ActivityIndicator color={t.accent} />}
        </View>
        {link && !error ? (
          <>
            <Text style={{ fontSize: 13, color: t.muted }}>确认码</Text>
            <Text style={{ fontSize: 30, fontWeight: '900', letterSpacing: 4, color: t.ink }}>{link.userCode}</Text>
            <Text style={{ fontSize: 13, color: t.muted }}>{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后过期 · 等待确认…` : '已过期'}</Text>
            <View style={{ flexDirection: 'row', gap: 18, marginTop: 6 }}>
              <Pressable
                onPress={async () => {
                  await Clipboard.setStringAsync(link.qrUrl)
                  setCopied(true)
                }}
              >
                <Text style={{ color: t.accent, fontWeight: '700' }}>{copied ? '已复制 ✓' : '复制授权链接'}</Text>
              </Pressable>
              <Pressable onPress={() => Linking.openURL(link.walletUrl(`${WALLET_BASE}link`)).catch(() => undefined)}>
                <Text style={{ color: t.mp, fontWeight: '700' }}>用本机 ModelPass 打开</Text>
              </Pressable>
            </View>
          </>
        ) : null}
        {error ? (
          <>
            <Text style={{ color: t.danger, fontSize: 15 }}>{error}</Text>
            <Pressable onPress={() => setAttempt((n) => n + 1)}>
              <Text style={{ color: t.accent, fontWeight: '700', fontSize: 16 }}>重新生成</Text>
            </Pressable>
          </>
        ) : null}
        <Text style={{ fontSize: 12, color: t.muted, textAlign: 'center', marginTop: 12, lineHeight: 18 }}>
          二维码中包含一次性密钥，授权结果经端到端加密传回本设备，{'\n'}中转的 Hub 无法读取或伪造。
        </Text>
      </View>
    </View>
  )
}
