import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createLogger, log, redact } from '@/utils/logger.js';

let originalWrite: ((...args: unknown[]) => boolean) | undefined;
let captured: string[] = [];
const ORIGINAL_ENV: Record<string, string | undefined> = {
  LOG_LEVEL: process.env['LOG_LEVEL'],
  LOG_QUIET: process.env['LOG_QUIET'],
  LOG_JSON: process.env['LOG_JSON'],
};

beforeEach(() => {
  captured = [];
  originalWrite = process.stdout.write as unknown as (...args: unknown[]) => boolean;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.env['LOG_LEVEL'] = 'debug';
  process.env['LOG_QUIET'] = '';
  process.env['LOG_JSON'] = '';
});

afterEach(() => {
  if (originalWrite) {
    process.stdout.write = originalWrite as typeof process.stdout.write;
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('createLogger — basic emission', () => {
  it('emits a JSON line with ts, level, msg', () => {
    process.env['LOG_LEVEL'] = 'debug';
    const l = createLogger({ component: 'test' });
    l.info('hello', { requestId: 'r1' });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!.trim()) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('hello');
    expect(parsed['requestId']).toBe('r1');
    expect(parsed['component']).toBe('test');
    expect(typeof parsed['ts']).toBe('string');
  });

  it('honors LOG_LEVEL threshold', () => {
    process.env['LOG_LEVEL'] = 'warn';
    const l = createLogger();
    l.info('hidden');
    l.warn('shown');
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!.trim()) as Record<string, unknown>;
    expect(parsed['msg']).toBe('shown');
  });

  it('honors LOG_QUIET=1 (suppresses info/warn)', () => {
    process.env['LOG_QUIET'] = '1';
    const l = createLogger();
    l.info('info-line');
    l.warn('warn-line');
    l.error('error-line');
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!.trim()) as Record<string, unknown>;
    expect(parsed['msg']).toBe('error-line');
  });

  it('child() merges bindings', () => {
    process.env['LOG_LEVEL'] = 'debug';
    const parent = createLogger({ component: 'a' });
    const child = parent.child({ requestId: 'r2' });
    child.info('hi');
    const parsed = JSON.parse(captured[0]!.trim()) as Record<string, unknown>;
    expect(parsed['component']).toBe('a');
    expect(parsed['requestId']).toBe('r2');
  });

  it('pretty mode when LOG_JSON=0', () => {
    process.env['LOG_JSON'] = '0';
    process.env['LOG_LEVEL'] = 'debug';
    const l = createLogger();
    l.info('pretty');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/INFO pretty/);
  });
});

describe('redact — credential scrubbing', () => {
  it('redacts Authorization, Cookie, X-Api-Key keys', () => {
    const out = redact({
      Authorization: 'Bearer eyJabc.real.token',
      Cookie: 'session=abc',
      'X-Api-Key': 'sk-supersecret',
      password: 'hunter2',
      secret: 'shh',
    }) as Record<string, unknown>;
    expect(out['Authorization']).toBe('***');
    expect(out['Cookie']).toBe('***');
    expect(out['X-Api-Key']).toBe('***');
    expect(out['password']).toBe('***');
    expect(out['secret']).toBe('***');
  });

  it('redacts OpenAI sk- keys in arbitrary string fields', () => {
    const out = redact({ error: 'upstream said: invalid key sk-abcdefghijklmnop1234 retry later' }) as Record<string, unknown>;
    expect(out['error']).toBe('upstream said: invalid key *** retry later');
  });

  it('redacts Anthropic sk-ant- keys', () => {
    const out = redact({ msg: 'failed with sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901' }) as Record<string, unknown>;
    expect(out['msg']).toBe('failed with ***');
  });

  it('redacts AWS AKIA access keys', () => {
    const out = redact({ note: 'creds=AKIAIOSFODNN7EXAMPLE leaked' }) as Record<string, unknown>;
    expect(out['note']).toBe('creds=*** leaked');
  });

  it('redacts GitHub ghp_ tokens', () => {
    const out = redact({ note: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }) as Record<string, unknown>;
    expect(out['note']).toBe('token=***');
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nABCDEF123456\n-----END RSA PRIVATE KEY-----';
    const out = redact({ pem }) as Record<string, unknown>;
    expect(out['pem']).toBe('***PEM***');
  });

  it('redacts Bearer tokens in any field', () => {
    const out = redact({ trace: 'Authorization: Bearer abc.def.ghi sent upstream' }) as Record<string, unknown>;
    expect(out['trace']).toBe('Authorization: Bearer *** sent upstream');
  });

  it('recursively redacts arrays and nested objects', () => {
    const out = redact({
      req: {
        headers: { Authorization: 'Bearer secret' },
        nested: [{ apiKey: 'sk-1234567890abcdef' }],
      },
    }) as { req: { headers: Record<string, string>; nested: Array<Record<string, string>> } };
    expect(out.req.headers['Authorization']).toBe('***');
    expect(out.req.nested[0]!['apiKey']).toBe('***');
  });

  it('returns the value unchanged when no sensitive content is present', () => {
    expect(redact({ msg: 'all good', count: 5 })).toEqual({ msg: 'all good', count: 5 });
  });
});

describe('default export', () => {
  it('exposes a usable default logger', () => {
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
  });
});