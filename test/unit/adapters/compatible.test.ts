import { describe, it, expect } from 'vitest';
import { OpenAICompatibleAdapter, DoubaoAdapter, WenxinAdapter } from '../../../src/adapters/index.js';
import { createAdapter } from '../../../src/adapters/index.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';

function req(over: Partial<IRRequest> = {}): IRRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' } as IRTextContent] }],
    stream: false,
    ...over,
  };
}

describe('OpenAICompatibleAdapter', () => {
  it('inherits OpenAI body shape', () => {
    const a = new OpenAICompatibleAdapter();
    const env = a.buildRequestBody(req());
    expect((env.body as { model: string }).model).toBe('gpt-4o');
  });
  it('honors pathOverride and headerExtras', () => {
    const a = new OpenAICompatibleAdapter({ pathOverride: '/v2/chat', headerExtras: { 'X-Tenant': 'foo' } });
    expect(a.endpointPath(req())).toBe('/v2/chat');
    const h = a.buildRequestHeaders(req(), 'sk');
    expect(h['X-Tenant']).toBe('foo');
  });
});

describe('DoubaoAdapter', () => {
  it('uses default OpenAI auth', () => {
    const a = new DoubaoAdapter();
    const h = a.buildRequestHeaders(req(), 'ark-key');
    expect(h['authorization']).toBe('Bearer ark-key');
  });
});

describe('WenxinAdapter', () => {
  it('uses the /v2/chat/completions path', () => {
    const a = new WenxinAdapter();
    expect(a.endpointPath(req())).toBe('/v2/chat/completions');
  });
  it('collapses system/developer into the first user turn', () => {
    const a = new WenxinAdapter();
    const env = a.buildRequestBody(req({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
    }));
    const body = env.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content.startsWith('SYS\nHello')).toBe(true);
  });
  it('creates a synthetic user turn when no user message exists', () => {
    const a = new WenxinAdapter();
    const env = a.buildRequestBody(req({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'ONLY' }] }],
    }));
    const body = env.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.content).toBe('ONLY');
  });
});

describe('createAdapter factory', () => {
  it('returns the right adapter for each protocol', () => {
    expect(createAdapter('OpenAI').constructor.name).toBe('OpenAIAdapter');
    expect(createAdapter('OpenAI-Compatible').constructor.name).toBe('OpenAICompatibleAdapter');
    expect(createAdapter('Anthropic').constructor.name).toBe('AnthropicAdapter');
    expect(createAdapter('Gemini').constructor.name).toBe('GeminiAdapter');
    expect(createAdapter('Doubao').constructor.name).toBe('DoubaoAdapter');
    expect(createAdapter('Wenxin').constructor.name).toBe('WenxinAdapter');
  });
});
