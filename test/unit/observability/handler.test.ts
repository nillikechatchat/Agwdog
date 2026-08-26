import { describe, it, expect } from 'vitest';
import { makeMetricsHandler } from '../../../src/observability/handler.js';
import { Registry } from '../../../src/observability/registry.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function makeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}
function makeRes(): { res: ServerResponse; body: string; status: number; headers: Record<string, string> } {
  const res: { res: ServerResponse; body: string; status: number; headers: Record<string, string> } = {
    res: undefined as unknown as ServerResponse,
    body: '',
    status: 0,
    headers: {},
  };
  res.res = {
    statusCode: 200,
    setHeader(k: string, v: string | number) { res.headers[k] = String(v); return this; },
    end(chunk?: string | Buffer) { res.body = String(chunk); res.status = (this as unknown as { statusCode: number }).statusCode ?? 200; return this; },
  } as unknown as ServerResponse;
  return res;
}

describe('makeMetricsHandler', () => {
  it('handles /metrics', () => {
    const r = new Registry();
    r.counter('c', 'h').inc();
    const h = makeMetricsHandler(r);
    const res = makeRes();
    const handled = h(makeReq('/metrics'), res.res);
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/plain');
    expect(res.body).toMatch(/^# HELP c h/);
  });

  it('handles /v1/metrics', () => {
    const r = new Registry();
    const h = makeMetricsHandler(r);
    const res = makeRes();
    expect(h(makeReq('/v1/metrics'), res.res)).toBe(true);
  });

  it('returns false for unrelated URLs', () => {
    const r = new Registry();
    const h = makeMetricsHandler(r);
    const res = makeRes();
    expect(h(makeReq('/v1/chat/completions'), res.res)).toBe(false);
    expect(res.status).toBe(0);
  });
});
