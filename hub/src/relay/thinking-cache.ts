// OpenAI's chat format has nowhere to carry Anthropic thinking blocks, but Claude requires the
// thinking blocks of the previous assistant turn to be sent back unchanged during tool-use loops.
// We remember them server-side, keyed by grant + tool_use id, and re-insert them when the client
// sends the matching assistant tool_calls message back.

const MAX_ENTRIES = 2000
const TTL_MS = 60 * 60 * 1000

interface Entry {
  blocks: unknown[]
  at: number
}

const cache = new Map<string, Entry>()

export function rememberThinking(grantId: string, toolUseIds: string[], blocks: unknown[]) {
  if (!blocks.length || !toolUseIds.length) return
  const at = Date.now()
  for (const id of toolUseIds) {
    const key = `${grantId}:${id}`
    cache.delete(key)
    cache.set(key, { blocks, at })
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function recallThinking(grantId: string, toolUseId: string): unknown[] | null {
  const key = `${grantId}:${toolUseId}`
  const e = cache.get(key)
  if (!e) return null
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(key)
    return null
  }
  return e.blocks
}
