import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router, useLocalSearchParams } from 'expo-router'
import { Button, Field, Muted, Notice, Screen } from '../src/components/ui'
import { defaultHubUrl, pingHub } from '../src/lib/hub'
import { useTheme } from '../src/theme'
import { useWallet } from '../src/wallet'

export default function Setup() {
  const t = useTheme()
  const w = useWallet()
  const params = useLocalSearchParams<{ hub?: string }>()
  const [url, setUrl] = useState(params.hub ?? w.identity?.hubUrl ?? defaultHubUrl())
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => pingHub(url).then(setStatus), 300)
    return () => clearTimeout(timer)
  }, [url])

  const same = w.identity && url.replace(/\/+$/, '') === w.identity.hubUrl
  const save = async () => {
    const apply = async () => {
      setBusy(true)
      try {
        await w.switchHub(url.trim().replace(/\/+$/, ''))
        router.back()
      } catch (e) {
        Alert.alert('切换失败', (e as Error).message)
      } finally {
        setBusy(false)
      }
    }
    if (!w.identity) return apply()
    Alert.alert('切换到新的 Hub？', '厂商配置会用同一个 Vault Key 重新加密并上传；在旧 Hub 上授权过的应用需要重新连接。', [
      { text: '取消', style: 'cancel' },
      { text: '切换', onPress: apply },
    ])
  }

  return (
    <Screen>
      <Field
        label="Hub 地址"
        value={url}
        onChangeText={setUrl}
        keyboardType="url"
        right={status ? <Ionicons name={status.ok ? 'checkmark-circle' : 'close-circle'} size={20} color={status.ok ? t.success : t.danger} /> : null}
      />
      {status ? <Notice tone={status.ok ? 'success' : 'danger'} icon={status.ok ? 'checkmark-circle' : 'close-circle'}>{status.message}</Notice> : null}
      <Muted>
        Hub 是 ModelPass 的授权服务器与模型中继。它只保存用你手机上的 Vault Key 加密过的密文，但在转发请求的那一刻需要解密，因此请使用你信任的 Hub，或自行部署：在仓库中运行 npm run hub。
      </Muted>
      <Button title={same ? '已在使用该 Hub' : '使用这个 Hub'} disabled={!!same || !status?.ok} loading={busy} onPress={save} />
    </Screen>
  )
}
