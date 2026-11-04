// OpenAI Chat Completions ⇄ Anthropic Messages translation (request, response, and SSE stream).

import { recallThinking, rememberThinking } from './thinking-cache'
import {
  chatChunk,
  textOfContent,
  toChatUsage,
  usageChunk,
  type ChatContentPart,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type UsageCounts,
} from './types'

type Block = Record<string, unknown> & { type: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

// Model capability heuristics (see Anthropic API docs): recent Claude models reject sampling
// parameters and forced tool choice, and accept output_config.effort.
const SAMPLING_OK = /claude-(?:2|3|instant)|claude-(?:opus|sonnet|haiku)-4(?:-[0-6])?(?![0-9])(?!-[7-9])/
const NO_FORCED_TOOL = /claude-(?:(?:opus|sonnet)-5-[5-9]|(?:fable|mythos)-5-[1-9]|(?:opus|sonnet|haiku|fable|mythos)-[6-9])/
const EFFORT_OK = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[7-9]|[5-9])/
const LARGE_OUTPUT = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[5-9]|[5-9])/

export const anthropicCaps = {
  sampling: (model: string) => !/(^|\/)claude-/.test(model) || SAMPLING_OK.test(model),
  forcedToolChoice: (model: string) => !NO_FORCED_TOOL.test(model),
  effort: (model: string) => EFFORT_OK.test(model),
  defaultMaxTokens: (model: string, stream: boolean) => (LARGE_OUTPUT.test(model) ? (stream ? 64000 : 16000) : 8192),
}

function toBlocks(content: ChatMessage['content']): Block[] {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const out: Block[] = []
  for (const part of content as ChatContentPart[]) {
    if (part.type === 'text') {
      const text = (part as { text?: string }).text
      if (text) out.push({ type: 'text', text })
    } else if (part.type === 'image_url') {
      const url = (part as { image_url?: { url?: string } }).image_url?.url ?? ''
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      else if (url) out.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return out
}

function parseArgs(args: string): unknown {
  try {
    const v = JSON.parse(args || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function chatToAnthropic(req: ChatRequest, model: string, grantId: string): Record<string, unknown> {
  const system: string[] = []
  const messages: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else messages.push({ role, content: [...blocks] })
  }

  for (const m of req.messages ?? []) {
    switch (m.role) {
      case 'system':
      case 'developer': {
        const t = textOfContent(m.content)
        if (t) system.push(t)
        break
      }
      case 'user':
        push('user', toBlocks(m.content))
        break
      case 'assistant': {
        const blocks: Block[] = []
        const calls = m.tool_calls ?? []
        if (calls.length) {
          const thinking = recallThinking(grantId, calls[0].id)
          if (thinking) blocks.push(...(thinking as Block[]))
        }
        blocks.push(...toBlocks(m.content))
        for (const call of calls) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) })
        }
        push('assistant', blocks)
        break
      }
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOfContent(m.content) }])
        break
    }
  }

  const stream = Boolean(req.stream)
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? anthropicCaps.defaultMaxTokens(model, stream),
    messages,
  }
  if (system.length) body.system = system.join('\n\n')
  if (stream) body.stream = true
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  if (anthropicCaps.sampling(model)) {
    if (typeof req.temperature === 'number') body.temperature = Math.min(1, Math.max(0, req.temperature))
    if (typeof req.top_p === 'number') body.top_p = req.top_p
  }
  if (req.user) body.metadata = { user_id: String(req.user).slice(0, 256) }
  if (req.reasoning_effort && anthropicCaps.effort(model)) {
    const map: Record<string, string> = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
    const effort = map[req.reasoning_effort]
    if (effort) body.output_config = { effort }
  }

  if (req.tools?.length && req.tool_choice !== 'none') {
    body.tools = req.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }))
    let choice: Record<string, unknown> | undefined
    const forced = anthropicCaps.forcedToolChoice(model)
    if (req.tool_choice === 'required') choice = forced ? { type: 'any' } : { type: 'auto' }
    else if (req.tool_choice && typeof req.tool_choice === 'object') {
      choice = forced ? { type: 'tool', name: req.tool_choice.function.name } : { type: 'auto' }
    } else if (req.tool_choice === 'auto') choice = { type: 'auto' }
    if (req.parallel_tool_calls === false) choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true }
    if (choice) body.tool_choice = choice
  }
  return body
}

export function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    case null:
    case undefined:
      return null
    default:
      return 'stop'
  }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

const promptTokensOf = (u: AnthropicUsage | undefined) =>
  (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0)

