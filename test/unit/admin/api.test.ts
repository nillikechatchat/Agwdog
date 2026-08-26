import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase } from '../../helpers/db.js';
import { Registry } from '../../../src/observability/registry.js';
import { handleAdminRequest } from '../../../src/admin/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { AdminApiDeps } from '../../../src/admin/index.js';

interface Capture {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
}

function makeFakeRes(): Capture & ServerResponse {
  const s: Capture = { statusCode: 200, headers: {}, chunks: [] };
  const r = {
    get statusCode() { return s.statusCode; },
    set statusCode(v) { s.statusCode = v; },
    headersSent: false,
    statusMessage: '',
    setHeader(k: string, v: string) { s.headers[k.toLowerCase()] = v; return r as any; },
    getHeader(k: string) { return s.headers[k.toLowerCase()]; },
    removeHeader() { return r as any; },
    write(c: string | Buffer) { s.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
    end(c?: string | Buffer) { if (c) s.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return r as any; },
    on() { return r as any; },
    once() { return r as any; },
    emit() { return true; },
    flushHeaders() { return true; },
    addHeader() { return r as any; },
    assignSocket() { return r as any; },
    detachSocket() { return r as any; },
    setTimeout() { return r as any; },
    writeContinue() {},
    writeProcessing() {},
    writeEarlyHints() { return true; },
    writeFile() {},
    endWrite() {},
    assignRequest() {},
    detachRequest() {},
  } as unknown as Capture & ServerResponse;
  return Object.assign(r, s) as unknown as Capture & ServerResponse;
}

function makeReqRes(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): { req: IncomingMessage; res: Capture & ServerResponse; capture: Capture } {
  const req = Readable.from(body !== undefined ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []) as unknown as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = headers;
  const r = makeFakeRes();
  return { req, res: r, capture: r as Capture };
}

describe('admin api', () => {
  let repos: never;
  let registry: Registry;
  let cleanup: () => void;
  let deps: AdminApiDeps;

  beforeEach(() => {
    const t = openTestDatabase();
    repos = t.repos as never;
    cleanup = t.cleanup;
    registry = new Registry();
    deps = { repos: repos as any, registry };
  });

  afterEach(() => cleanup());

  function resp(c: Capture): Record<string, unknown> {
    const raw = Buffer.concat(c.chunks).toString('utf8');
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('returns true for /admin paths and false otherwise', async () => {
    const { req, res } = makeReqRes('/v1/chat/completions', 'POST');
    expect(await handleAdminRequest(req, res, deps)).toBe(false);

    const r2 = makeReqRes('/admin/api/stats', 'GET');
    expect(await handleAdminRequest(r2.req, r2.res, deps)).toBe(true);
  });

  it('GET /admin/api/stats returns zero-aggregates on empty store', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/stats', 'GET');
    await handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(200);
    const body = resp(capture);
    expect(body['cacheSize']).toBe(0);
    expect(body['virtualModels']).toBe(0);
    expect((body['today'] as Record<string, number>)['requests']).toBe(0);
  });

  it('GET /admin/api/keys returns empty list initially', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/keys', 'GET');
    await handleAdminRequest(req, res, deps);
    expect((resp(capture)['keys'] as unknown[])?.length).toBe(0);
  });

  it('POST /admin/api/keys creates a key and returns a token', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/keys', 'POST', { name: 'test' });
    await handleAdminRequest(req, res, deps);
    const body = resp(capture);
    expect(body['id']).toMatch(/^k_/);
    expect(body['token']).toMatch(/^sk-/);
    expect((repos as any).keys.list().length).toBe(1);
    const stored = (repos as any).keys.list()[0];
    expect(stored.name).toBe('test');
    expect(stored.prefix).toBe(String(body['token']).slice(0, 10));
  });

  it('POST /admin/api/keys requires name', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/keys', 'POST', {});
    await handleAdminRequest(req, res, deps);
    expect((resp(capture)['error'] as string)).toBe('name required');
  });

  it('DELETE /admin/api/keys/:id removes a key', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/keys', 'POST', { name: 'a' });
    await handleAdminRequest(req, res, deps);
    const id = String(resp(capture)['id']);
    const r2 = makeReqRes('/admin/api/keys/' + id, 'DELETE');
    await handleAdminRequest(r2.req, r2.res, deps);
    expect(resp(r2.capture)['deleted']).toBe(id);
    expect((repos as any).keys.list().length).toBe(0);
  });

  it('GET /admin/api/usage returns empty when no records', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/usage', 'GET');
    await handleAdminRequest(req, res, deps);
    expect((resp(capture)['records'] as unknown[])?.length).toBe(0);
  });

  it('GET /admin/api/cache/size returns 0 on empty', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/cache/size', 'GET');
    await handleAdminRequest(req, res, deps);
    expect(resp(capture)['size']).toBe(0);
  });

  it('POST /admin/api/cache/clear returns 0 when empty', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/cache/clear', 'POST');
    await handleAdminRequest(req, res, deps);
    expect(resp(capture)['cleared']).toBe(0);
  });

  it('GET /admin/api/providers returns empty lists when no providers', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/providers', 'GET');
    await handleAdminRequest(req, res, deps);
    const body = resp(capture);
    expect(body['providers']).toEqual([]);
  });

  it('GET /admin/api/virtual-models returns empty when none', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/virtual-models', 'GET');
    await handleAdminRequest(req, res, deps);
    expect((resp(capture)['virtualModels'] as unknown[])?.length).toBe(0);
  });

  it('GET /admin/api/stats computes cache hit rate from usage records', async () => {
    (repos as any).usage.append({
      requestId: 'r1', clientProtocol: 'openai-chat',
      promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001,
      source: 'estimated', cacheHit: 'exact', latencyMs: 50, statusCode: 200,
    });
    (repos as any).usage.append({
      requestId: 'r2', clientProtocol: 'openai-chat',
      promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001,
      source: 'estimated', cacheHit: 'none', latencyMs: 50, statusCode: 200,
    });
    const { req, res, capture } = makeReqRes('/admin/api/stats', 'GET');
    await handleAdminRequest(req, res, deps);
    const body = resp(capture);
    expect(body['cacheHitRate']).toBeCloseTo(0.5, 5);
  });

  it('GET /admin/metrics exposes Prometheus output', async () => {
    registry.counter('test_counter', 'a test counter').inc();
    const { req, res, capture } = makeReqRes('/admin/metrics', 'GET');
    await handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(200);
    const text = Buffer.concat(capture.chunks).toString('utf8');
    expect(text).toContain('test_counter');
    expect(text).toContain('# TYPE');
  });

  it('requires bearer token when adminToken configured', async () => {
    const secured: AdminApiDeps = { ...deps, adminToken: 'sekret' };
    const noAuth = makeReqRes('/admin/api/keys', 'GET');
    await handleAdminRequest(noAuth.req, noAuth.res, secured);
    expect(noAuth.res.statusCode).toBe(401);

    const ok = makeReqRes('/admin/api/keys', 'GET', undefined, { authorization: 'Bearer sekret' });
    await handleAdminRequest(ok.req, ok.res, secured);
    expect(ok.res.statusCode).toBe(200);

    // /admin (HTML root) is always reachable without auth.
    const html = makeReqRes('/admin', 'GET');
    await handleAdminRequest(html.req, html.res, secured);
    expect(html.res.statusCode).toBe(200);
    expect(html.res.getHeader('Content-Type') as string).toContain('text/html');
  });

  it('returns 404 for unknown admin paths', async () => {
    const { req, res, capture } = makeReqRes('/admin/api/does-not-exist', 'GET');
    await handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(404);
  });

  it('serves the web index HTML on /admin', async () => {
    const { req, res, capture } = makeReqRes('/admin', 'GET');
    await handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type') as string).toContain('text/html');
    const html = Buffer.concat(capture.chunks).toString('utf8');
    expect(html).toContain('AI Gateway');
    expect(html).toContain('Dashboard');
  });
});
