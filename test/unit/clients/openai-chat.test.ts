import { describe, it, expect } from 'vitest';
import { OpenAIChatSerializer } from '../../../src/clients/openai-chat.js';
import type { IRRequest, IRResponse, IRTextContent, IRToolUse } from '../../../src/ir/types.js';

const s = new OpenAIChatSerializer();

function req(): IRRequest {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' } as IRTextContent] },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ],
    stream: false,
  };
}

function resp(): IRResponse {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-4o-internal',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
      finishReason: 'stop',
    }],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedTokens: 0 },
    finishReason: 'stop',
  };
}

describe('OpenAIChatSerializer.parseIncomingRequest', () => {
  it('round-trips system + user', () => {
    const ir = s.parseIncomingRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect(ir.model).toBe('gpt-4o');
    expect(ir.messages).toHaveLength(2);
    expect(ir.messages[0]?.role).toBe('system');
  });

  it('rejects missing model', () => {
    expect(() => s.parseIncomingRequest({ messages: [{ role: 'user', content: 'x' }] })).toThrow();
  });

  it('parses tool_calls and tool role', () => {
    const ir = s.parseIncomingRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'ok' },
      ],
    });
    const a = ir.messages[1]?.content[0] as IRToolUse;
    expect(a.type).toBe('tool_use');
    if (a.type === 'tool_use') expect(a.arguments).toEqual({ x: 1 });
    const t = ir.messages[2];
    expect(t?.role).toBe('tool');
  });

  it('maps tool_choice string and object form', () => {
    expect(s.parseIncomingRequest({ model: 'm', messages: [{ role: 'user', content: 'q' }], tool_choice: 'none' }).toolChoice).toBe('none');
    expect(s.parseIncomingRequest({ model: 'm', messages: [{ role: 'user', content: 'q' }], tool_choice: { type: 'function', function: { name: 'f' } } }).toolChoice).toEqual({ name: 'f' });
  });
});

describe('OpenAIChatSerializer.serializeResponse', () => {
  it('builds the chat.completion object', () => {
    const r = s.serializeResponse(resp(), { model: 'gpt-4o', upstreamModel: 'gpt-4o-internal', latencyMs: 42 }) as Record<string, unknown>;
    expect(r['object']).toBe('chat.completion');
    const choices = r['choices'] as Array<{ message: { content: string }; finish_reason: string }>;
    expect(choices[0]?.message.content).toBe('Hello!');
    expect(choices[0]?.finish_reason).toBe('stop');
  });
  it('emits tool_calls when choice has tool_use', () => {
    const r: IRResponse = {
      id: 'x', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', arguments: { y: 2 } }] }, finishReason: 'tool_calls' }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 },
      finishReason: 'tool_calls',
    };
    const r2 = s.serializeResponse(r, { model: 'm', upstreamModel: 'm', latencyMs: 1 }) as Record<string, unknown>;
    const choices = r2['choices'] as Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
    expect(choices[0]?.message.tool_calls[0]?.function.arguments).toBe('{"y":2}');
  });
});

describe('OpenAIChatSerializer stream', () => {
  it('emits [DONE] as terminal', () => {
    expect(s.terminalStreamEvent()?.data).toBe('[DONE]');
  });
  it('encodes text delta and tool delta', () => {
    const a = s.serializeStreamEvent({ textDelta: 'hel' }, { responseId: 'r1', model: 'm', done: false });
    expect((a?.data as { choices: Array<{ delta: { content: string } }> }).choices[0]?.delta.content).toBe('hel');
    const b = s.serializeStreamEvent({ toolUseDelta: { id: 't1', name: 'f', argumentsDelta: '{"a":' } }, { responseId: 'r1', model: 'm', done: false });
    const d = (b?.data as { choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }> }).choices[0]?.delta.tool_calls[0]?.function;
    expect(d?.arguments).toBe('{"a":');
  });
});
