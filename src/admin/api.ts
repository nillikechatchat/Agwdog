import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repositories } from '../storage/index.js';
import type { Registry } from '../observability/registry.js';
import { renderPrometheus } from '../observability/prometheus.js';
import { loadMasterKey, encrypt } from '../crypto/aes.js';

export interface AdminApiDeps {
  repos: Repositories;
  registry: Registry;
  adminToken?: string | undefined;
  masterKey?: Buffer | undefined;
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
  deps: AdminApiDeps;
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
    { method: 'POST', regex: /^\/admin\/api\/providers$/, paramNames: [], handler: handleCreateProvider },
    { method: 'DELETE', regex: /^\/admin\/api\/providers\/(?<id>[^/]+)$/, paramNames: ['id'], handler: handleDeleteProvider },
    { method: 'PATCH', regex: /^\/admin\/api\/providers\/(?<id>[^/]+)$/, paramNames: ['id'], handler: handleUpdateProvider },
    { method: 'POST', regex: /^\/admin\/api\/providers\/(?<id>[^/]+)?\/sync-models$/, paramNames: ['id'], handler: handleSyncModels },
    { method: 'GET', regex: /^\/admin\/api\/providers\/(?<providerId>[^/]+)?\/models$/, paramNames: ['providerId'], handler: handleListProviderModels },
    { method: 'POST', regex: /^\/admin\/api\/providers\/(?<providerId>[^/]+)?\/models$/, paramNames: ['providerId'], handler: handleCreateProviderModel },
    { method: 'DELETE', regex: /^\/admin\/api\/providers\/(?<providerId>[^/]+)?\/models\/(?<modelId>[^/]+)$/, paramNames: ['providerId', 'modelId'], handler: handleDeleteProviderModel },
    { method: 'GET', regex: /^\/admin\/api\/virtual-models$/, paramNames: [], handler: handleListVirtualModels },
    { method: 'POST', regex: /^\/admin\/api\/virtual-models$/, paramNames: [], handler: handleCreateVirtualModel },
    { method: 'DELETE', regex: /^\/admin\/api\/virtual-models\/(?<id>[^/]+)$/, paramNames: ['id'], handler: handleDeleteVirtualModel },
    { method: 'GET', regex: /^\/admin\/api\/virtual-models\/(?<id>[^/]+)?\/members$/, paramNames: ['id'], handler: handleListVirtualModelMembers },
    { method: 'POST', regex: /^\/admin\/api\/virtual-models\/(?<id>[^/]+)?\/members$/, paramNames: ['id'], handler: handleAddVirtualModelMember },
    { method: 'DELETE', regex: /^\/admin\/api\/virtual-models\/(?<id>[^/]+)?\/members\/(?<upstreamModelId>[^/]+)$/, paramNames: ['id', 'upstreamModelId'], handler: handleRemoveVirtualModelMember },
    { method: 'GET', regex: /^\/admin\/api\/virtual-models\/(?<id>[^/]+)?\/availability$/, paramNames: ['id'], handler: handleVirtualModelAvailability },
    { method: 'GET', regex: /^\/admin\/api\/keys$/, paramNames: [], handler: handleListKeys },
    { method: 'POST', regex: /^\/admin\/api\/keys$/, paramNames: [], handler: handleCreateKey },
    { method: 'DELETE', regex: /^\/admin\/api\/keys\/(?<id>[^/]+)$/, paramNames: ['id'], handler: handleDeleteKey },
    { method: 'POST', regex: /^\/admin\/api\/keys\/(?<id>[^/]+)?\/budget\/reset$/, paramNames: ['id'], handler: handleResetBudget },
    { method: 'GET', regex: /^\/admin\/api\/usage$/, paramNames: [], handler: handleUsage },
    { method: 'GET', regex: /^\/admin\/api\/logs$/, paramNames: [], handler: handleLogs },
    { method: 'DELETE', regex: /^\/admin\/api\/logs$/, paramNames: [], handler: handleClearLogs },
    { method: 'POST', regex: /^\/admin\/api\/cache\/clear$/, paramNames: [], handler: handleClearCache },
    { method: 'GET', regex: /^\/admin\/api\/cache\/size$/, paramNames: [], handler: handleCacheSize },
    { method: 'GET', regex: /^\/admin\/api\/availability$/, paramNames: [], handler: handleAvailability },
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
    cacheHitRate: cacheHitRate(ctx.repos, oneDayAgo),
    virtualModels: ctx.repos.virtualModels.list().length,
    keys: ctx.repos.keys.list().filter((k) => k.status === 'active').length,
    series7d: aggregates,
  };

  function cacheHitRate(r: Repositories, since: number): number {
    const row = r.raw().prepare(
      `SELECT
        SUM(CASE WHEN cache_hit IN ('exact','semantic','continuation') THEN 1 ELSE 0 END) as hits,
        COUNT(*) as total
        FROM usage_records WHERE created_at >= ?`,
    ).get(since) as { hits: number | null; total: number | null } | undefined;
    const total = row?.total ?? 0;
    if (total === 0) return 0;
    return (row?.hits ?? 0) / total;
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
      inputPrice: p.input_price_per_mtokens_usd,
      outputPrice: p.output_price_per_mtokens_usd,
      cachedInputPrice: p.cached_input_price_per_mtokens_usd,
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
  return { providers };
}

