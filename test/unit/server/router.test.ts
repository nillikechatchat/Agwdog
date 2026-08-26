import { describe, it, expect } from 'vitest';

import { match, resolveRoute, ROUTE_TABLE, type HttpMethod } from '@/server/router.js';

describe('match — exact paths', () => {
  it('returns match with empty params when segments are identical', () => {
    const m = match('/v1/models', '/v1/models');
    expect(m?.params).toEqual({});
  });

  it('returns null when one segment differs', () => {
    expect(match('/v1/foo', '/v1/models')).toBeNull();
  });

  it('returns null when path has extra segments', () => {
    expect(match('/v1/models/extra', '/v1/models')).toBeNull();
  });

  it('returns null when pattern has more segments than path', () => {
    expect(match('/v1', '/v1/models')).toBeNull();
  });
});

describe('match — placeholders', () => {
  it('captures a single :placeholder', () => {
    const m = match('/v1/responses/resp_abc', '/v1/responses/:id');
    expect(m?.params).toEqual({ id: 'resp_abc' });
  });

  it('captures multi-segment paths with multiple placeholders', () => {
    const m = match('/v1beta/models/gpt-4o:generateContent', '/v1beta/models/:modelAndAction');
    expect(m?.params).toEqual({ modelAndAction: 'gpt-4o:generateContent' });
  });

  it('decodes URI-encoded segments', () => {
    const m = match('/v1/responses/a%20b', '/v1/responses/:id');
    expect(m?.params).toEqual({ id: 'a b' });
  });
});

describe('match — wildcards', () => {
  it('captures trailing wildcard as `rest`', () => {
    const m = match('/admin/api/keys', '/admin/api/*');
    expect(m?.params).toEqual({ rest: 'keys' });
  });

  it('captures multi-segment trailing wildcard', () => {
    const m = match('/admin/api/usage/timeseries', '/admin/api/*');
    expect(m?.params).toEqual({ rest: 'usage/timeseries' });
  });

  it('captures empty rest when trailing wildcard has nothing', () => {
    const m = match('/admin/api', '/admin/api/*');
    expect(m?.params).toEqual({ rest: '' });
  });
});

describe('ROUTE_TABLE — every Client Protocol path is reachable', () => {
  const checks: Array<[string, HttpMethod, string]> = [
    ['openaiChat',     'POST', '/v1/chat/completions'],
    ['openaiResponses', 'POST', '/v1/responses'],
    ['openaiResponsesGet', 'GET', '/v1/responses/resp_xyz'],
    ['anthropicMessages', 'POST', '/v1/messages'],
    ['anthropicCountTokens', 'POST', '/v1/messages/count_tokens'],
    ['geminiGenerate', 'POST', '/v1beta/models/gemini-pro:generateContent'],
    ['listModels', 'GET', '/v1/models'],
    ['listGeminiModels', 'GET', '/v1beta/models'],
    ['adminIndex', 'GET', '/admin'],
    ['adminStatic', 'GET', '/admin/styles.css'],
    ['adminApi', 'POST', '/admin/api/keys'],
    ['adminApi', 'GET', '/admin/api/usage'],
    ['adminApi', 'DELETE', '/admin/api/keys/k1'],
    ['prometheusMetrics', 'GET', '/metrics'],
    ['healthz', 'GET', '/healthz'],
  ];

  it.each(checks)('resolves %s for %s %s', (handler, method, path) => {
    const r = resolveRoute(method, path);
    expect(r?.handler).toBe(handler);
  });
});

describe('resolveRoute — negative cases', () => {
  it('returns null when method does not match', () => {
    expect(resolveRoute('PUT', '/v1/models')).toBeNull();
  });

  it('returns null for unknown path', () => {
    expect(resolveRoute('GET', '/unknown/path')).toBeNull();
  });

  it('returns the first matching route when two patterns could match', () => {
    const r = resolveRoute('GET', '/v1/responses/resp_1');
    expect(r?.handler).toBe('openaiResponsesGet');
  });

  it('splits Gemini single-segment placeholder into model + action', () => {
    const r = resolveRoute('POST', '/v1beta/models/gemini-1.5-pro:streamGenerateContent');
    expect(r?.handler).toBe('geminiGenerate');
    expect(r?.params).toEqual({ model: 'gemini-1.5-pro', action: 'streamGenerateContent' });
  });
});

describe('ROUTE_TABLE — sanity', () => {
  it('every route uses a non-empty pattern and handler', () => {
    for (const r of ROUTE_TABLE) {
      expect(r.pattern.length).toBeGreaterThan(0);
      expect(r.handler.length).toBeGreaterThan(0);
    }
  });

  it('contains at least one entry per Client Protocol family', () => {
    const handlers = new Set(ROUTE_TABLE.map((r) => r.handler));
    expect(handlers.has('openaiChat')).toBe(true);
    expect(handlers.has('openaiResponses')).toBe(true);
    expect(handlers.has('anthropicMessages')).toBe(true);
    expect(handlers.has('geminiGenerate')).toBe(true);
  });
});