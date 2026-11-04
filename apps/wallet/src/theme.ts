import { useColorScheme } from 'react-native'

const light = {
  dark: false,
  brand: '#5B5BF7',
  brand2: '#8B5CF6',
  brandSoft: '#EEF0FF',
  bg: '#F5F6FA',
  card: '#FFFFFF',
  elevated: '#FFFFFF',
  ink: '#0F172A',
  text: '#1E293B',
  muted: '#64748B',
  faint: '#94A3B8',
  line: '#E6E8F0',
  input: '#F1F3F8',
  success: '#16A34A',
  successSoft: '#DCFCE7',
  warning: '#D97706',
  warningSoft: '#FEF3C7',
  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
}

const dark: typeof light = {
  dark: true,
  brand: '#7C7CFF',
  brand2: '#A78BFA',
  brandSoft: '#23244A',
  bg: '#0B0D14',
  card: '#151824',
  elevated: '#1C2030',
  ink: '#F8FAFC',
  text: '#E2E8F0',
  muted: '#94A3B8',
  faint: '#64748B',
  line: '#262B3B',
  input: '#1C2030',
  success: '#22C55E',
  successSoft: '#12301E',
  warning: '#F59E0B',
  warningSoft: '#3A2A0B',
  danger: '#F87171',
  dangerSoft: '#3B1414',
}

export type Theme = typeof light

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}

export const radius = { sm: 10, md: 14, lg: 18, xl: 24 }
