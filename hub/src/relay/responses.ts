// OpenAI Chat Completions → OpenAI Responses API translation, used by the experimental ChatGPT-plan
// connector ("Sign in with ChatGPT" plan usage requires Responses API with store:false, stream:true,
// and does not accept temperature / max_output_tokens).

import { chatChunk, textOfContent, usageChunk, type ChatContentPart, type ChatRequest, type FinishReason, type UsageCounts } from './types'

type Item = Record<string, unknown>

function userContent(content: ChatRequest['messages'][number]['content']): Item[] {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : []
  const out: Item[] = []
  for (const part of content as ChatContentPart[]) {
    if (part.type === 'text') out.push({ type: 'input_text', text: (part as { text: string }).text })
    else if (part.type === 'image_url') out.push({ type: 'input_image', image_url: (part as { image_url: { url: string } }).image_url.url })
  }
  return out
}

export function chatToResponses(req: ChatRequest, model: string): Record<string, unknown> {
  const instructions: string[] = []
  const input: Item[] = []
  for (const m of req.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOfContent(m.content)
      if (t) instructions.push(t)
    } else if (m.role === 'user') {
      const content = userContent(m.content)
      if (content.length) input.push({ role: 'user', content })
    } else if (m.role === 'assistant') {
      const t = textOfContent(m.content)
      if (t) input.push({ role: 'assistant', content: [{ type: 'output_text', text: t }] })
      for (const c of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' })
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: textOfContent(m.content) })
    }
  }
  const body: Record<string, unknown> = { model, input, stream: true, store: false }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
      ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
    }))
    if (req.tool_choice) {
      body.tool_choice = typeof req.tool_choice === 'string' ? req.tool_choice : { type: 'function', name: req.tool_choice.function.name }
    }
    if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls
  }
  if (req.reasoning_effort) body.reasoning = { effort: req.reasoning_effort }
  return body
}

export class ResponsesStreamTranslator {
  readonly id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  readonly created = Math.floor(Date.now() / 1000)
  usage: UsageCounts = { promptTokens: 0, completionTokens: 0 }
  finishReason: FinishReason = null
  error: { message: string; type: string } | null = null
  done = false
  private started = false
  private toolByOutput = new Map<number, number>()
  private nextTool = 0

  constructor(private readonly model: string) {}

  handle(eventName: string | undefined, data: string): Record<string, unknown>[] {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(data)
    } catch {
      return []
    }
    const type = (ev.type as string) ?? eventName
    const out: Record<string, unknown>[] = []
    const chunk = (delta: Record<string, unknown>, finish: FinishReason = null) => chatChunk(this.id, this.model, this.created, delta, finish)
    if (!this.started && type !== 'error') {
      this.started = true
      out.push(chunk({ role: 'assistant', content: '' }))
    }
    switch (type) {
      case 'response.output_text.delta':
        out.push(chunk({ content: ev.delta }))
        break
      case 'response.output_item.added': {
        const item = ev.item as Item
        if (item?.type === 'function_call') {
          const i = this.nextTool++
          this.toolByOutput.set(Number(ev.output_index), i)
          out.push(chunk({ tool_calls: [{ index: i, id: item.call_id, type: 'function', function: { name: item.name, arguments: '' } }] }))
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const i = this.toolByOutput.get(Number(ev.output_index))
        if (i !== undefined) out.push(chunk({ tool_calls: [{ index: i, function: { arguments: ev.delta } }] }))
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const resp = (ev.response as Item) ?? {}
        const usage = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined
        this.usage = { promptTokens: usage?.input_tokens ?? 0, completionTokens: usage?.output_tokens ?? 0 }
        this.finishReason = type === 'response.incomplete' ? 'length' : this.nextTool > 0 ? 'tool_calls' : 'stop'
        this.done = true
        out.push(chunk({}, this.finishReason))
        break
      }
      case 'response.failed': {
        const err = ((ev.response as Item)?.error as { message?: string; code?: string }) ?? {}
        this.error = { message: err.message ?? 'upstream response failed', type: err.code ?? 'upstream_error' }
        break
      }
      case 'error':
        this.error = { message: String(ev.message ?? 'upstream error'), type: String(ev.code ?? 'upstream_error') }
        break
    }
    return out
  }

  usageChunk() {
    return usageChunk(this.id, this.model, this.created, this.usage)
  }
}
