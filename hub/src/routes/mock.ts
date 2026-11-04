// Built-in mock upstreams so the whole flow can be tried without any real API key.
// They also enforce a few real-API rules (Anthropic headers/max_tokens/role order/thinking replay,
// Responses API store:false + stream:true) so the protocol translators are exercised honestly.

import { Hono, type Context } from 'hono'
import { sse, SSE_HEADERS } from '../relay/sse'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rid = (p: string) => p + Math.random().toString(36).slice(2, 12)
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 2))

interface Plan {
  text: string
  toolCall?: { name: string; args: Record<string, unknown> }
}

type AnyMsg = { role: string; content?: unknown; tool_calls?: unknown[] }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: Record<string, unknown>) => {
        if (typeof p.text === 'string') return p.text
        if (p.type === 'tool_result') return textOf(p.content)
        return ''
      })
      .join('')
  }
  return ''
}

function countImages(messages: AnyMsg[]): number {
  let n = 0
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const p of m.content as { type?: string }[]) if (p.type === 'image' || p.type === 'image_url' || p.type === 'input_image') n++
  }
  return n
}

function plan(model: string, protocol: string, messages: AnyMsg[], toolNames: string[], lastIsToolResult: boolean, toolResult: string): Plan {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const said = textOf(lastUser?.content).trim()
  if (lastIsToolResult) {
    return { text: `（${model}）根据工具返回的结果：${toolResult.slice(0, 160)}。总结：一切正常，这就是通过 ModelPass 完成的一次完整的工具调用。` }
  }
  if (toolNames.length && /天气|weather/i.test(said)) {
    const city = /([一-龥]{2,4})(?:的)?天气/.exec(said)?.[1] ?? 'Shanghai'
    return { text: '', toolCall: { name: toolNames[0], args: { city } } }
  }
  const images = countImages(messages)
  if (images) return { text: `（${model}）我收到了 ${images} 张图片。演示模型不会真正识别图片内容，但视觉请求已经完整地经过 ModelPass 转发到了上游。` }
  const brief = /mini|haiku/.test(model)
  const quote = said.length > 80 ? said.slice(0, 80) + '…' : said
  if (brief) return { text: `你好，我是演示模型 ${model}（${protocol} 协议）。你说的是「${quote}」。在 ModelPass 里切换模型后，这个应用无需任何改动。` }
  return {
    text:
      `你好！我是 ModelPass 内置的演示模型「${model}」，通过 ${protocol} 协议应答。\n\n` +
      `你刚才说：「${quote}」\n\n` +
      `这条回复来自 Hub 的模拟上游。真实使用时，它会来自你在 ModelPass 中为当前槽位选择的模型，例如 DeepSeek、Claude、GPT 或你自建的 Ollama：\n` +
      `- 应用里不需要填写任何 API Key\n- 在钱包里一键切换模型，所有已连接的应用立即生效\n- 每个应用的权限、额度和有效期都可以单独管理`,
  }
}

function chunks(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    const n = /[一-龥]/.test(text[i]) ? 2 : 4
    out.push(text.slice(i, i + n))
    i += n
  }
  return out
}

function streamOf(c: Context, producer: (send: (s: string) => void) => Promise<void>) {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (s: string) => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(s))
        } catch {
          closed = true
        }
      }
      try {
        await producer(send)
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // closed
        }
      }
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}

const delayFor = (c: Context) => Number(c.req.header('x-mock-delay-ms') ?? 18)

