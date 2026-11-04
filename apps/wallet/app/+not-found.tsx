import { router } from 'expo-router'
import { Button, EmptyState, Screen } from '../src/components/ui'

export default function NotFound() {
  return (
    <Screen padTop>
      <EmptyState icon="help-circle-outline" title="无法识别的链接" body="这个 ModelPass 链接已失效，或来自更新版本的协议。">
        <Button title="返回首页" onPress={() => router.replace('/')} />
      </EmptyState>
    </Screen>
  )
}
