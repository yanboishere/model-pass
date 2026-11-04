import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { radius, useTheme } from '../theme'

export type IconName = React.ComponentProps<typeof Ionicons>['name']

export function Screen({
  children,
  refreshing,
  onRefresh,
  padTop,
  contentStyle,
}: {
  children: React.ReactNode
  refreshing?: boolean
  onRefresh?: () => void
  padTop?: boolean
  contentStyle?: StyleProp<ViewStyle>
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={[{ padding: 16, paddingTop: padTop ? insets.top + 8 : 12, paddingBottom: 40, gap: 14 }, contentStyle]}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.brand} /> : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  )
}

export function LargeTitle({ title, subtitle, right, dot }: { title: string; subtitle?: string; right?: React.ReactNode; dot?: string }) {
  const t = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 2 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 30, fontWeight: '800', color: t.ink, letterSpacing: -0.6 }}>{title}</Text>
        {subtitle ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} /> : null}
            <Text style={{ fontSize: 14, color: t.muted }}>{subtitle}</Text>
          </View>
        ) : null}
      </View>
      {right}
    </View>
  )
}

export function Card({ children, style, padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const t = useTheme()
  return (
    <View style={[{ backgroundColor: t.card, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, padding: padded ? 16 : 0, overflow: 'hidden' }, style]}>
      {children}
    </View>
  )
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const t = useTheme()
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingHorizontal: 4 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: t.muted, letterSpacing: 0.4 }}>{title}</Text>
      {action ? (
        <Pressable onPress={onAction} hitSlop={10}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: t.brand }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export function ListRow({
  left,
  title,
  subtitle,
  right,
  onPress,
  chevron = !!onPress,
  last,
  danger,
}: {
  left?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  right?: React.ReactNode
  onPress?: () => void
  chevron?: boolean
  last?: boolean
  danger?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => ({ backgroundColor: pressed ? t.input : 'transparent' })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
        {left}
        <View style={{ flex: 1, minWidth: 0 }}>
          {typeof title === 'string' ? (
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: danger ? t.danger : t.ink }}>
              {title}
            </Text>
          ) : (
            title
          )}
          {subtitle ? (
            typeof subtitle === 'string' ? (
              <Text numberOfLines={2} style={{ fontSize: 13, color: t.muted, marginTop: 2 }}>
                {subtitle}
              </Text>
            ) : (
              subtitle
            )
          ) : null}
        </View>
        {right}
        {chevron ? <Ionicons name="chevron-forward" size={18} color={t.faint} /> : null}
      </View>
      {!last ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line, marginLeft: left ? 68 : 16 }} /> : null}
    </Pressable>
  )
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  style,
  size = 'md',
}: {
  title: string
  onPress?: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'dark'
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  size?: 'md' | 'lg' | 'sm'
}) {
  const t = useTheme()
  const palette = {
    primary: { bg: t.brand, fg: '#FFFFFF', border: t.brand },
    secondary: { bg: t.card, fg: t.ink, border: t.line },
    danger: { bg: t.dangerSoft, fg: t.danger, border: t.dangerSoft },
    ghost: { bg: 'transparent', fg: t.brand, border: 'transparent' },
    dark: { bg: t.dark ? '#FFFFFF' : '#111111', fg: t.dark ? '#111111' : '#FFFFFF', border: 'transparent' },
  }[variant]
  const height = size === 'lg' ? 54 : size === 'sm' ? 36 : 46
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          height,
          borderRadius: size === 'sm' ? 10 : 14,
          backgroundColor: palette.bg,
          borderWidth: 1,
          borderColor: palette.border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          paddingHorizontal: size === 'sm' ? 12 : 18,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : icon ? <Ionicons name={icon} size={size === 'sm' ? 16 : 19} color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: size === 'lg' ? 17 : size === 'sm' ? 14 : 16, fontWeight: '700' }}>{title}</Text>
    </Pressable>
  )
}

