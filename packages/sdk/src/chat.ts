import { utf8Decode } from '@modelpass/core'
import type { ModelPassClient } from './client'
import { ModelPassError } from './errors'

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface ChatCompletionParams {
  /** A slot id (`default`, `fast`, `reasoning`, `vision`) — the user decides the actual model. */
  model?: string
  messages: ChatMessage[]
  [key: string]: unknown
}

export interface ResponseMeta {
  slot?: string
  model?: string
  provider?: string
  fallback: boolean
  budgetRemaining?: number
}

export interface ChatCompletion {
  id: string
  model: string
  choices: { index: number; message: ChatMessage; finish_reason: string | null }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface ChatCompletionChunk {
  id: string
  model: string
  choices: { index: number; delta: Partial<ChatMessage> & { reasoning_content?: string }; finish_reason: string | null }[]
  usage?: ChatCompletion['usage']
  error?: { message: string; type?: string; code?: string }
}

export function responseMeta(res: Response): ResponseMeta {
  const h = (k: string) => res.headers.get(k) ?? undefined
  const provider = h('x-modelpass-provider')
  const budget = h('x-modelpass-budget-remaining')
  return {
    slot: h('x-modelpass-slot'),
    model: h('x-modelpass-model'),
    provider: provider ? decodeURIComponent(provider) : undefined,
    fallback: h('x-modelpass-fallback') === 'true',
    budgetRemaining: budget ? Number(budget) : undefined,
  }
}

/** Streaming UTF-8 decoder that works even where TextDecoder is unavailable (Hermes). */
class Utf8Stream {
  private pending = new Uint8Array(0)
  private native = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null
  push(chunk: Uint8Array): string {
    if (this.native) return this.native.decode(chunk, { stream: true })
    const buf = new Uint8Array(this.pending.length + chunk.length)
    buf.set(this.pending)
    buf.set(chunk, this.pending.length)
    let end = buf.length
    // back off over an incomplete trailing sequence
    for (let i = Math.max(0, buf.length - 3); i < buf.length; i++) {
      const b = buf[i]
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
      if (need > 1 && i + need > buf.length) {
        end = i
        break
      }
    }
    this.pending = buf.slice(end)
    return utf8Decode(buf.subarray(0, end))
  }
}

export class ChatApi {
  constructor(
    private readonly client: ModelPassClient,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async create(params: ChatCompletionParams, opts: { signal?: AbortSignal } = {}): Promise<ChatCompletion & { modelpass: ResponseMeta }> {
    const res = await this.client.apiFetch('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'default', ...params, stream: false }),
      signal: opts.signal,
    })
    const body = (await res.json()) as ChatCompletion
    return { ...body, modelpass: responseMeta(res) }
  }

  /** Yields OpenAI-style chunks. */
  async *stream(
    params: ChatCompletionParams,
    opts: { signal?: AbortSignal; onResponse?: (meta: ResponseMeta) => void } = {},
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.client.apiFetch('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'default', ...params, stream: true }),
      signal: opts.signal,
    })
    opts.onResponse?.(responseMeta(res))
    if (!res.body) {
      // Environments without streaming fetch: parse the whole SSE payload at once.
      yield* parseSseText(await res.text())
      return
    }
    const reader = res.body.getReader()
    const decoder = new Utf8Stream()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.push(value)
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const chunk = parseBlock(block)
          if (chunk === 'done') return
          if (chunk) yield chunk
        }
      }
      const tail = parseBlock(buffer)
      if (tail && tail !== 'done') yield tail
    } finally {
      reader.releaseLock?.()
    }
  }

  /** Yields text deltas only; throws ModelPassError if the stream reports an error. */
  async *streamText(params: ChatCompletionParams, opts: { signal?: AbortSignal; onResponse?: (meta: ResponseMeta) => void } = {}): AsyncGenerator<string> {
    for await (const chunk of this.stream(params, opts)) {
      if (chunk.error) throw new ModelPassError(chunk.error.code ?? 'upstream_error', chunk.error.message)
      const text = chunk.choices?.[0]?.delta?.content
      if (typeof text === 'string' && text) yield text
    }
  }
}

function parseBlock(block: string): ChatCompletionChunk | 'done' | null {
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  if (data.trim() === '[DONE]') return 'done'
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

function* parseSseText(text: string): Generator<ChatCompletionChunk> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const c = parseBlock(block)
    if (c === 'done') return
    if (c) yield c
  }
}
