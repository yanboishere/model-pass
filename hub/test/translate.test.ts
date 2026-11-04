import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { anthropicCaps, chatToAnthropic } from '../src/relay/anthropic'
import { chatToResponses } from '../src/relay/responses'

describe('anthropic capability heuristics', () => {
  it('drops sampling params on models that reject them', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-opus-4-8']) {
      assert.equal(anthropicCaps.sampling(m), false, m)
    }
    for (const m of ['claude-sonnet-4-6', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'deepseek-flash', 'mock-claude-opus']) {
      assert.equal(anthropicCaps.sampling(m), true, m)
    }
  })
  it('avoids forced tool choice where it is rejected', () => {
    assert.equal(anthropicCaps.forcedToolChoice('claude-opus-5-5'), false)
    assert.equal(anthropicCaps.forcedToolChoice('claude-sonnet-5-5'), false)
    assert.equal(anthropicCaps.forcedToolChoice('claude-fable-5-1'), false)
    assert.equal(anthropicCaps.forcedToolChoice('claude-opus-5'), true)
    assert.equal(anthropicCaps.forcedToolChoice('claude-haiku-4-5'), true)
  })
})

describe('chat → anthropic request', () => {
  it('maps system, images, tools, merging and defaults', () => {
    const body = chatToAnthropic(
      {
        model: 'default',
        temperature: 0.7,
        reasoning_effort: 'high',
        tool_choice: 'required',
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
        messages: [
          { role: 'system', content: 'S1' },
          { role: 'developer', content: 'S2' },
          { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
          { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
          { role: 'tool', tool_call_id: 't1', content: 'r1' },
          { role: 'user', content: 'and?' },
        ],
      },
      'claude-opus-5-5',
      'g_test',
    ) as Record<string, any>
    assert.equal(body.system, 'S1\n\nS2')
    assert.equal(body.temperature, undefined)
    assert.deepEqual(body.output_config, { effort: 'high' })
    assert.deepEqual(body.tool_choice, { type: 'auto' })
    assert.equal(body.max_tokens, 16000)
    assert.equal(body.messages.length, 3)
    assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } })
    assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } })
    assert.equal(body.messages[2].content[0].type, 'tool_result')
    assert.equal(body.messages[2].content[1].text, 'and?')
  })
})

describe('chat → responses request', () => {
  it('forces store:false / stream:true and drops sampling', () => {
    const body = chatToResponses({ model: 'x', temperature: 1, max_tokens: 9, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] }, 'gpt-5.5') as Record<string, any>
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    assert.equal(body.temperature, undefined)
    assert.equal(body.max_output_tokens, undefined)
    assert.equal(body.instructions, 'S')
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })
})
