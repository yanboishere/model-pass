// Minimal OpenAI Chat Completions shapes used by the relay (only the fields we translate).

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: string; [key: string]: unknown }

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | string
  content?: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
}

export type ChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
  parallel_tool_calls?: boolean
  user?: string
  reasoning_effort?: string
  [key: string]: unknown
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null

export interface UsageCounts {
  promptTokens: number
  completionTokens: number
}

export function textOfContent(content: ChatMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('')
}

export function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || p.type === 'input_image'))
}

export function chatChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finishReason: FinishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

export function usageChunk(id: string, model: string, created: number, usage: UsageCounts) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: toChatUsage(usage),
  }
}

export function toChatUsage(u: UsageCounts): ChatUsage {
  return { prompt_tokens: u.promptTokens, completion_tokens: u.completionTokens, total_tokens: u.promptTokens + u.completionTokens }
}
