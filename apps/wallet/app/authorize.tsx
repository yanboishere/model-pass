// Same-device consent screen: opened by `modelpass://authorize?…` (protocol §6).

import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { router, useLocalSearchParams } from 'expo-router'
import { buildRedirectUrl, hostOf, parseAuthorizationRequest, type ClientMetadata } from '@modelpass/core'
import { ClientHeader, grantOptionsFrom, LimitsCard, ModelRoutes, PermissionList, useConsentState } from '../src/components/Consent'
import { Button, Card, EmptyState, Muted, Notice, Screen } from '../src/components/ui'
import { confirmWithBiometrics } from '../src/lib/auth'
import { defaultHubUrl } from '../src/lib/hub'
import { useTheme } from '../src/theme'
import { useWallet } from '../src/wallet'

export default function Authorize() {
  const t = useTheme()
  const w = useWallet()
  const params = useLocalSearchParams()
  const key = JSON.stringify(params)
  const parsed = useMemo(() => parseAuthorizationRequest(params as Record<string, string>), [key])
  const [client, setClient] = useState<ClientMetadata | null>(null)
  const [state, setState] = useConsentState(parsed.ok ? parsed.value.budgetHint : undefined)
  const [phase, setPhase] = useState<'review' | 'working' | 'done' | 'denied'>('review')
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!parsed.ok || !w.identity) return
    fetch(`${w.identity.hubUrl}/v1/clients/${encodeURIComponent(parsed.value.clientId)}`)
      .then((r) => r.json())
      .then(setClient)
      .catch(() => setClient(null))
  }, [parsed, w.identity])

  if (!w.ready) return <ActivityIndicator style={{ marginTop: 60 }} color={t.brand} />

  if (!parsed.ok) {
    return (
      <Screen>
        <EmptyState icon="alert-circle-outline" title="无效的授权请求" body={parsed.description}>
          {parsed.redirectUri ? (
            <Button
              title="返回应用"
              variant="secondary"
              onPress={() => Linking.openURL(buildRedirectUrl(parsed.redirectUri!, { error: parsed.error, error_description: parsed.description, state: parsed.state }))}
            />
          ) : null}
        </EmptyState>
      </Screen>
    )
  }

  const req = parsed.value
  const name = client?.verified ? client.name : req.clientName ?? client?.name ?? req.clientId

  if (!w.identity) {
    return (
      <Screen>
        <EmptyState icon="wallet-outline" title="先创建你的 ModelPass 钱包" body={`「${name}」想要使用你的模型。创建钱包只需一秒，Vault Key 会保存在本机。`}>
          <Button
            title="创建钱包并继续"
            icon="sparkles"
            loading={creating}
            onPress={async () => {
              const hub = defaultHubUrl()
              if (!hub) return router.push('/onboarding')
              setCreating(true)
              await w.createWallet(hub).catch((e) => Alert.alert('创建失败', (e as Error).message))
              setCreating(false)
            }}
          />
        </EmptyState>
      </Screen>
    )
  }

  const allow = async () => {
    if (w.settings.biometric && !(await confirmWithBiometrics(`允许「${name}」使用你的模型`))) return
    setPhase('working')
    try {
      const url = await w.approveAuthorization(req, grantOptionsFrom(state, req.scope, req.slots, w.providers, name))
      setRedirectUrl(url)
      setPhase('done')
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      await Linking.openURL(url)
    } catch (e) {
      setPhase('review')
      Alert.alert('授权失败', (e as Error).message)
    }
  }

  const deny = async () => {
    setPhase('denied')
    await Linking.openURL(buildRedirectUrl(req.redirectUri, { error: 'access_denied', error_description: '用户拒绝了授权', state: req.state })).catch(() => undefined)
  }

  if (phase === 'done' || phase === 'denied') {
    return (
      <Screen>
        <EmptyState
          icon={phase === 'done' ? 'checkmark-circle' : 'close-circle'}
          title={phase === 'done' ? `已授权「${name}」` : '已拒绝'}
          body={phase === 'done' ? '正在返回应用…之后可以随时在「应用」中修改模型、额度或撤销授权。' : '应用没有获得任何访问权限。'}
        >
          {phase === 'done' && redirectUrl ? <Button title="返回应用" icon="arrow-undo" onPress={() => Linking.openURL(redirectUrl)} /> : null}
          <Button title="完成" variant="secondary" onPress={() => router.replace('/apps')} />
        </EmptyState>
      </Screen>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Screen>
        <ClientHeader client={client} name={name} clientId={req.clientId} detail={req.redirectUri} />
        <PermissionList scope={req.scope} />
        <ModelRoutes slots={req.slots} state={state} setState={setState} />
        <LimitsCard state={state} setState={setState} modelChoice={req.scope.includes('model_choice')} />
        {w.hubOnline === false ? <Notice tone="danger">Hub 当前无法连接，授权会失败。请检查网络或 Hub 地址。</Notice> : null}
        <Muted style={{ textAlign: 'center' }}>授权记录在 Hub「{hostOf(w.identity.hubUrl)}」，应用之后将通过它访问你的模型。</Muted>
      </Screen>
      <Card style={{ borderRadius: 0, borderWidth: 0, borderTopWidth: 0.5, paddingBottom: 30, gap: 10 }}>
        <Button title={`允许「${name}」`} size="lg" loading={phase === 'working'} disabled={!w.providers.length} onPress={allow} />
        <Button title="拒绝" variant="secondary" disabled={phase === 'working'} onPress={deny} />
        <Text style={{ textAlign: 'center', fontSize: 12, color: t.faint }}>回调地址：{req.redirectUri}</Text>
      </Card>
    </View>
  )
}
