// Experimental: connect a ChatGPT Plus / Pro / Go plan through OpenAI's official
// "Sign in with ChatGPT" plan-usage flow (open-source dynamic client registration).

import { useState } from 'react'
import { Alert, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { router } from 'expo-router'
import { getPreset } from '@modelpass/core'
import { ProviderAvatar } from '../../src/components/ModelPicker'
import { Button, Card, Field, Label, Muted, Notice, Screen } from '../../src/components/ui'
import { CHATGPT, chatGptAuthorize, chatGptExchange, testProvider } from '../../src/lib/providers'
import { loadChatGptClient, saveChatGptClient } from '../../src/storage'
import { useTheme } from '../../src/theme'
import { useWallet } from '../../src/wallet'

export default function ConnectChatGpt() {
  const t = useTheme()
  const w = useWallet()
  const [pending, setPending] = useState<{ verifier: string; state: string; clientId?: string; hostId: string } | null>(null)
  const [callback, setCallback] = useState('')
  const [busy, setBusy] = useState(false)

  const start = async () => {
    const reg = await loadChatGptClient()
    const { url, verifier, state } = chatGptAuthorize(reg)
    setPending({ verifier, state, clientId: reg.clientId, hostId: reg.hostId })
    await WebBrowser.openBrowserAsync(url)
  }

  const finish = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const tokens = await chatGptExchange(callback.trim(), pending)
      await saveChatGptClient({ clientId: tokens.clientId, hostId: pending.hostId })
      const preset = getPreset('chatgpt')!
      const listed = await testProvider('openai-responses', CHATGPT.resource, tokens.accessToken)
      await w.saveProvider({
        presetId: 'chatgpt',
        name: 'ChatGPT 订阅',
        format: 'openai-responses',
        models: listed.ok && listed.models.length ? listed.models : preset.models,
        secret: {
          baseUrl: CHATGPT.resource,
          oauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            clientId: tokens.clientId,
            tokenUrl: CHATGPT.token,
            resource: CHATGPT.resource,
            accountLabel: 'ChatGPT 套餐额度',
          },
        },
        auth: 'oauth',
        accountLabel: 'ChatGPT 套餐额度',
      })
      router.back()
    } catch (e) {
      Alert.alert('连接失败', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <ProviderAvatar presetId="chatgpt" size={48} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: t.ink }}>使用 ChatGPT 套餐额度</Text>
          <Text style={{ fontSize: 13, color: t.muted }}>OpenAI 官方 Sign in with ChatGPT · 实验功能</Text>
        </View>
      </View>
      <Notice tone="warning">
        这是实验功能：OpenAI 目前只向开源项目、本地运行的个人项目与选定合作方开放套餐额度。通过自托管 Hub 供自己使用较为稳妥；把额度转给第三方商业应用可能不符合 OpenAI 条款。
      </Notice>
      <Card style={{ gap: 10 }}>
        <Label>第 1 步 · 登录并授权</Label>
        <Muted>首次连接会自动注册 ModelPass 客户端（client_id=dynamic_agent_client），请在授权页勾选「使用 ChatGPT 套餐」。需要 Plus、Pro 或 Go 套餐。</Muted>
        <Button title={pending ? '重新打开登录页' : '在浏览器中登录 ChatGPT'} icon="log-in-outline" variant="dark" onPress={start} />
      </Card>
      <Card style={{ gap: 10, opacity: pending ? 1 : 0.5 }}>
        <Label>第 2 步 · 粘贴回调地址</Label>
        <Muted>授权完成后浏览器会跳转到 {CHATGPT.redirectUri}…（页面无法打开是正常的）。复制地址栏中的完整链接粘贴到这里。</Muted>
        <Field label="回调地址" value={callback} onChangeText={setCallback} placeholder="http://127.0.0.1:1455/auth/callback?code=…" editable={!!pending} multiline />
        <Button title="从剪贴板粘贴" variant="secondary" icon="clipboard-outline" disabled={!pending} onPress={async () => setCallback((await Clipboard.getStringAsync()).trim())} />
        <Button title="完成连接" icon="checkmark" disabled={!pending || !callback} loading={busy} onPress={finish} />
      </Card>
      <Muted>
        连接后，访问令牌与刷新令牌用 Vault Key 加密保存在 Hub；Hub 会在请求时用 Responses API（store:false、stream:true）调用，并在令牌过期时自动刷新、重新加密。每个应用的用量都计入你在 ChatGPT 设置中为 ModelPass 设定的每周上限。
      </Muted>
    </Screen>
  )
}