function handleCreateProvider(ctx: AdminContext) {
  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };
  const name = body['name'] as string | undefined;
  const protocol = body['protocol'] as string | undefined;
  const baseUrl = body['baseUrl'] as string | undefined;
  if (!name) return { error: 'name required' };
  if (!protocol) return { error: 'protocol required' };
  if (!baseUrl) return { error: 'baseUrl required' };

  // Encrypt API key if provided
  const plainApiKey = body['apiKey'] as string | undefined;
  let apiKeyCiphertext = '';
  let apiKeyIv = '';
  let apiKeyTag = '';
  if (plainApiKey && ctx.deps.masterKey) {
    const encrypted = encrypt(plainApiKey, ctx.deps.masterKey);
    apiKeyCiphertext = encrypted.ciphertext;
    apiKeyIv = encrypted.iv;
    apiKeyTag = encrypted.tag;
  }

  const id = `provider-${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 4)}`;
  ctx.repos.providers.insert({
    id,
    name,
    protocol: protocol as any,
    baseUrl,
    apiKeyCiphertext,
    apiKeyIv,
    apiKeyTag,
    inputPricePerMTokensUsd: parsePrice(body['inputPrice']),
    outputPricePerMTokensUsd: parsePrice(body['outputPrice']),
    cachedInputPricePerMTokensUsd: parsePrice(body['cachedInputPrice']),
    enabled: body['enabled'] !== false,
    extra: body['extra'] ? (body['extra'] as Record<string, unknown>) : null,
  });
  return { id };
}

function handleDeleteProvider(ctx: AdminContext) {
  const id = ctx.params['id']!;
  ctx.repos.providers.delete(id);
  return { deleted: id };
}

const VALID_PROTOCOLS = ['OpenAI', 'OpenAI-Compatible', 'Anthropic', 'Gemini', 'Doubao', 'Wenxin'];

function parsePrice(value: unknown): number | null {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function handleUpdateProvider(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const existing = ctx.repos.providers.getById(id);
  if (!existing) return { error: 'provider not found' };

  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };

  const updates: Record<string, unknown> = {};

  if (body['name'] !== undefined) {
    const name = body['name'] as string;
    if (!name || name.trim().length === 0) return { error: 'name must be non-empty' };
    updates['name'] = name;
  }
  if (body['protocol'] !== undefined) {
    const protocol = body['protocol'] as string;
    if (!VALID_PROTOCOLS.includes(protocol)) return { error: `protocol must be one of: ${VALID_PROTOCOLS.join(', ')}` };
    updates['protocol'] = protocol;
  }
  if (body['baseUrl'] !== undefined) {
    const baseUrl = body['baseUrl'] as string;
    if (!baseUrl || baseUrl.trim().length === 0) return { error: 'baseUrl must be non-empty' };
    updates['baseUrl'] = baseUrl;
  }

  // Handle API key update
  let apiKeySkipped = false;
  if (body['apiKey'] !== undefined) {
    const newApiKey = body['apiKey'] as string;
    if (newApiKey && newApiKey.length > 0) {
      if (!ctx.deps.masterKey) {
        apiKeySkipped = true;
      } else {
        const encrypted = encrypt(newApiKey, ctx.deps.masterKey);
        updates['apiKeyCiphertext'] = encrypted.ciphertext;
        updates['apiKeyIv'] = encrypted.iv;
        updates['apiKeyTag'] = encrypted.tag;
      }
    }
  }

  if (body['inputPrice'] !== undefined) updates['inputPricePerMTokensUsd'] = parsePrice(body['inputPrice']);
  if (body['outputPrice'] !== undefined) updates['outputPricePerMTokensUsd'] = parsePrice(body['outputPrice']);
  if (body['cachedInputPrice'] !== undefined) updates['cachedInputPricePerMTokensUsd'] = parsePrice(body['cachedInputPrice']);
  if (body['enabled'] !== undefined) updates['enabled'] = body['enabled'] === true;

  if (Object.keys(updates).length === 0) {
    if (apiKeySkipped) return { error: 'cannot update API key: master key not configured' };
    return { error: 'no updates provided' };
  }

  ctx.repos.providers.update(id, updates as Parameters<typeof ctx.repos.providers.update>[1]);
  const result: Record<string, unknown> = { updated: id };
  if (apiKeySkipped) result['warning'] = 'API key update skipped: master key not configured';
  return result;
}

