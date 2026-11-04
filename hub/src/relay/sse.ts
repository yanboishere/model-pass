export interface SseEvent {
  event?: string
  data: string
}

/** Incremental Server-Sent Events parser over a byte stream. */
export async function* parseSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const flush = (): SseEvent | null => {
    if (data.length === 0 && event === undefined) return null
    const out = { event, data: data.join('\n') }
    event = undefined
    data = []
    return out
  }

  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(buffer[nl] === '\r' ? nl + 2 : nl + 1)
        if (line === '') {
          const ev = flush()
          if (ev) yield ev
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else {
          const idx = line.indexOf(':')
          const field = idx < 0 ? line : line.slice(0, idx)
          let val = idx < 0 ? '' : line.slice(idx + 1)
          if (val.startsWith(' ')) val = val.slice(1)
          if (field === 'data') data.push(val)
          else if (field === 'event') event = val
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim().startsWith('data:')) data.push(buffer.trim().slice(5).trimStart())
    const last = flush()
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

export function sse(data: unknown, event?: string): string {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  return `${event ? `event: ${event}\n` : ''}data: ${body}\n\n`
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}