export function Pill({ text, tone = 'neutral', icon }: { text: string; tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral'; icon?: IconName }) {
  const t = useTheme()
  const c = {
    brand: [t.brandSoft, t.brand],
    success: [t.successSoft, t.success],
    warning: [t.warningSoft, t.warning],
    danger: [t.dangerSoft, t.danger],
    neutral: [t.input, t.muted],
  }[tone]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: c[0], borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
      {icon ? <Ionicons name={icon} size={12} color={c[1]} /> : null}
      <Text style={{ fontSize: 12, fontWeight: '700', color: c[1] }}>{text}</Text>
    </View>
  )
}

export function Avatar({ label, color, size = 40, emoji }: { label?: string; color?: string; size?: number; emoji?: string }) {
  const t = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: emoji ? t.input : color ?? t.brand, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: emoji ? size * 0.5 : (label?.length ?? 1) > 2 ? size * 0.28 : size * 0.38 }}>{emoji ?? label}</Text>
    </View>
  )
}

export function IconBadge({ name, color, size = 40 }: { name: IconName; color?: string; size?: number }) {
  const t = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={size * 0.5} color={color ?? t.brand} />
    </View>
  )
}

export function Segmented<T extends string | number | null>({ options, value, onChange }: { options: { label: string; value: T }[]; value: T; onChange: (v: T) => void }) {
  const t = useTheme()
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.input, borderRadius: 12, padding: 3, gap: 3 }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} style={{ flex: 1, paddingVertical: 8, borderRadius: 9, backgroundColor: active ? t.card : 'transparent', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: active ? '700' : '500', color: active ? t.ink : t.muted }}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function ToggleRow({ title, subtitle, value, onValueChange, last }: { title: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void; last?: boolean }) {
  const t = useTheme()
  return <ListRow title={title} subtitle={subtitle} last={last} right={<Switch value={value} onValueChange={onValueChange} trackColor={{ true: t.brand, false: t.line }} />} />
}

export function Field({ label, hint, right, ...props }: TextInputProps & { label: string; hint?: string; right?: React.ReactNode }) {
  const t = useTheme()
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: t.muted, marginLeft: 2 }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.input, borderRadius: 12, paddingHorizontal: 12 }}>
        <TextInput
          placeholderTextColor={t.faint}
          autoCapitalize="none"
          autoCorrect={false}
          {...props}
          style={[{ flex: 1, minHeight: 46, color: t.ink, fontSize: 15, paddingVertical: 10 }, props.style]}
        />
        {right}
      </View>
      {hint ? <Text style={{ fontSize: 12, color: t.faint, marginLeft: 2, lineHeight: 17 }}>{hint}</Text> : null}
    </View>
  )
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: string; body?: string; children?: React.ReactNode }) {
  const t = useTheme()
  return (
    <Card style={{ alignItems: 'center', paddingVertical: 28, gap: 8 }}>
      <IconBadge name={icon} size={52} />
      <Text style={{ fontSize: 17, fontWeight: '700', color: t.ink, marginTop: 6 }}>{title}</Text>
      {body ? <Text style={{ fontSize: 14, color: t.muted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 10 }}>{body}</Text> : null}
      {children ? <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 10 }}>{children}</View> : null}
    </Card>
  )
}

export function Notice({ tone = 'warning', icon = 'alert-circle', children }: { tone?: 'warning' | 'danger' | 'brand' | 'success'; icon?: IconName; children: React.ReactNode }) {
  const t = useTheme()
  const [bg, fg] = { warning: [t.warningSoft, t.warning], danger: [t.dangerSoft, t.danger], brand: [t.brandSoft, t.brand], success: [t.successSoft, t.success] }[tone]
  return (
    <View style={{ flexDirection: 'row', gap: 10, backgroundColor: bg, borderRadius: radius.md, padding: 12, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={18} color={fg} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, color: fg, fontSize: 13.5, lineHeight: 19, fontWeight: '500' }}>{children}</Text>
    </View>
  )
}

export function Muted({ children, style }: { children: React.ReactNode; style?: object }) {
  const t = useTheme()
  return <Text style={[{ fontSize: 13, color: t.muted, lineHeight: 19 }, style]}>{children}</Text>
}

export function Label({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return <Text style={{ fontSize: 13, fontWeight: '700', color: t.muted, marginBottom: 8 }}>{children}</Text>
}
