export const BUDGET_OPTIONS: { label: string; value: number | null }[] = [
  { label: '不限', value: null },
  { label: '5 万', value: 50_000 },
  { label: '20 万', value: 200_000 },
  { label: '100 万', value: 1_000_000 },
]

export const EXPIRY_OPTIONS: { label: string; value: number | null }[] = [
  { label: '长期', value: null },
  { label: '30 天', value: 30 },
  { label: '7 天', value: 7 },
  { label: '1 天', value: 1 },
]

export const expiresAtFromDays = (days: number | null) => (days ? Math.floor(Date.now() / 1000) + days * 86400 : null)
