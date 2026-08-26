import { describe, it, expect, vi } from 'vitest';
import { HttpProviderConnector } from '../../../src/connector/http-connector.js';
import type { IRRequest, IRTextContent } from '../../../src/ir/types.js';
import { OpenAIAdapter } from '../../../src/adapters/openai.js';

function req(): IRRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' } as IRTextContent] }],
    stream: false,
  };
}

function makeFetch(seq: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let i = 0;
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const entry = seq[Math.min(i, seq.length - 1)]!;
    i += 1;
    const headers = new Headers(entry.headers);
    return new Response(typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body), {
      status: entry.status,
      headers,
    });
  });
}

describe('HttpProviderConnector.call', () => {
  it('returns success on first try', async () => {
    const fetch = makeFetch([{ status: 200, body: { id: 'r1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }]);
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 } });
    const out = await c.call(new OpenAIAdapter(), req(), 'sk', 'https://api.openai.com');
    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.response.choices[0]?.message.content[0]).toEqual({ type: 'text', text: 'ok' });
      expect(out.status).toBe(200);
    }
  });

  it('retries on 500 then succeeds', async () => {
    const fetch = makeFetch([
      { status: 500, body: { error: 'oops' } },
      { status: 200, body: { id: 'r2', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },
    ]);
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 } });
    const out = await c.call(new OpenAIAdapter(), req(), 'sk', 'https://api.openai.com');
    expect(out.kind).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 400', async () => {
    const fetch = makeFetch([{ status: 400, body: { error: 'bad' } }]);
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 } });
    const out = await c.call(new OpenAIAdapter(), req(), 'sk', 'https://api.openai.com');
    expect(out.kind).toBe('http_error');
    if (out.kind === 'http_error') expect(out.retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After header', async () => {
    const fetch = makeFetch([
      { status: 429, body: { error: 'rate' }, headers: { 'retry-after': '1' } },
      { status: 200, body: { id: 'r3', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },
    ]);
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 5000, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10_000, multiplier: 1, jitterMs: 0 } });
    const t0 = Date.now();
    const out = await c.call(new OpenAIAdapter(), req(), 'sk', 'https://api.openai.com');
    const elapsed = Date.now() - t0;
    expect(out.kind).toBe('success');
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('returns circuit_open when breaker is open', async () => {
    const fetch = makeFetch([{ status: 200, body: { id: 'x', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } }]);
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 }, circuit: { failureThreshold: 1, windowMs: 60_000, openCooldownMs: 60_000, halfOpenSuccessThreshold: 1 } });
    c.resetCircuit('OpenAI');
    // Trip the breaker manually.
    (c as unknown as { circuit: { recordFailure(id: string): void; stateOf(id: string): string } }).circuit.recordFailure('OpenAI');
    const out = await c.call(new OpenAIAdapter(), req(), 'sk', 'https://api.openai.com');
    expect(out.kind).toBe('circuit_open');
  });
});

describe('HttpProviderConnector.stream', () => {
  it('yields decoded SSE chunks', async () => {
    const sseBody = `event: message\ndata: {"id":"r1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseBody));
        ctrl.close();
      },
    });
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 } });
    const adapter = new OpenAIAdapter();
    const events: Array<{ textDelta?: string; sseData: string }> = [];
    for await (const ev of c.stream(adapter, { ...req(), stream: true }, 'sk', 'https://api.openai.com')) {
      const item: { textDelta?: string; sseData: string } = { sseData: ev.sseData };
      if (ev.event?.textDelta !== undefined) item.textDelta = ev.event.textDelta;
      events.push(item);
    }
    expect(events[0]?.textDelta).toBe('hi');
    expect(events.at(-1)?.sseData).toBe('[DONE]');
  });

  it('throws UpstreamHttpError on non-2xx', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('boom', { status: 500 }));
    const c = new HttpProviderConnector({ fetch: fetch as unknown as typeof fetch, defaultTimeoutMs: 1000, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterMs: 0 } });
    const adapter = new OpenAIAdapter();
    const it = c.stream(adapter, { ...req(), stream: true }, 'sk', 'https://api.openai.com');
    await expect(it[Symbol.asyncIterator]().next()).rejects.toThrow(/upstream 500/);
  });
});