export function anthropicToChat(resp: Record<string, unknown>, model: string, grantId: string) {
  const content = (resp.content as Block[] | undefined) ?? []
  let text = ''
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = []
  const thinking: Block[] = []
  for (const b of content) {
    if (b.type === 'text') text += String(b.text ?? '')
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } })
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') thinking.push(b)
  }
  rememberThinking(
    grantId,
    toolCalls.map((c) => c.id),
    thinking,
  )
  const usage = resp.usage as AnthropicUsage | undefined
  const counts: UsageCounts = { promptTokens: promptTokensOf(usage), completionTokens: usage?.output_tokens ?? 0 }
  return {
    counts,
    body: {
      id: `chatcmpl-${String(resp.id ?? '').replace(/^msg_/, '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: mapStopReason(resp.stop_reason as string | undefined),
        },
      ],
      usage: toChatUsage(counts),
    },
  }
}

/** Converts Anthropic SSE events into OpenAI chat.completion.chunk objects. */
export class AnthropicStreamTranslator {
  readonly id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  readonly created = Math.floor(Date.now() / 1000)
  usage: UsageCounts = { promptTokens: 0, completionTokens: 0 }
  finishReason: FinishReason = null
  error: { message: string; type: string } | null = null
  private toolIndex = new Map<number, number>()
  private nextTool = 0
  private toolIds: string[] = []
  private thinking: Block[] = []
  private currentThinking: Map<number, Block> = new Map()

  constructor(
    private readonly model: string,
    private readonly grantId: string,
  ) {}

  /** Returns chunks to forward to the client for one upstream event. */
  handle(eventName: string | undefined, data: string): Record<string, unknown>[] {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(data)
    } catch {
      return []
    }
    const type = (ev.type as string) ?? eventName
    const chunk = (delta: Record<string, unknown>, finish: FinishReason = null) => chatChunk(this.id, this.model, this.created, delta, finish)
    switch (type) {
      case 'message_start': {
        const usage = (ev.message as { usage?: AnthropicUsage } | undefined)?.usage
        this.usage.promptTokens = promptTokensOf(usage)
        this.usage.completionTokens = usage?.output_tokens ?? 0
        return [chunk({ role: 'assistant', content: '' })]
      }
      case 'content_block_start': {
        const index = Number(ev.index)
        const block = ev.content_block as Block
        if (block.type === 'tool_use') {
          const i = this.nextTool++
          this.toolIndex.set(index, i)
          this.toolIds.push(String(block.id))
          return [chunk({ tool_calls: [{ index: i, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] })]
        }
        if (block.type === 'thinking') this.currentThinking.set(index, { type: 'thinking', thinking: '', signature: '' })
        if (block.type === 'redacted_thinking') this.thinking.push(block)
        if (block.type === 'text' && block.text) return [chunk({ content: block.text })]
        return []
      }
      case 'content_block_delta': {
        const index = Number(ev.index)
        const delta = ev.delta as Record<string, unknown>
        if (delta.type === 'text_delta') return [chunk({ content: delta.text })]
        if (delta.type === 'input_json_delta') {
          const i = this.toolIndex.get(index)
          if (i === undefined) return []
          return [chunk({ tool_calls: [{ index: i, function: { arguments: delta.partial_json } }] })]
        }
        const th = this.currentThinking.get(index)
        if (th && delta.type === 'thinking_delta') {
          th.thinking = String(th.thinking) + String(delta.thinking ?? '')
          return delta.thinking ? [chunk({ reasoning_content: delta.thinking })] : []
        }
        if (th && delta.type === 'signature_delta') th.signature = String(th.signature) + String(delta.signature ?? '')
        return []
      }
      case 'content_block_stop': {
        const index = Number(ev.index)
        const th = this.currentThinking.get(index)
        if (th) {
          this.thinking.push(th)
          this.currentThinking.delete(index)
        }
        return []
      }
      case 'message_delta': {
        const delta = ev.delta as { stop_reason?: string } | undefined
        if (delta?.stop_reason) this.finishReason = mapStopReason(delta.stop_reason)
        const usage = ev.usage as AnthropicUsage | undefined
        if (usage?.output_tokens !== undefined) this.usage.completionTokens = usage.output_tokens
        if (usage?.input_tokens !== undefined) this.usage.promptTokens = Math.max(this.usage.promptTokens, promptTokensOf(usage))
        return []
      }
      case 'message_stop':
        rememberThinking(this.grantId, this.toolIds, this.thinking)
        return [chunk({}, this.finishReason ?? 'stop')]
      case 'error': {
        const err = (ev.error as { message?: string; type?: string }) ?? {}
        this.error = { message: err.message ?? 'upstream error', type: err.type ?? 'upstream_error' }
        return []
      }
      default:
        return []
    }
  }

  usageChunk() {
    return usageChunk(this.id, this.model, this.created, this.usage)
  }
}
