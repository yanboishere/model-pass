export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '从未使用'
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts * 1000).toLocaleDateString('zh-CN')
}

export function clock(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function keyHint(key: string | undefined): string {
  if (!key) return '未设置'
  if (key.length <= 10) return '••••'
  return `${key.slice(0, 5)}…${key.slice(-4)}`
}

export function expiryLabel(expiresAt: number | null): string {
  if (!expiresAt) return '长期有效'
  const days = Math.ceil((expiresAt - Date.now() / 1000) / 86400)
  if (days <= 0) return '已过期'
  return `${days} 天后过期`
}
