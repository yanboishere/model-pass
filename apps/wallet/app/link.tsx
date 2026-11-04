// Cross-device consent: opened from the in-app scanner or `modelpass://link?rv=…&uc=…&s=…` (protocol §7).

import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { router, useLocalSearchParams } from 'expo-router'
import { encodeQuery, hostOf, parseLinkUrl, parseScopeString, type LinkInfo } from '@modelpass/core'
import { ClientHeader, grantOptionsFrom, LimitsCard, ModelRoutes, PermissionList, useConsentState } from '../src/components/Consent'
import { Button, Card, EmptyState, Muted, Screen } from '../src/components/ui'
import { confirmWithBiometrics } from '../src/lib/auth'
import { useTheme } from '../src/theme'
import { useWallet } from '../src/wallet'

export default function Link() {
  const t = useTheme()
  const w = useWallet()
  const params = useLocalSearchParams<{ url?: string; rv?: string; uc?: string; s?: string }>()
  const link = useMemo(
    () => (params.url ? parseLinkUrl(params.url) : parseLinkUrl(`modelpass://link?${encodeQuery({ rv: params.rv, uc: params.uc, s: params.s })}`)),
    [params.url, params.rv, params.uc, params.s],
  )
  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useConsentState()
  const [phase, setPhase] = useState<'review' | 'working' | 'done' | 'denied'>('review')

  useEffect(() => {
    if (!link || !w.identity) return
    w.getLinkInfo(link)
      .then((i) => (i.status === 'pending' ? setInfo(i) : setError(i.status === 'expired' ? '二维码已过期，请在对方设备上刷新。' : '该请求已经处理过了。')))
      .catch((e) => setError((e as Error).message))
  }, [link, w.identity])

  if (!link) return <Screen><EmptyState icon="qr-code-outline" title="无法识别的授权链接" body="请重新扫描对方设备上显示的二维码。" /></Screen>
  if (error) {
    return (
      <Screen>
        <EmptyState icon="time-outline" title="无法继续" body={error}>
          <Button title="重新扫码" icon="scan" onPress={() => router.replace('/scan')} />
        </EmptyState>
      </Screen>
    )
  }
  if (!info || !w.identity) return <ActivityIndicator style={{ marginTop: 60 }} color={t.brand} />

  const scope = parseScopeString(info.scope)
  const name = info.client.verified ? info.client.name : info.client_name

  const allow = async () => {
    if (w.settings.biometric && !(await confirmWithBiometrics(`允许「${name}」使用你的模型`))) return
    setPhase('working')
    try {
      await w.approveLink(link, info, grantOptionsFrom(state, scope, info.slots, w.providers, name))
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      setPhase('done')
    } catch (e) {
      setPhase('review')
      Alert.alert('授权失败', (e as Error).message)
    }
  }

  if (phase === 'done' || phase === 'denied') {
    return (
      <Screen>
        <EmptyState
          icon={phase === 'done' ? 'checkmark-circle' : 'close-circle'}
          title={phase === 'done' ? '授权完成' : '已拒绝'}
          body={phase === 'done' ? `回到「${name}」所在的设备即可开始使用。令牌经端到端加密传递，汇合 Hub 无法读取。` : '对方设备不会获得任何访问权限。'}
        >
          <Button title="完成" onPress={() => router.replace('/apps')} />
        </EmptyState>
      </Screen>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Screen>
        <ClientHeader client={info.client} name={name} clientId={info.client_id} detail={`经由 ${hostOf(link.rendezvous)} 扫码请求`} />
        <Card style={{ alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 13, color: t.muted, fontWeight: '600' }}>请确认与对方屏幕上显示的确认码一致</Text>
          <Text style={{ fontSize: 34, fontWeight: '900', letterSpacing: 4, color: t.ink, fontVariant: ['tabular-nums'] }}>{info.user_code}</Text>
        </Card>
        <PermissionList scope={scope} />
        <ModelRoutes slots={info.slots} state={state} setState={setState} />
        <LimitsCard state={state} setState={setState} modelChoice={scope.includes('model_choice')} />
        <Muted style={{ textAlign: 'center' }}>授权记录在你的 Hub「{hostOf(w.identity.hubUrl)}」。</Muted>
      </Screen>
      <Card style={{ borderRadius: 0, borderWidth: 0, borderTopWidth: 0.5, paddingBottom: 30, gap: 10 }}>
        <Button title={`允许「${name}」`} size="lg" loading={phase === 'working'} disabled={!w.providers.length} onPress={allow} />
        <Button
          title="拒绝"
          variant="secondary"
          disabled={phase === 'working'}
          onPress={async () => {
            setPhase('denied')
            await w.denyLink(link).catch(() => undefined)
          }}
        />
      </Card>
    </View>
  )
}
