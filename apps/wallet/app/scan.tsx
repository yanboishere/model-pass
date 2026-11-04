import { useRef, useState } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '../src/components/ui'
import { routeScannedText } from '../src/lib/route-scan'

export default function Scan() {
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const handled = useRef(false)
  const [hint, setHint] = useState('对准电脑或网页上的 ModelPass 二维码')

  const handle = (data: string) => {
    if (handled.current) return
    if (routeScannedText(data)) handled.current = true
    else setHint('这不是 ModelPass 二维码')
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {permission?.granted ? (
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => handle(data)} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
          <Ionicons name="camera-outline" size={48} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center', lineHeight: 23 }}>需要相机权限来扫描授权二维码。{'\n'}也可以直接粘贴授权链接。</Text>
          <Button title="允许使用相机" onPress={requestPermission} />
        </View>
      )}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Pressable onPress={() => router.back()} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
          <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>扫码授权</Text>
          <View style={{ width: 40 }} />
        </View>
        {permission?.granted ? (
          <View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 250, height: 250, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' }} />
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={{ paddingBottom: insets.bottom + 24, paddingHorizontal: 24, gap: 14 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 14 }}>{hint}</Text>
          <Button
            title="粘贴授权链接"
            variant="secondary"
            icon="clipboard-outline"
            onPress={async () => {
              const text = await Clipboard.getStringAsync()
              if (!text || !routeScannedText(text)) Alert.alert('剪贴板中没有 ModelPass 链接', '请在对方设备上复制授权链接后再试。')
            }}
          />
        </View>
      </View>
    </View>
  )
}
