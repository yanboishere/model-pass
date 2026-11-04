import { useColorScheme } from 'react-native'

export function useDemoTheme() {
  const dark = useColorScheme() === 'dark'
  return {
    dark,
    accent: '#10B981',
    accent2: '#0EA5E9',
    bg: dark ? '#0A0F0D' : '#F4F7F6',
    card: dark ? '#141B18' : '#FFFFFF',
    ink: dark ? '#F1F5F9' : '#0F172A',
    muted: dark ? '#94A3B8' : '#64748B',
    line: dark ? '#22302A' : '#E3E9E7',
    bubble: dark ? '#1B2421' : '#FFFFFF',
    input: dark ? '#141B18' : '#FFFFFF',
    danger: '#DC2626',
    mp: '#5B5BF7',
  }
}