function handleSyncModels(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const body = ctx.body as Record<string, unknown> | null;
  const models = body?.['models'] as Array<{ modelId: string; displayName?: string }> | undefined;
  if (!models || models.length === 0) return { error: 'models required' };
  
  const rows = models.map((m) => ({
    id: `pm-${id}-${m.modelId.toLowerCase().replace(/[/-]/g, '-')}`,
    providerId: id,
    modelId: m.modelId,
    displayName: m.displayName ?? m.modelId,
    contextWindow: 128000,
    supportsStream: true,
    supportsTools: true,
    supportsVision: false,
    enabled: true,
  }));
  ctx.repos.providerModels.replaceForProvider(id, rows);
  return { synced: rows.length };
}

function handleListProviderModels(ctx: AdminContext) {
  const providerId = ctx.params['providerId'];
  if (providerId) {
    return { models: ctx.repos.providerModels.listByProvider(providerId) };
  }
  return { models: ctx.repos.providerModels.listEnabled() };
}

function handleCreateProviderModel(ctx: AdminContext) {
  const providerId = ctx.params['providerId']!;
  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };
  const modelId = body['modelId'] as string | undefined;
  if (!modelId) return { error: 'modelId required' };
  
  const id = `pm-${providerId}-${modelId.toLowerCase().replace(/[/-]/g, '-')}`;
  ctx.repos.providerModels.insert({
    id,
    providerId,
    modelId,
    displayName: (body['displayName'] as string) ?? modelId,
    contextWindow: body['contextWindow'] ? Number(body['contextWindow']) : 128000,
    supportsStream: body['supportsStream'] !== false,
    supportsTools: body['supportsTools'] !== false,
    enabled: body['enabled'] !== false,
  });
  return { id };
}

function handleDeleteProviderModel(ctx: AdminContext) {
  const providerId = ctx.params['providerId']!;
  const modelId = ctx.params['modelId']!;
  const pm = ctx.repos.providerModels.getByProviderAndModel(providerId, modelId);
  if (!pm) return { error: 'provider model not found' };
  ctx.repos.providerModels.delete(pm.id);
  return { deleted: pm.id };
}

function handleListVirtualModels(ctx: AdminContext) {
  const virtualModels = ctx.repos.virtualModels.list().map((v) => ({
    id: v.id,
    name: v.name,
    strategy: v.strategy,
    maxRetries: v.max_retries,
    createdAt: v.created_at,
  }));
  return { virtualModels };
}

function handleCreateVirtualModel(ctx: AdminContext) {
  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };
  const name = body['name'] as string | undefined;
  const strategy = body['strategy'] as string | undefined;
  if (!name) return { error: 'name required' };
  if (!strategy) return { error: 'strategy required' };
  
  const id = `vm-${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 4)}`;
  ctx.repos.virtualModels.insert({
    id,
    name,
    strategy: strategy as any,
    latencyWindow: body['latencyWindow'] ? Number(body['latencyWindow']) : null,
    failureThreshold: body['failureThreshold'] ? Number(body['failureThreshold']) : null,
    recoveryThreshold: body['recoveryThreshold'] ? Number(body['recoveryThreshold']) : null,
    maxRetries: body['maxRetries'] ? Number(body['maxRetries']) : 2,
    fallbackChain: body['fallbackChain'] ? (body['fallbackChain'] as string[]) : [],
  });
  return { id };
}

function handleDeleteVirtualModel(ctx: AdminContext) {
  const id = ctx.params['id']!;
  ctx.repos.virtualModels.delete(id);
  return { deleted: id };
}

function handleListVirtualModelMembers(ctx: AdminContext) {
  const id = ctx.params['id']!;
  return { members: ctx.repos.virtualModels.listMembersWithAvailability(id) };
}

function handleAddVirtualModelMember(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };
  const upstreamModelId = body['upstreamModelId'] as string | undefined;
  if (!upstreamModelId) return { error: 'upstreamModelId required' };
  
  ctx.repos.virtualModels.addMember({
    virtualModelId: id,
    upstreamModelId,
    weight: body['weight'] ? Number(body['weight']) : 1,
    priority: body['priority'] ? Number(body['priority']) : 100,
    enabled: body['enabled'] !== false,
  });
  return { ok: true };
}

function handleRemoveVirtualModelMember(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const upstreamModelId = ctx.params['upstreamModelId']!;
  ctx.repos.virtualModels.removeMember(id, upstreamModelId);
  return { deleted: `${id}/${upstreamModelId}` };
}

