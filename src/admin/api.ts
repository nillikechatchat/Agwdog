import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repositories } from '../storage/index.js';
import type { Registry } from '../observability/registry.js';
import { renderPrometheus } from '../observability/prometheus.js';

export interface AdminApiDeps {
  repos: Repositories;
  registry: Registry;
  /** Optional bearer token. When set, every JSON-API request must send
   * `Authorization: Bearer <token>`. The static HTML at `/admin` is
   * always reachable (the gateway is expected to be behind a reverse
   * proxy that performs the heavy auth). */
  adminToken?: string | undefined;
}

export interface AdminContext {
  req: IncomingMessage;
  res: ServerResponse;
  repos: Repositories;
  registry: Registry;
  url: URL;
  method: string;
  pathname: string;
  body: unknown;
  params: Record<string, string>;
}

type AdminHandler = (ctx: AdminContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: AdminHandler;
}

export function buildAdminRouter(): Route[] {
  return [
    { method: 'GET', regex: /^\/admin\/api\/stats$/, paramNames: [], handler: handleStats },
    { method: 'GET', regex: /^\/admin\/api\/providers$/, paramNames: [], handler: handleListProviders },
    { method: 'GET', regex: /^\/admin\/api\/virtual-models$/, paramNames: [], handler: handleListVirtualModels },
    { method: 'GET', regex: /^\/admin\/api\/keys$/, paramNames: [], handler: handleListKeys },
    { method: 'POST', regex: /^\/admin\/api\/keys$/, paramNames: [], handler: handleCreateKey },
    { method: 'DELETE', regex: /^\/admin\/api\/keys\/(?<id>[^/]+)$/, paramNames: ['id'], handler: handleDeleteKey },
    { method: 'GET', regex: /^\/admin\/api\/usage$/, paramNames: [], handler: handleUsage },
    { method: 'POST', regex: /^\/admin\/api\/cache\/clear$/, paramNames: [], handler: handleClearCache },
    { method: 'GET', regex: /^\/admin\/api\/cache\/size$/, paramNames: [], handler: handleCacheSize },
  ];
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function checkAdminToken(req: IncomingMessage, deps: AdminApiDeps): boolean {
  if (!deps.adminToken) return true;
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${deps.adminToken}`;
}

function handleStats(ctx: AdminContext) {
  const now = Date.now();
  const oneDayAgo = now - 86_400_000;
  const aggregates = ctx.repos.usage.aggregate({ groupBy: 'day', range: '7d' });
  const today = aggregates[aggregates.length - 1] ?? {
    promptTokens: 0, completionTokens: 0, cachedTokens: 0,
    totalTokens: 0, costUsd: 0, requestCount: 0, bucket: '',
  };
  return {
    timestamp: now,
    today: {
      requests: today.requestCount,
      promptTokens: today.promptTokens,
      completionTokens: today.completionTokens,
      totalTokens: today.totalTokens,
      costUsd: today.costUsd,
    },
    cacheSize: ctx.repos.cache.count(now),
    cacheHitRate: cacheHitRate(ctx.repos),
    virtualModels: ctx.repos.virtualModels.list().length,
    keys: ctx.repos.keys.list().filter((k) => k.status === 'active').length,
    series7d: aggregates,
  };

  function cacheHitRate(r: Repositories): number {
    // Single SELECT over the last 7 days; cheap and good enough for a dashboard.
    const row = r.raw()
      .prepare(`SELECT
        SUM(CASE WHEN cache_hit IN ('exact','semantic','continuation') THEN 1 ELSE 0 END) as hits,
        COUNT(*) as total
        FROM usage_records WHERE created_at >= ?`)
      .get(oneDayAgo) as { hits: number | null; total: number | null };
    const total = row.total ?? 0;
    if (total === 0) return 0;
    return (row.hits ?? 0) / total;
  }
}

function handleListProviders(ctx: AdminContext) {
  const providers = ctx.repos.providers.list().map((p) => {
    const models = ctx.repos.providerModels.listByProvider(p.id);
    return {
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.base_url,
      enabled: p.enabled === 1,
      createdAt: p.created_at,
      models: models.map((m) => ({
        id: m.id,
        modelId: m.model_id,
        displayName: m.display_name,
        availability: m.availability,
        contextWindow: m.context_window,
        supportsStream: m.supports_stream === 1,
        supportsTools: m.supports_tools === 1,
      })),
    };
  });
  return { providers, models: ctx.repos.providerModels.listEnabled() };
}

function handleListVirtualModels(ctx: AdminContext) {
  return {
    virtualModels: ctx.repos.virtualModels.list().map((v) => ({
      id: v.id,
      name: v.name,
      strategy: v.strategy,
      maxRetries: v.max_retries,
      createdAt: v.created_at,
    })),
  };
}

function handleListKeys(ctx: AdminContext) {
  return {
    keys: ctx.repos.keys.list().map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      status: k.status,
      budgetDailyUsd: k.budget_daily_usd,
      budgetMonthlyUsd: k.budget_monthly_usd,
      budgetTotalUsd: k.budget_total_usd,
      cacheEnabled: k.cache_enabled === 1,
      rpmLimit: k.rpm_limit,
      tpmLimit: k.tpm_limit,
      createdAt: k.created_at,
    })),
  };
}

interface CreateKeyBody {
  name?: string;
  budgetDailyUsd?: number | null;
  budgetMonthlyUsd?: number | null;
  budgetTotalUsd?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

function handleCreateKey(ctx: AdminContext) {
  const body = (ctx.body ?? {}) as CreateKeyBody;
  if (!body.name) return { error: 'name required' };
  const id = `k_${randomUUID().slice(0, 8)}`;
  const token = `sk-${randomUUID().replace(/-/g, '')}`;
  ctx.repos.keys.insert({
    id,
    name: body.name,
    keyHash: createHash('sha256').update(token).digest('hex'),
    prefix: token.slice(0, 10),
    budgetDailyUsd: body.budgetDailyUsd ?? null,
    budgetMonthlyUsd: body.budgetMonthlyUsd ?? null,
    budgetTotalUsd: body.budgetTotalUsd ?? null,
    rpmLimit: body.rpmLimit ?? null,
    tpmLimit: body.tpmLimit ?? null,
  });
  return { id, token };
}

function handleDeleteKey(ctx: AdminContext) {
  const id = ctx.params['id']!;
  ctx.repos.keys.delete(id);
  return { deleted: id };
}

function handleUsage(ctx: AdminContext) {
  const since = Number(ctx.url.searchParams.get('sinceMs') ?? Date.now() - 3_600_000);
  const limit = Math.min(200, Number(ctx.url.searchParams.get('limit') ?? 50));
  const rows = ctx.repos.raw()
    .prepare(
      `SELECT request_id, key_id, virtual_model_id, upstream_provider_id, upstream_model_id,
              client_protocol, prompt_tokens, completion_tokens, total_tokens, cost_usd,
              cache_hit, status_code, latency_ms, created_at
         FROM usage_records
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(since, limit);
  return { records: rows };
}

function handleClearCache(ctx: AdminContext) {
  return { cleared: ctx.repos.cache.clear() };
}

function handleCacheSize(ctx: AdminContext) {
  return { size: ctx.repos.cache.count(Date.now()) };
}

function locateWebIndex(): string | null {
  const candidates = [
    join(process.cwd(), 'web', 'index.html'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'),
  ];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, deps: AdminApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return false;

  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    const html = locateWebIndex();
    if (html === null) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('admin web bundle not found; ensure web/index.html is present');
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(html);
    return true;
  }

  if (!checkAdminToken(req, deps)) {
    json(res, { error: 'unauthorized' }, 401);
    return true;
  }

  if (pathname === '/admin/metrics') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(renderPrometheus(deps.registry));
    return true;
  }

  const method = req.method ?? 'GET';
  const router = buildAdminRouter();
  for (const r of router) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const name of r.paramNames) {
      const v = m.groups?.[name];
      if (v !== undefined) params[name] = v;
    }
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = needsBody ? await readJson(req) : null;
    const c: AdminContext = {
      req, res,
      repos: deps.repos, registry: deps.registry,
      url, method, pathname, body, params,
    };
    try {
      const result = await r.handler(c);
      json(res, result);
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
    return true;
  }
  json(res, { error: 'not found' }, 404);
  return true;
}
