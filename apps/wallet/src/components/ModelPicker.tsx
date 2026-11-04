import React, { useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { getPreset, type RouteTarget } from '@modelpass/core'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { LocalProvider } from '../storage'
import { useTheme } from '../theme'
import { Avatar } from './ui'

export function ProviderAvatar({ presetId, size = 40 }: { presetId: string; size?: number }) {
  const p = getPreset(presetId)
  return <Avatar label={p?.monogram ?? '+'} color={p?.color ?? '#64748B'} size={size} />
}

type Item = { kind: 'follow' } | { kind: 'header'; provider: LocalProvider } | { kind: 'model'; provider: LocalProvider; model: string }

/**
 * Bottom sheet listing every model of every provider. `followLabel` adds a "follow global" row
 * that yields `null`.
 */
export function ModelPicker({
  visible,
  title,
  providers,
  value,
  followLabel,
  onClose,
  onSelect,
}: {
  visible: boolean
  title: string
  providers: LocalProvider[]
  value: RouteTarget | null | undefined
  followLabel?: string
  onClose: () => void
  onSelect: (t: RouteTarget | null) => void
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Item[] = followLabel && !q ? [{ kind: 'follow' }] : []
    for (const p of providers) {
      const models = p.record.models.filter((m) => !q || m.toLowerCase().includes(q) || p.record.name.toLowerCase().includes(q))
      if (!models.length) continue
      out.push({ kind: 'header', provider: p })
      for (const m of models.slice(0, 400)) out.push({ kind: 'model', provider: p, model: m })
    }
    return out
  }, [providers, query, followLabel])

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: t.ink }}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={{ fontSize: 16, color: t.brand, fontWeight: '600' }}>完成</Text>
          </Pressable>
        </View>
        <View style={{ marginHorizontal: 16, marginBottom: 8, flexDirection: 'row', alignItems: 'center', backgroundColor: t.input, borderRadius: 12, paddingHorizontal: 12 }}>
          <Ionicons name="search" size={16} color={t.faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索模型或厂商"
            placeholderTextColor={t.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, height: 42, marginLeft: 8, color: t.ink, fontSize: 15 }}
          />
        </View>
        {providers.length === 0 ? (
          <Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>还没有添加任何模型厂商</Text>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(it, i) => (it.kind === 'model' ? `${it.provider.record.id}:${it.model}` : `${it.kind}-${i}`)}
            renderItem={({ item }) => {
              if (item.kind === 'header') {
                return (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 }}>
                    <ProviderAvatar presetId={item.provider.record.presetId} size={24} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.muted }}>{item.provider.record.name}</Text>
                  </View>
                )
              }
              const selected = item.kind === 'follow' ? !value : value?.providerId === item.provider.record.id && value?.model === item.model
              return (
                <Pressable
                  onPress={() => {
                    onSelect(item.kind === 'follow' ? null : { providerId: item.provider.record.id, model: item.model })
                    onClose()
                  }}
                  style={({ pressed }) => ({
                    marginHorizontal: 16,
                    marginVertical: 2,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: 12,
                    backgroundColor: selected ? t.brandSoft : pressed ? t.input : t.card,
                    flexDirection: 'row',
                    alignItems: 'center',
                  })}
                >
                  <Text style={{ flex: 1, fontSize: 15, color: selected ? t.brand : t.ink, fontWeight: selected ? '700' : '500' }}>
                    {item.kind === 'follow' ? followLabel : item.model}
                  </Text>
                  {selected ? <Ionicons name="checkmark-circle" size={20} color={t.brand} /> : null}
                </Pressable>
              )
            }}
          />
        )}
      </View>
    </Modal>
  )
}
