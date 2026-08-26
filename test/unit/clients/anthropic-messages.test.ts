import { describe, it, expect } from 'vitest';
import { AnthropicMessagesSerializer } from '../../../src/clients/anthropic-messages.js';
import type { IRResponse, IRTextContent, IRThinking } from '../../../src/ir/types.js';

const s = new AnthropicMessagesSerializer();

describe('AnthropicMessagesSerializer.parseIncomingRequest', () => {
  it('parses system + messages', () => {
    const ir = s.parseIncomingRequest({
      model: 'claude-3-5-sonnet',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
    expect(ir.messages[0]?.role).toBe('system');
    expect(ir.maxTokens).toBe(100);
  });
  it('parses content blocks including tool_use, tool_result, thinking', () => {
    const ir = s.parseIncomingRequest({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { y: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      ],
    });
    expect(ir.messages[1]?.content[0]?.type).toBe('tool_use');
    expect(ir.messages[2]?.content[0]?.type).toBe('tool_result');
    expect(ir.messages[3]?.content[0]?.type).toBe('thinking');
  });
  it('maps tool_choice any -> required, tool -> {name}', () => {
    const a = s.parseIncomingRequest({ model: 'm', messages: [{ role: 'user', content: 'q' }], tool_choice: { type: 'any' } });
    expect(a.toolChoice).toBe('required');
    const b = s.parseIncomingRequest({ model: 'm', messages: [{ role: 'user', content: 'q' }], tool_choice: { type: 'tool', name: 'f' } });
    expect(b.toolChoice).toEqual({ name: 'f' });
  });
});

describe('AnthropicMessagesSerializer.serializeResponse', () => {
  const r: IRResponse = {
    id: 'msg_1', model: 'claude-3-5-sonnet-internal',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'f', arguments: { z: 3 } },
        ],
      },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 },
    finishReason: 'tool_calls',
  };
  it('builds content[] with text + tool_use and stop_reason tool_use', () => {
    const out = s.serializeResponse(r, { model: 'claude-3-5-sonnet', upstreamModel: 'claude-3-5-sonnet-internal', latencyMs: 1 }) as Record<string, unknown>;
    expect(out['type']).toBe('message');
    const c = out['content'] as Array<{ type: string }>;
    expect(c.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(out['stop_reason']).toBe('tool_use');
  });
});

describe('AnthropicMessagesSerializer stream', () => {
  it('emits content_block_start + delta for first text', () => {
    const a = s.serializeStreamEvent({ textDelta: 'a' }, { responseId: 'r1', model: 'm', done: false });
    expect(a?.event).toBe('content_block_start');
    const b = s.serializeStreamEvent({ textDelta: 'b' }, { responseId: 'r1', model: 'm', outputItemId: 't1', done: false });
    expect(b?.event).toBe('content_block_delta');
  });
  it('emits message_delta on finish', () => {
    const ev = s.serializeStreamEvent({ finishReason: 'stop' }, { responseId: 'r1', model: 'm', done: false });
    expect(ev?.event).toBe('message_delta');
  });
  it('terminal is message_stop', () => {
    expect(s.terminalStreamEvent()?.event).toBe('message_stop');
  });
});
