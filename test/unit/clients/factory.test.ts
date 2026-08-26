import { describe, it, expect } from 'vitest';
import { createClientSerializer } from '../../../src/clients/index.js';
import { SerializerError } from '../../../src/clients/index.js';

describe('createClientSerializer', () => {
  it('returns the right serializer for each protocol', () => {
    expect(createClientSerializer('OpenAI-Chat').constructor.name).toBe('OpenAIChatSerializer');
    expect(createClientSerializer('OpenAI-Responses').constructor.name).toBe('OpenAIResponsesSerializer');
    expect(createClientSerializer('Anthropic-Messages').constructor.name).toBe('AnthropicMessagesSerializer');
    expect(createClientSerializer('Gemini-GenerateContent').constructor.name).toBe('GeminiSerializer');
  });
  it('SerializerError carries the protocol prefix', () => {
    const e = new SerializerError('Foo', 'bad');
    expect(e.message).toContain('[Foo]');
    expect(e.protocol).toBe('Foo');
  });
});
