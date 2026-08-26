import { describe, it, expect } from 'vitest';

import {
  canonicalJSON,
  emptyIRRequest,
  estimateTokens,
  fingerprint,
  normalizeMessage,
  normalizeMessages,
  textMsg,
  toolResultMsg,
  type FingerprintInput,
} from '@/ir/normalize.js';
import type { IRMessage, IRRequest } from '@/ir/types.js';

describe('emptyIRRequest', () => {
  it('returns a known empty request shape', () => {
    const req = emptyIRRequest();
    expect(req.model).toBe('');
    expect(req.messages).toEqual([]);
    expect(req.stream).toBe(false);
  });
});

describe('normalizeMessage', () => {
  it('drops empty text fragments', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'hello' }] } as IRMessage;
    const out = normalizeMessage(msg);
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('collapses internal whitespace in text content', () => {
    const msg = textMsg('user', 'a\n\n  b\t\tc   d');
    const out = normalizeMessage(msg);
    expect((out.content[0] as { text: string }).text).toBe('a b c d');
  });

  it('preserves non-text content untouched', () => {
    const msg: IRMessage = {
      role: 'user',
      content: [{ type: 'image', source: { kind: 'url', url: 'https://x/y.png' } }],
    };
    const out = normalizeMessage(msg);
    expect(out.content[0]).toEqual({ type: 'image', source: { kind: 'url', url: 'https://x/y.png' } });
  });
});

describe('normalizeMessages', () => {
  it('merges adjacent system/developer into a single system message', () => {
    const msgs: IRMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
      { role: 'developer', content: [{ type: 'text', text: 'no emojis' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const out = normalizeMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('system');
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'be terse' },
      { type: 'text', text: 'no emojis' },
    ]);
    expect(out[1]?.role).toBe('user');
  });

  it('does not merge developer messages separated by user/assistant turns', () => {
    const msgs: IRMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ];
    const out = normalizeMessages(msgs);
    // Developer gets emitted as its own "system" message after the first user message.
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'user']);
  });
});

describe('canonicalJSON', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalJSON({ b: 1, a: 2 });
    const b = canonicalJSON({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalJSON({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([{ b: 2 }, { a: 1 }])).toBe('[{"b":2},{"a":1}]');
  });
});

describe('fingerprint — stability', () => {
  const baseReq: FingerprintInput = {
    model: 'gpt-4o',
    messages: [textMsg('user', 'hi')],
  };

  it('returns a 64-char hex string', () => {
    const fp = fingerprint(baseReq);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is identical across calls for the same input', () => {
    expect(fingerprint(baseReq)).toBe(fingerprint(baseReq));
  });

  it('is identical when object key order is reversed', () => {
    const a: FingerprintInput = {
      model: 'gpt-4o',
      messages: [textMsg('user', 'hi')],
      temperature: 0.7,
      topP: 0.9,
    };
    const b: FingerprintInput = {
      topP: 0.9,
      messages: [textMsg('user', 'hi')],
      temperature: 0.7,
      model: 'gpt-4o',
    };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe('fingerprint — anti-collision', () => {
  it('changes when model id changes', () => {
    const base = { model: 'gpt-4o', messages: [textMsg('user', 'hi')] };
    const other = { ...base, model: 'gpt-4o-mini' };
    expect(fingerprint(base)).not.toBe(fingerprint(other));
  });

  it('changes when a single message text changes', () => {
    const a = { model: 'gpt-4o', messages: [textMsg('user', 'hi')] };
    const b = { model: 'gpt-4o', messages: [textMsg('user', 'hi there')] };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when message order changes', () => {
    const a = { model: 'gpt-4o', messages: [textMsg('user', 'a'), textMsg('assistant', 'b')] };
    const b = { model: 'gpt-4o', messages: [textMsg('assistant', 'b'), textMsg('user', 'a')] };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when temperature differs', () => {
    const a = { model: 'm', messages: [textMsg('user', 'x')], temperature: 0 };
    const b = { model: 'm', messages: [textMsg('user', 'x')], temperature: 0.7 };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when a tool definition changes', () => {
    const base: FingerprintInput = {
      model: 'm',
      messages: [textMsg('user', 'x')],
      tools: [{ name: 'search', description: 'web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    };
    const other: FingerprintInput = {
      ...base,
      tools: [{ name: 'search', description: 'web', parameters: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } } } }],
    };
    expect(fingerprint(base)).not.toBe(fingerprint(other));
  });

  it('changes when tool_choice changes', () => {
    const base: FingerprintInput = { model: 'm', messages: [textMsg('user', 'x')], tools: [{ name: 'search', parameters: { type: 'object' } }] };
    const a: FingerprintInput = { ...base, toolChoice: 'auto' };
    const b: FingerprintInput = { ...base, toolChoice: { name: 'search' } };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when response_format kind changes', () => {
    const base = { model: 'm', messages: [textMsg('user', 'x')], responseFormat: { kind: 'text' as const } };
    const other = { ...base, responseFormat: { kind: 'json_object' as const } };
    expect(fingerprint(base)).not.toBe(fingerprint(other));
  });

  it('treats whitespace-only message changes as identical', () => {
    const a = { model: 'm', messages: [textMsg('user', 'hello   world')] };
    const b = { model: 'm', messages: [textMsg('user', 'hello world')] };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('normalises system and developer messages into the same fingerprint', () => {
    const sys = { model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] } as IRMessage, textMsg('user', 'hi')] };
    const dev = { model: 'm', messages: [{ role: 'developer', content: [{ type: 'text', text: 'be terse' }] } as IRMessage, textMsg('user', 'hi')] };
    expect(fingerprint(sys)).toBe(fingerprint(dev));
  });

  it('ignores tool_result `name` field noise', () => {
    const a: FingerprintInput = {
      model: 'm',
      messages: [toolResultMsg('call_1', 'result')],
    };
    const b: FingerprintInput = {
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call_1',
              content: 'result',
              isError: false,
            },
          ],
        },
      ],
    };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('seed parameter participates in fingerprint', () => {
    const a = { model: 'm', messages: [textMsg('user', 'x')], seed: 1 };
    const b = { model: 'm', messages: [textMsg('user', 'x')], seed: 2 };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('estimateTokens', () => {
  it('returns 0 for an empty request', () => {
    expect(estimateTokens({ messages: [] })).toBe(0);
  });

  it('divides text length by charsPerToken (default 4)', () => {
    const req: Pick<IRRequest, 'messages'> = { messages: [textMsg('user', 'a'.repeat(80))] };
    expect(estimateTokens(req)).toBe(20);
  });

  it('respects custom charsPerToken', () => {
    const req: Pick<IRRequest, 'messages'> = { messages: [textMsg('user', 'a'.repeat(100))] };
    expect(estimateTokens(req, { charsPerToken: 5 })).toBe(20);
  });

  it('estimates tool_use JSON and tool_result text', () => {
    const req: Pick<IRRequest, 'messages'> = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'c1', name: 'search', arguments: { q: 'a'.repeat(40) } },
          ],
        },
        toolResultMsg('c1', 'b'.repeat(40)),
      ],
    };
    // tool_use JSON = {"q":"<40 a's>"} = 11 + 40 = 51 chars → 51/4 = 12
    // tool_result text = 40 chars → 40/4 = 10
    expect(estimateTokens(req)).toBe(22);
  });
});