function handleVirtualModelAvailability(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const members = ctx.repos.virtualModels.listMembersWithAvailability(id);
  return { 
    id,
    members: members.map((m) => ({
      ...m,
      availability: m.availability as 'available' | 'degraded' | 'unavailable',
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

function handleCreateKey(ctx: AdminContext) {
  const body = ctx.body as Record<string, unknown> | null;
  if (!body) return { error: 'request body required' };
  const name = body['name'] as string | undefined;
  if (!name) return { error: 'name required' };
  const id = `k_${randomUUID().slice(0, 8)}`;
  const token = `sk-${randomUUID().replace(/-/g, '')}`;
  ctx.repos.keys.insert({
    id,
    name,
    keyHash: createHash('sha256').update(token).digest('hex'),
    prefix: token.slice(0, 10),
    budgetDailyUsd: body['budgetDailyUsd'] ? Number(body['budgetDailyUsd']) : null,
    budgetMonthlyUsd: body['budgetMonthlyUsd'] ? Number(body['budgetMonthlyUsd']) : null,
    budgetTotalUsd: body['budgetTotalUsd'] ? Number(body['budgetTotalUsd']) : null,
    rpmLimit: body['rpmLimit'] ? Number(body['rpmLimit']) : null,
    tpmLimit: body['tpmLimit'] ? Number(body['tpmLimit']) : null,
  });
  return { id, token };
}

function handleDeleteKey(ctx: AdminContext) {
  const id = ctx.params['id']!;
  ctx.repos.keys.delete(id);
  return { deleted: id };
}

function handleResetBudget(ctx: AdminContext) {
  const id = ctx.params['id']!;
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const monthKey = new Date(now).toISOString().slice(0, 7);
  ctx.repos.budget.reset(id, 'day', dayKey, now);
  ctx.repos.budget.reset(id, 'month', monthKey, now);
  ctx.repos.budget.reset(id, 'total', 'total', now);
  return { ok: true };
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

function handleLogs(ctx: AdminContext) {
  const since = Number(ctx.url.searchParams.get('sinceMs') ?? Date.now() - 3_600_000);
  const limit = Math.min(200, Number(ctx.url.searchParams.get('limit') ?? 50));
  const requestId = ctx.url.searchParams.get('requestId');
  
  let rows: unknown[];
  if (requestId) {
    rows = ctx.repos.raw()
      .prepare(
        `SELECT * FROM request_logs WHERE request_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(requestId, since, limit);
  } else {
    rows = ctx.repos.raw()
      .prepare(
        `SELECT * FROM request_logs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(since, limit);
  }
  return { records: rows };
}

function handleClearLogs(ctx: AdminContext) {
  ctx.repos.raw().prepare(`DELETE FROM request_logs`).run();
  return { cleared: true };
}

function handleClearCache(ctx: AdminContext) {
  return { cleared: ctx.repos.cache.clear() };
}

function handleCacheSize(ctx: AdminContext) {
  return { size: ctx.repos.cache.count(Date.now()) };
}

function handleAvailability(ctx: AdminContext) {
  const models = ctx.repos.providerModels.listEnabled();
  return { models: models.map((m) => ({
    id: m.id,
    providerId: m.provider_id,
    modelId: m.model_id,
    availability: m.availability,
    latencyMsP50: m.latency_ms_p50,
    latencyMsP95: m.latency_ms_p95,
  })) };
}

function webAssetCandidates(filename: string): string[] {
  return [
    join(process.cwd(), 'web', filename),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', filename),
  ];
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serve a read-only allow-list of static files under /admin/vendor/.
 * Path traversal is impossible: only `vendor/<name>` with an alphanumeric
 * + dot + dash filename is accepted.
 */
function tryServeVendorFile(pathname: string, res: ServerResponse): boolean {
  const m = /^\/admin\/vendor\/([A-Za-z0-9._-]+)$/.exec(pathname);
  if (!m) return false;
  const filename = m[1]!;
  for (const p of webAssetCandidates(join('vendor', filename))) {
    if (existsSync(p)) {
      const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(readFileSync(p));
      return true;
    }
  }
  return false;
}

function locateWebIndex(): string | null {
  for (const p of webAssetCandidates('index.html')) if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, deps: AdminApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (
    (pathname === '/' || pathname === '') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    res.statusCode = 302;
    res.setHeader('Location', '/admin');
    res.end();
    return true;
  }
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return false;

  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    const html = locateWebIndex();
    if (html === null) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('admin web bundle not found');
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(html);
    return true;
  }

  if (tryServeVendorFile(pathname, res)) return true;

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
      deps,
    };
    try {
      const result = await r.handler(c);
      // Handlers signal business errors by returning { error: string }.
      const isError = result !== null && typeof result === 'object' && !Array.isArray(result) && 'error' in result;
      json(res, result, isError ? 400 : 200);
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
    return true;
  }
  json(res, { error: 'not found' }, 404);
  return true;
}
