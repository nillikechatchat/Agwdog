import { describe, it, expect, afterEach } from 'vitest';
import { startServer } from '@/server/http.js';
import type { AddressInfo } from 'node:net';

let lastShutdown: { forceExit: () => void; done: Promise<void> } | null = null;

afterEach(async () => {
  if (lastShutdown) {
    lastShutdown.forceExit();
    await lastShutdown.done;
    lastShutdown = null;
  }
});

describe('startServer — happy paths', () => {
  it('listens on an ephemeral port and answers /healthz with 200', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain');
          res.end('ok');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    await result.ready;
    const addr = result.server.address() as AddressInfo;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/);
    expect(res.headers.get('X-Gateway-Version')).toBe('0.1.0');
    expect(await res.text()).toBe('ok');
  });

  it('returns 404 for unknown paths', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.end('noop');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/no/such/path`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('route_not_found');
  });

  it('returns 405 for path-matches-but-method-mismatches (PUT /v1/models)', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.end('noop');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: 'PUT' });
    expect(res.status).toBe(404);
  });

  it('parses JSON body and forwards it to the dispatch handler', async () => {
    let captured: unknown;
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ body, res }) => {
          captured = body;
          res.statusCode = 200;
          res.end('ack');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('returns 400 with `invalid_json` when body is malformed JSON', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.end('noop');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ broken json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
  });

  it('returns 413 when body exceeds 1 MiB cap', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.end('ok');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const huge = JSON.stringify({ model: 'm', messages: [], payload: 'a'.repeat(2 * 1024 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(413);
  });

  it('dispatch error becomes 500 with `internal_error` code when nothing is sent yet', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async () => {
          throw new Error('boom');
        },
    });
    lastShutdown = result.shutdown;
    await result.ready;
    const port = (result.server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('boom');
  });

  it('stops listening when forceExit() is called', async () => {
    const result = startServer({
      port: 0,
      host: '127.0.0.1',
      dispatch: async ({ res }) => {
          res.statusCode = 200;
          res.end('ok');
        },
    });
    await result.ready;
    lastShutdown = result.shutdown;
    const port = (result.server.address() as AddressInfo).port;
    await result.ready;

    // First request works
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);

    result.shutdown.forceExit();
    await result.shutdown.done;

    // Now the server should refuse connections.
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch (err) {
      refused = true;
      expect((err as Error).message).toMatch(/ECONNREFUSED|fetch failed/);
    }
    expect(refused).toBe(true);
  });
});