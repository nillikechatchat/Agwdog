import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../../src/adapters/anthropic.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';

function req(over: Partial<IRRequest> = {}): IRRequest {
  return {
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' } as IRTextContent] },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ],
    stream: false,
    ...over,
  };
}

describe('AnthropicAdapter.buildRequestBody', () => {
  const a = new AnthropicAdapter();

  it('collects system into top-level field, leaves user messages intact', () => {
    const env = a.buildRequestBody(req());
    const body = env.body as { system: Array<{ text: string }>; messages: Array<{ role: string }>; max_tokens: number };
    expect(body.system[0]?.text).toBe('You are helpful.');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.max_tokens).toBe(4096);
  });

  it('maps tool_use blocks on assistant messages', () => {
    const ir = req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'f', arguments: { x: 1 } }],
        },
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 't1', content: 'r' }] },
      ],
    });
    const env = a.buildRequestBody(ir);
    const body = env.body as { messages: Array<{ role: string; content: unknown }> };
    const assistant = body.messages[1]!;
    const blocks = assistant.content as Array<{ type: string; id?: string; name?: string }>;
    expect(blocks[0]?.type).toBe('tool_use');
    expect(blocks[0]?.id).toBe('t1');
    expect(blocks[0]?.name).toBe('f');
  });

  it('emits thinking block when reasoning.budgetTokens set', () => {
    const env = a.buildRequestBody(req({ reasoning: { budgetTokens: 1024 } }));
    const body = env.body as { thinking: { type: string; budget_tokens: number } };
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
});

describe('AnthropicAdapter.parseResponse', () => {
  const a = new AnthropicAdapter();

  it('parses a text response', () => {
    const r = a.parseResponse({
      id: 'msg_1', model: 'claude-3-5-sonnet',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(r.choices[0]?.message.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(r.usage.promptTokens).toBe(3);
    expect(r.finishReason).toBe('stop');
  });

  it('parses thinking + tool_use response', () => {
    const r = a.parseResponse({
      id: 'msg_2', model: 'claude-3-5-sonnet',
      content: [
        { type: 'thinking', thinking: '...', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } },
      ],
      stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 2 },
    });
    const content = r.choices[0]?.message.content;
    expect(content?.[0]?.type).toBe('thinking');
    expect(content?.[1]?.type).toBe('tool_use');
    expect(r.usage.cachedTokens).toBe(2);
    expect(r.finishReason).toBe('tool_calls');
  });
});

describe('AnthropicAdapter.parseStreamEvent', () => {
  const a = new AnthropicAdapter();

  it('handles content_block_delta text', () => {
    const ev = a.parseStreamEvent({ type: 'content_block_delta', delta: { delta: { text: 'hi' } } });
    expect(ev?.textDelta).toBe('hi');
  });

  it('handles content_block_delta thinking', () => {
    const ev = a.parseStreamEvent({ type: 'content_block_delta', delta: { delta: { thinking: 'think' } } });
    expect(ev?.thinkingDelta?.text).toBe('think');
  });

  it('handles message_start with usage', () => {
    const ev = a.parseStreamEvent({ type: 'message_start', message: { id: 'msg_x', usage: { input_tokens: 4, output_tokens: 1 } } });
    expect(ev?.responseId).toBe('msg_x');
    expect(ev?.usageDelta?.promptTokens).toBe(4);
  });

  it('handles message_delta stop_reason', () => {
    const ev = a.parseStreamEvent({ type: 'message_delta', stop_reason: 'end_turn' });
    expect(ev?.finishReason).toBe('stop');
  });
});

describe('AnthropicAdapter.buildRequestHeaders', () => {
  const a = new AnthropicAdapter();
  it('sets x-api-key + anthropic-version', () => {
    const h = a.buildRequestHeaders(req(), 'sk-ant-test');
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
  });
});
