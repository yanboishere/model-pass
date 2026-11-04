import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { Avatar, Button, Card, EmptyState, LargeTitle, ListRow, Pill, Screen, SectionHeader } from '../../src/components/ui'
import { compact, expiryLabel, timeAgo } from '../../src/lib/format'
import { useTheme } from '../../src/theme'
import { useWallet } from '../../src/wallet'
import type { GrantSummary } from '@modelpass/core'

function GrantRow({ g, last }: { g: GrantSummary; last: boolean }) {
  const t = useTheme()
  const status =
    g.status === 'paused' ? <Pill text="已暂停" tone="warning" /> : g.status === 'pending' ? <Pill text="等待连接" tone="neutral" /> : g.status === 'revoked' ? <Pill text="已撤销" tone="danger" /> : null
  return (
    <ListRow
      last={last}
      left={<Avatar emoji={g.client.icon && g.client.icon.length <= 2 ? g.client.icon : undefined} label={g.clientName.slice(0, 1)} />}
      title={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: t.ink, flexShrink: 1 }}>{g.clientName}</Text>
          {g.client.verified ? <Pill text="已验证" tone="brand" icon="checkmark-circle" /> : null}
        </View>
      }
      subtitle={`${timeAgo(g.lastUsedAt)} · 今日 ${compact(g.usageToday.tokens)} tokens · ${expiryLabel(g.expiresAt)}`}
      right={status}
      onPress={g.status === 'revoked' ? undefined : () => router.push(`/grants/${g.id}`)}
    />
  )
}

export default function Apps() {
  const w = useWallet()
  const [showRevoked, setShowRevoked] = useState(false)
  useFocusEffect(
    useCallback(() => {
      w.refresh()
    }, [w.refresh]),
  )
  const live = w.grants.filter((g) => g.status !== 'revoked')
  const revoked = w.grants.filter((g) => g.status === 'revoked')
  return (
    <Screen padTop refreshing={w.syncing} onRefresh={w.refresh}>
      <LargeTitle title="应用" subtitle="已获得授权、可以使用你的模型的应用" />
      {live.length === 0 ? (
        <EmptyState icon="apps-outline" title="还没有已连接的应用" body="在应用中点击「使用 ModelPass 继续」，或用「扫码授权」扫描网页 / 电脑上显示的二维码。">
          <Button title="扫码授权" icon="scan" onPress={() => router.push('/scan')} />
        </EmptyState>
      ) : (
        <Card padded={false}>
          {live.map((g, i) => (
            <GrantRow key={g.id} g={g} last={i === live.length - 1} />
          ))}
        </Card>
      )}
      {revoked.length ? (
        <>
          <SectionHeader title={`已撤销（${revoked.length}）`} action={showRevoked ? '收起' : '展开'} onAction={() => setShowRevoked((v) => !v)} />
          {showRevoked ? (
            <Card padded={false}>
              {revoked.map((g, i) => (
                <GrantRow key={g.id} g={g} last={i === revoked.length - 1} />
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  )
}
