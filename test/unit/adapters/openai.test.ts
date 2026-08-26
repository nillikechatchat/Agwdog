import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from '../../../src/adapters/openai.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';

function req(over: Partial<IRRequest> = {}): IRRequest {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' } as IRTextContent] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    stream: false,
    ...over,
  };
}

describe('OpenAIAdapter.buildRequestBody', () => {
  const a = new OpenAIAdapter();

  it('maps system+user to OpenAI messages', () => {
    const env = a.buildRequestBody(req());
    const body = env.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    expect(env.stream).toBe(false);
  });

  it('emits stream: true when IR.stream is true', () => {
    const env = a.buildRequestBody(req({ stream: true }));
    expect((env.body as { stream: boolean }).stream).toBe(true);
  });

  it('maps tool calls on assistant messages', () => {
    const ir = req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'sunny' }],
        },
      ],
    });
    const env = a.buildRequestBody(ir);
    const body = env.body as { messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }> };
    expect(body.messages[1]?.tool_calls).toBeDefined();
    expect(body.messages[2]?.role).toBe('tool');
    expect(body.messages[2]?.tool_call_id).toBe('call_1');
  });

  it('maps tools and tool_choice', () => {
    const ir = req({
      tools: [{ name: 'get_weather', description: 'look up weather', parameters: { type: 'object' } }],
      toolChoice: { name: 'get_weather' },
    });
    const env = a.buildRequestBody(ir);
    const body = env.body as { tools: Array<{ type: string; function: { name: string } }>; tool_choice: { type: string } };
    expect(body.tools[0]?.function.name).toBe('get_weather');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('passes through temperature, top_p, max_tokens, stop, response_format', () => {
    const ir = req({ temperature: 0.2, topP: 0.9, maxTokens: 512, stopSequences: { stop: ['\n'] }, responseFormat: { kind: 'json_object' } });
    const env = a.buildRequestBody(ir);
    const body = env.body as Record<string, unknown>;
    expect(body['temperature']).toBe(0.2);
    expect(body['top_p']).toBe(0.9);
    expect(body['max_tokens']).toBe(512);
    expect(body['stop']).toEqual(['\n']);
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });
});

describe('OpenAIAdapter.buildRequestHeaders', () => {
  const a = new OpenAIAdapter();

  it('sets content-type and Authorization: Bearer', () => {
    const h = a.buildRequestHeaders(req(), 'sk-test');
    expect(h['content-type']).toBe('application/json');
    expect(h['authorization']).toBe('Bearer sk-test');
  });
});

describe('OpenAIAdapter.parseResponse', () => {
  const a = new OpenAIAdapter();

  it('parses a text-only response', () => {
    const raw = {
      id: 'chatcmpl-1',
      model: 'gpt-4o-2024-08-06',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const r = a.parseResponse(raw, req());
    expect(r.id).toBe('chatcmpl-1');
    expect(r.choices[0]?.message.content[0]).toEqual({ type: 'text', text: 'Hi there' });
    expect(r.usage.promptTokens).toBe(5);
    expect(r.usage.completionTokens).toBe(2);
    expect(r.usage.totalTokens).toBe(7);
    expect(r.finishReason).toBe('stop');
  });

  it('parses a tool_calls response', () => {
    const raw = {
      id: 'chatcmpl-2',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const r = a.parseResponse(raw, req());
    const tu = r.choices[0]?.message.content[0];
    expect(tu?.type).toBe('tool_use');
    if (tu?.type === 'tool_use') {
      expect(tu.name).toBe('f');
      expect(tu.arguments).toEqual({ x: 1 });
    }
    expect(r.finishReason).toBe('tool_calls');
  });

  it('reads cached_tokens from prompt_tokens_details', () => {
    const raw = {
      id: 'x', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
    };
    const r = a.parseResponse(raw, req());
    expect(r.usage.cachedTokens).toBe(4);
  });
});

describe('OpenAIAdapter.parseStreamEvent', () => {
  const a = new OpenAIAdapter();

  it('extracts textDelta from a content delta', () => {
    const ev = a.parseStreamEvent({
      id: 'x',
      choices: [{ delta: { content: 'hello ' } }],
    }, req());
    expect(ev?.textDelta).toBe('hello ');
  });

  it('extracts toolUseDelta', () => {
    const ev = a.parseStreamEvent({
      choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"' } }] } }],
    }, req());
    expect(ev?.toolUseDelta).toEqual({ id: 'call_1', name: 'f', argumentsDelta: '{"' });
  });

  it('extracts finishReason and usageDelta', () => {
    const ev = a.parseStreamEvent({
      choices: [{ finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }, req());
    expect(ev?.finishReason).toBe('length');
    expect(ev?.usageDelta).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
  });
});