export function mockRoutes() {
  const app = new Hono()

  // ---- OpenAI-compatible -----------------------------------------------------------------------
  app.get('/openai/v1/models', (c) =>
    c.json({ object: 'list', data: ['mock-gpt-mini', 'mock-gpt-pro'].map((id) => ({ id, object: 'model', created: 1767225600, owned_by: 'modelpass-mock' })) }),
  )

  app.post('/openai/v1/chat/completions', async (c) => {
    if ((c.req.header('authorization') ?? '').includes('invalid')) return c.json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401)
    const body = (await c.req.json()) as { model: string; messages: AnyMsg[]; stream?: boolean; tools?: { function: { name: string } }[]; stream_options?: { include_usage?: boolean } }
    const last = body.messages[body.messages.length - 1]
    const p = plan(
      body.model,
      'OpenAI',
      body.messages,
      (body.tools ?? []).map((t) => t.function.name),
      last?.role === 'tool',
      textOf(last?.content),
    )
    const id = rid('chatcmpl-mock')
    const created = Math.floor(Date.now() / 1000)
    const prompt = estimateTokens(JSON.stringify(body.messages))
    const completion = estimateTokens(p.text + JSON.stringify(p.toolCall ?? ''))
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
    const toolCall = p.toolCall && { id: rid('call_'), type: 'function', function: { name: p.toolCall.name, arguments: JSON.stringify(p.toolCall.args) } }
    if (!body.stream) {
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : p.text, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
        usage,
      })
    }
    const delay = delayFor(c)
    return streamOf(c, async (send) => {
      const base = { id, object: 'chat.completion.chunk', created, model: body.model }
      send(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }))
      if (toolCall) {
        send(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '' } }] }, finish_reason: null }] }))
        for (const part of chunks(toolCall.function.arguments)) {
          send(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] }))
          await sleep(delay / 2)
        }
      } else {
        for (const part of chunks(p.text)) {
          send(sse({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }))
          await sleep(delay)
        }
      }
      send(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] }))
      if (body.stream_options?.include_usage) send(sse({ ...base, choices: [], usage }))
      send('data: [DONE]\n\n')
    })
  })

  // ---- OpenAI Responses API (mirrors the ChatGPT-plan constraints) ---------------------------------
  app.post('/openai/v1/responses', async (c) => {
    const body = (await c.req.json()) as { model: string; input: Record<string, unknown>[]; stream?: boolean; store?: boolean; temperature?: number; tools?: { name: string }[] }
    if (body.store !== false || body.stream !== true) return c.json({ error: { message: 'store must be false and stream must be true', type: 'invalid_request_error' } }, 400)
    if (body.temperature !== undefined) return c.json({ error: { message: 'temperature is not supported', type: 'invalid_request_error' } }, 400)
    const messages: AnyMsg[] = body.input.map((i) =>
      i.type === 'function_call_output' ? { role: 'tool', content: String(i.output) } : { role: String(i.role ?? 'user'), content: i.content },
    )
    const last = messages[messages.length - 1]
    const p = plan(body.model, 'OpenAI Responses', messages, (body.tools ?? []).map((t) => t.name), last?.role === 'tool', textOf(last?.content))
    const delay = delayFor(c)
    const respId = rid('resp_')
    return streamOf(c, async (send) => {
      send(sse({ type: 'response.created', response: { id: respId, status: 'in_progress', model: body.model } }, 'response.created'))
      if (p.toolCall) {
        const callId = rid('call_')
        send(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: rid('fc_'), call_id: callId, name: p.toolCall.name, arguments: '' } }, 'response.output_item.added'))
        for (const part of chunks(JSON.stringify(p.toolCall.args))) {
          send(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: part }, 'response.function_call_arguments.delta'))
          await sleep(delay / 2)
        }
      } else {
        const itemId = rid('msg_')
        send(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [] } }, 'response.output_item.added'))
        for (const part of chunks(p.text)) {
          send(sse({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: part }, 'response.output_text.delta'))
          await sleep(delay)
        }
      }
      const usage = { input_tokens: estimateTokens(JSON.stringify(body.input)), output_tokens: estimateTokens(p.text) }
      send(sse({ type: 'response.completed', response: { id: respId, status: 'completed', usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } } }, 'response.completed'))
    })
  })

  // ---- Anthropic Messages ------------------------------------------------------------------------
  app.get('/anthropic/v1/models', (c) =>
    c.json({
      data: ['mock-claude-haiku', 'mock-claude-opus'].map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
      first_id: 'mock-claude-haiku',
      last_id: 'mock-claude-opus',
    }),
  )

  app.post('/anthropic/v1/messages', async (c) => {
    const invalid = (message: string, status = 400) => c.json({ type: 'error', error: { type: 'invalid_request_error', message } }, status as 400)
    if (!c.req.header('anthropic-version')) return invalid('anthropic-version header is required')
    if ((c.req.header('x-api-key') ?? '').includes('invalid')) return c.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
    const body = (await c.req.json()) as {
      model: string
      max_tokens?: number
      messages: { role: string; content: unknown }[]
      stream?: boolean
      tools?: { name: string }[]
      system?: unknown
    }
    if (typeof body.max_tokens !== 'number') return invalid('max_tokens: field required')
    if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid('messages: at least one message is required')
    for (let i = 1; i < body.messages.length; i++) {
      if (body.messages[i].role === body.messages[i - 1].role) return invalid(`messages: roles must alternate (index ${i})`)
    }
    if (body.messages.some((m) => m.role === 'system')) return invalid('messages: system role is not allowed, use the top-level system parameter')
    const last = body.messages[body.messages.length - 1]
    const lastBlocks = Array.isArray(last.content) ? (last.content as { type: string; content?: unknown }[]) : []
    const toolResult = lastBlocks.find((b) => b.type === 'tool_result')
    const thinks = /opus/.test(body.model)
    if (toolResult && thinks) {
      const prev = body.messages[body.messages.length - 2]
      const prevBlocks = Array.isArray(prev?.content) ? (prev.content as { type: string; signature?: string }[]) : []
      if (prevBlocks[0]?.type !== 'thinking' || !prevBlocks[0].signature?.startsWith('mocksig_')) {
        return invalid('messages: the final assistant message must start with the thinking block it was generated with (mock rule mirroring Claude)')
      }
    }
    const messages: AnyMsg[] = body.messages.map((m) => ({ role: m.role, content: m.content }))
    const p = plan(body.model, 'Anthropic', messages, (body.tools ?? []).map((t) => t.name), Boolean(toolResult), textOf(toolResult?.content))
    const id = rid('msg_mock')
    const input = estimateTokens(JSON.stringify(body.messages) + JSON.stringify(body.system ?? ''))
    const output = estimateTokens(p.text + JSON.stringify(p.toolCall ?? ''))
    const thinkingBlock = p.toolCall && thinks ? { type: 'thinking', thinking: '', signature: rid('mocksig_') } : null
    const toolUse = p.toolCall && { type: 'tool_use', id: rid('toolu_'), name: p.toolCall.name, input: p.toolCall.args }
    const stopReason = toolUse ? 'tool_use' : 'end_turn'

    if (!body.stream) {
      const content = [...(thinkingBlock ? [thinkingBlock] : []), ...(toolUse ? [toolUse] : [{ type: 'text', text: p.text }])]
      return c.json({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: input, output_tokens: output } })
    }
    const delay = delayFor(c)
    return streamOf(c, async (send) => {
      send(sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 1 } } }, 'message_start'))
      let index = 0
      if (thinkingBlock) {
        send(sse({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }, 'content_block_start'))
        send(sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: thinkingBlock.signature } }, 'content_block_delta'))
        send(sse({ type: 'content_block_stop', index }, 'content_block_stop'))
        index++
      }
      send(sse({ type: 'ping' }, 'ping'))
      if (toolUse) {
        send(sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} } }, 'content_block_start'))
        for (const part of chunks(JSON.stringify(toolUse.input))) {
          send(sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } }, 'content_block_delta'))
          await sleep(delay / 2)
        }
      } else {
        send(sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start'))
        for (const part of chunks(p.text)) {
          send(sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } }, 'content_block_delta'))
          await sleep(delay)
        }
      }
      send(sse({ type: 'content_block_stop', index }, 'content_block_stop'))
      send(sse({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: output } }, 'message_delta'))
      send(sse({ type: 'message_stop' }, 'message_stop'))
    })
  })

  return app
}
