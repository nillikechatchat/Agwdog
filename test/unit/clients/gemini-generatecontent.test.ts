import { describe, it, expect } from 'vitest';
import { GeminiSerializer } from '../../../src/clients/gemini-generatecontent.js';
import type { IRResponse, IRTextContent } from '../../../src/ir/types.js';

const s = new GeminiSerializer();

describe('GeminiSerializer.parseIncomingRequest', () => {
  it('parses systemInstruction + contents', () => {
    const ir = s.parseIncomingRequest({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(ir.messages[0]?.role).toBe('system');
    expect(ir.messages[1]?.role).toBe('user');
  });
  it('maps functionCall/functionResponse to tool_use/tool_result', () => {
    const ir = s.parseIncomingRequest({
      contents: [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
      ],
    });
    expect(ir.messages[1]?.content[0]?.type).toBe('tool_use');
    expect(ir.messages[2]?.content[0]?.type).toBe('tool_result');
  });
  it('maps toolConfig NONE -> none', () => {
    const ir = s.parseIncomingRequest({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    expect(ir.toolChoice).toBe('none');
  });
  it('maps generationConfig to temperature/topP/maxTokens/stop', () => {
    const ir = s.parseIncomingRequest({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 50, stopSequences: ['\n\n'] },
    });
    expect(ir.temperature).toBe(0.2);
    expect(ir.topP).toBe(0.9);
    expect(ir.maxTokens).toBe(50);
    expect(ir.stopSequences?.stop).toEqual(['\n\n']);
  });
});

describe('GeminiSerializer.serializeResponse', () => {
  const r: IRResponse = {
    id: 'gem_1', model: 'gemini-1.5-pro-internal',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      finishReason: 'stop',
    }],
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, cachedTokens: 0 },
    finishReason: 'stop',
  };
  it('emits candidates[] + usageMetadata', () => {
    const out = s.serializeResponse(r, { model: 'gemini-1.5-pro', upstreamModel: 'gemini-1.5-pro-internal', latencyMs: 1 }) as Record<string, unknown>;
    const cands = out['candidates'] as Array<{ content: { parts: Array<{ text: string }> }; finishReason: string }>;
    expect(cands[0]?.content.parts[0]?.text).toBe('ok');
    expect(cands[0]?.finishReason).toBe('STOP');
    const u = out['usageMetadata'] as { promptTokenCount: number };
    expect(u.promptTokenCount).toBe(2);
  });
  it('maps length -> MAX_TOKENS', () => {
    const long: IRResponse = { ...r, choices: [{ ...r.choices[0]!, finishReason: 'length' }], finishReason: 'length' };
    const out = s.serializeResponse(long, { model: 'm', upstreamModel: 'm', latencyMs: 1 }) as Record<string, unknown>;
    const c = (out['candidates'] as Array<{ finishReason: string }>)[0];
    expect(c?.finishReason).toBe('MAX_TOKENS');
  });
});

describe('GeminiSerializer stream', () => {
  it('emits candidates[] with text part on text delta', () => {
    const ev = s.serializeStreamEvent({ textDelta: 'a' }, { responseId: 'r1', model: 'm', done: false });
    const d = ev?.data as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    expect(d.candidates[0]?.content.parts[0]?.text).toBe('a');
  });
  it('no terminal event (Gemini ends with empty candidate chunk)', () => {
    expect(s.terminalStreamEvent()).toBeNull();
  });
});
