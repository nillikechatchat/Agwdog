import { describe, it, expect } from 'vitest';
import { OpenAIResponsesSerializer } from '../../../src/clients/openai-responses.js';
import type { IRResponse, IRTextContent } from '../../../src/ir/types.js';

const s = new OpenAIResponsesSerializer();

describe('OpenAIResponsesSerializer.parseIncomingRequest', () => {
  it('parses input[] with role+content', () => {
    const ir = s.parseIncomingRequest({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0]?.role).toBe('user');
  });
  it('hoists instructions into a leading system message', () => {
    const ir = s.parseIncomingRequest({
      model: 'gpt-5',
      instructions: 'be brief',
      input: 'hi',
    });
    expect(ir.messages[0]?.role).toBe('system');
    expect(ir.messages[1]?.role).toBe('user');
  });
  it('accepts string input', () => {
    const ir = s.parseIncomingRequest({ model: 'gpt-5', input: 'hello' });
    expect(ir.messages[0]?.content[0]).toEqual({ type: 'text', text: 'hello' });
  });
  it('rejects missing input', () => {
    expect(() => s.parseIncomingRequest({ model: 'gpt-5' })).toThrow();
  });
});

describe('OpenAIResponsesSerializer.serializeResponse', () => {
  const r: IRResponse = {
    id: 'resp_1',
    model: 'gpt-5-internal',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      finishReason: 'stop',
    }],
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, cachedTokens: 0 },
    finishReason: 'stop',
  };
  it('emits response object with output[] items', () => {
    const out = s.serializeResponse(r, { model: 'gpt-5', upstreamModel: 'gpt-5-internal', latencyMs: 1 }) as Record<string, unknown>;
    expect(out['object']).toBe('response');
    const output = out['output'] as Array<{ type: string; content: Array<{ type: string; text?: string }> }>;
    expect(output[0]?.type).toBe('message');
    expect(output[0]?.content[0]?.text).toBe('ok');
  });
});

describe('OpenAIResponsesSerializer stream', () => {
  it('emits output_text.delta', () => {
    const ev = s.serializeStreamEvent({ textDelta: 'a' }, { responseId: 'r1', model: 'm', done: false });
    expect(ev?.event).toBe('response.output_text.delta');
  });
  it('emits function_call_arguments.delta', () => {
    const ev = s.serializeStreamEvent({ toolUseDelta: { id: 't1', argumentsDelta: '{"x":' } }, { responseId: 'r1', model: 'm', done: false });
    expect(ev?.event).toBe('response.function_call_arguments.delta');
  });
  it('emits response.completed on finish', () => {
    const ev = s.serializeStreamEvent({ finishReason: 'stop' }, { responseId: 'r1', model: 'm', done: false });
    expect(ev?.event).toBe('response.completed');
  });
  it('terminal event is response.done', () => {
    expect(s.terminalStreamEvent()?.event).toBe('response.done');
  });
});
