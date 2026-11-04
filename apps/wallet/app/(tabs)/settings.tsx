import { Alert, Text, View } from 'react-native'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { hostOf, PROTOCOL_VERSION } from '@modelpass/core'
import { Card, IconBadge, LargeTitle, ListRow, Pill, Screen, SectionHeader, Segmented, ToggleRow } from '../../src/components/ui'
import { useTheme } from '../../src/theme'
import { BUDGET_OPTIONS } from '../../src/lib/options'
import { useWallet } from '../../src/wallet'

const REPO = 'https://github.com/yanboishere/modelpass'


export default function Settings() {
  const t = useTheme()
  const w = useWallet()
  return (
    <Screen padTop>
      <LargeTitle title="设置" />

      <SectionHeader title="HUB" />
      <Card padded={false}>
        <ListRow
          left={<IconBadge name="server-outline" />}
          title={w.identity ? hostOf(w.identity.hubUrl) : '未连接'}
          subtitle={w.identity?.hubUrl}
          right={<Pill text={w.hubOnline === false ? '离线' : w.hubOnline ? '在线' : '…'} tone={w.hubOnline === false ? 'danger' : w.hubOnline ? 'success' : 'neutral'} />}
          onPress={() => router.push('/setup')}
        />
        <ListRow left={<IconBadge name="person-circle-outline" />} title="钱包账户" subtitle={w.identity?.userId} chevron={false} last />
      </Card>

      <SectionHeader title="安全与隐私" />
      <Card padded={false}>
        <ToggleRow title="授权时使用生物识别确认" subtitle="批准应用访问前要求 Face ID / 指纹" value={w.settings.biometric} onValueChange={(v) => w.updateSettings({ biometric: v })} />
        <ToggleRow title="默认向应用展示模型名称" subtitle="关闭后应用只能看到槽位名（如 default）" value={w.settings.shareModelInfo} onValueChange={(v) => w.updateSettings({ shareModelInfo: v })} last />
      </Card>

      <SectionHeader title="新应用的默认每日额度（tokens）" />
      <Card>
        <Segmented options={BUDGET_OPTIONS} value={w.settings.defaultTokensPerDay} onChange={(v) => w.updateSettings({ defaultTokensPerDay: v })} />
      </Card>

      <SectionHeader title="关于" />
      <Card padded={false}>
        <ListRow left={<IconBadge name="document-text-outline" />} title="ModelPass Connect 协议" subtitle={`v${PROTOCOL_VERSION} · OAuth 2.0 + PKCE · 扫码授权`} onPress={() => WebBrowser.openBrowserAsync(`${REPO}/blob/main/docs/protocol.md`)} />
        <ListRow left={<IconBadge name="logo-github" />} title="开源仓库" subtitle={REPO.replace('https://', '')} onPress={() => WebBrowser.openBrowserAsync(REPO)} last />
      </Card>

      <SectionHeader title="危险操作" />
      <Card padded={false}>
        <ListRow
          danger
          title="重置钱包"
          subtitle="删除本机的 Vault Key 与所有厂商配置，已授权的应用将无法再使用"
          onPress={() =>
            Alert.alert('重置钱包？', 'Vault Key 删除后无法恢复，所有已连接的应用都需要重新授权。', [
              { text: '取消', style: 'cancel' },
              {
                text: '重置',
                style: 'destructive',
                onPress: async () => {
                  await w.resetWallet()
                  router.replace('/onboarding')
                },
              },
            ])
          }
          last
        />
      </Card>
      <View style={{ alignItems: 'center', marginTop: 8 }}>
        <Text style={{ fontSize: 12, color: t.faint }}>ModelPass Wallet 0.1.0 · Demo</Text>
      </View>
    </Screen>
  )
}
