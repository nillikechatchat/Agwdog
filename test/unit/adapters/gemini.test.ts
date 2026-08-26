import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../../../src/adapters/gemini.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';

function req(over: Partial<IRRequest> = {}): IRRequest {
  return {
    model: 'gemini-1.5-pro',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' } as IRTextContent] },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ],
    stream: false,
    ...over,
  };
}

describe('GeminiAdapter.buildRequestBody', () => {
  const a = new GeminiAdapter();

  it('separates system from contents and assigns model/user roles', () => {
    const env = a.buildRequestBody(req());
    const body = env.body as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.systemInstruction.parts[0]?.text).toBe('You are helpful.');
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]?.role).toBe('user');
  });

  it('emits generationConfig when temperature / maxTokens set', () => {
    const env = a.buildRequestBody(req({ temperature: 0.1, maxTokens: 256 }));
    const body = env.body as { generationConfig: { temperature: number; maxOutputTokens: number } };
    expect(body.generationConfig.temperature).toBe(0.1);
    expect(body.generationConfig.maxOutputTokens).toBe(256);
  });

  it('maps tool calls into functionCall parts', () => {
    const ir = req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', arguments: { x: 1 } }] },
      ],
      tools: [{ name: 'f', parameters: { type: 'object' } }],
    });
    const env = a.buildRequestBody(ir);
    const body = env.body as { contents: Array<{ parts: Array<Record<string, unknown>> }>; tools: Array<{ functionDeclarations: Array<{ name: string }> }> };
    const parts = body.contents[1]?.parts;
    expect(parts?.[0]?.['functionCall']).toBeDefined();
    expect(body.tools[0]?.functionDeclarations[0]?.name).toBe('f');
  });
});

describe('GeminiAdapter.endpointPath', () => {
  const a = new GeminiAdapter();
  it('encodes the model in the path', () => {
    expect(a.endpointPath(req())).toBe('/v1beta/models/gemini-1.5-pro:generateContent');
  });
});

describe('GeminiAdapter.parseResponse', () => {
  const a = new GeminiAdapter();

  it('parses a text candidate', () => {
    const r = a.parseResponse({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
      ],
      modelVersion: 'gemini-1.5-pro',
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }, req());
    expect(r.choices[0]?.message.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(r.usage.promptTokens).toBe(5);
    expect(r.finishReason).toBe('stop');
  });

  it('maps a functionCall to a tool_use IR', () => {
    const r = a.parseResponse({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
          finishReason: 'STOP',
        },
      ],
    }, req());
    const tu = r.choices[0]?.message.content[0];
    expect(tu?.type).toBe('tool_use');
    if (tu?.type === 'tool_use') {
      expect(tu.name).toBe('f');
      expect(tu.arguments).toEqual({ x: 1 });
    }
  });
});

describe('GeminiAdapter.parseStreamEvent', () => {
  const a = new GeminiAdapter();
  it('extracts text and thought deltas', () => {
    const ev = a.parseStreamEvent({
      candidates: [{ content: { role: 'model', parts: [{ text: 'abc' }, { thought: 'def' }] } }],
    }, req());
    expect(ev?.textDelta).toBe('abc');
    expect(ev?.thinkingDelta?.text).toBe('def');
  });
});
