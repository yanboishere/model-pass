import { useMemo } from 'react'
import Svg, { Path, Rect } from 'react-native-svg'
import qrcode from 'qrcode-generator'

export function QRCode({ value, size = 220, color = '#0B0B0F' }: { value: string; size?: number; color?: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { path: d, count: n }
  }, [value])
  return (
    <Svg width={size} height={size} viewBox={`-2 -2 ${count + 4} ${count + 4}`}>
      <Rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#FFFFFF" />
      <Path d={path} fill={color} />
    </Svg>
  )
}
