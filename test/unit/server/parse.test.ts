import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { BodyTooLargeError, InvalidJsonError, readJsonBody } from '@/server/middleware/parse.js';

import { Readable } from 'node:stream';

function asIncoming(buf: Buffer | string | object): AsyncIterable<Buffer> & { headers: Record<string, string> } {
  let body: Buffer;
  if (typeof buf === 'object' && !Buffer.isBuffer(buf)) {
    body = Buffer.from(JSON.stringify(buf), 'utf8');
  } else if (typeof buf === 'string') {
    body = Buffer.from(buf, 'utf8');
  } else {
    body = buf;
  }
  const readable = Readable.from([body]);
  (readable as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' };
  return readable as unknown as AsyncIterable<Buffer> & { headers: Record<string, string> };
}

describe('readJsonBody — happy paths', () => {
  it('parses valid JSON object', async () => {
    const req = asIncoming({ model: 'gpt-4o', messages: [] });
    const result = await readJsonBody(req as never);
    expect(result).toEqual({ model: 'gpt-4o', messages: [] });
  });

  it('parses JSON array', async () => {
    const req = asIncoming('[1,2,3]');
    const result = await readJsonBody(req as never);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns undefined for empty body', async () => {
    const req = asIncoming('');
    const result = await readJsonBody(req as never);
    expect(result).toBeUndefined();
  });
});

describe('readJsonBody — error paths', () => {
  it('throws InvalidJsonError on malformed JSON', async () => {
    const req = asIncoming('{ not json');
    await expect(readJsonBody(req as never)).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it('throws BodyTooLargeError when body exceeds limit', async () => {
    const req = asIncoming('a'.repeat(2048));
    await expect(readJsonBody(req as never, { maxBytes: 100 })).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('BodyTooLargeError exposes the offending size', async () => {
    const req = asIncoming('a'.repeat(2048));
    try {
      await readJsonBody(req as never, { maxBytes: 100 });
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError);
      expect((err as BodyTooLargeError).size).toBe(2048);
      expect((err as BodyTooLargeError).limit).toBe(100);
    }
  });
});

// The next tests are noisy on `mkdtempSync` etc. — keep the imports to satisfy
// strict TS and silence unused warnings if vitest adds them in future.
void mkdtempSync;
void rmSync;
void mkdtemp;
void join;
void tmpdir;