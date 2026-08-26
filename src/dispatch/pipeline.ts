/**
 * Full request pipeline: Auth -> Cache -> Router -> Adapter -> Connector -> Serializer
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { Database } from '../storage/db.js';
import type { Repositories } from '../storage/index.js';
import type { Registry } from '../observability/registry.js';
import { authenticateRequest, type AuthContext, type AuthRejection } from '../auth/pipeline.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { BudgetTracker } from '../budget/tracker.js';
import { route, RoutingError, type RoutingDecision } from '../router/strategies.js';
import { CacheOrchestrator } from '../cache/orchestrator.js';
import { ExactCache } from '../cache/exact.js';
import { fingerprint } from '../ir/normalize.js';
import { createAdapter, type ProviderAdapter } from '../adapters/index.js';
import { createClientSerializer, type ClientSerializer } from '../clients/index.js';
import { HttpProviderConnector } from '../connector/index.js';
import { log } from '../utils/logger.js';
import type { IRRequest, IRResponse } from '../ir/types.js';
import type { ClientProtocol, Protocol } from '../config/types.js';
import type { UpstreamModelIndexEntry } from '../storage/indexes.js';
import { VirtualModelIndex, UpstreamModelIndex, AvailabilityCache } from '../storage/indexes.js';

export interface PipelineDeps {
  db: Database;
  repos: Repositories;
  registry: Registry;
  config: {
    cacheEnabled: boolean;
    cacheTtlSeconds: number;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
  };
}

export interface DispatchInput {
  requestId: string;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  body: unknown;
  params: Record<string, string>;
}

export interface DispatchResult {
  handled: boolean;
}

interface RouterState {
  nextCounter: Map<string, number>;
  random: () => number;
}

function createRouterState(): RouterState {
  return {
    nextCounter: new Map(),
    random: () => Math.random(),
  };
}

export function createPipeline(deps: PipelineDeps) {
  const state = createRouterState();
  const rateLimiter = new RateLimiter();
  const budgetTracker = new BudgetTracker(
    deps.repos.keys,
    deps.repos.events,
    deps.repos.budget,
  );
  const exactCache = new ExactCache(deps.repos.cache);
  const cacheOrchestrator = new CacheOrchestrator({
    db: deps.db,
    exact: exactCache,
  });

  const vmIdx = VirtualModelIndex.fromRepositories(deps.repos);
  const umIdx = UpstreamModelIndex.fromRepositories(deps.repos);
  const availability = AvailabilityCache.fromRepositories(deps.repos);

  const connector = new HttpProviderConnector({
    defaultTimeoutMs: deps.config.requestTimeoutMs,
  });

  async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const { req, res, pathname, body } = input;

    // 1. Parse request body
    const jsonBody = body as Record<string, unknown> | null;
    if (!jsonBody) {
      return { handled: false };
    }

    const modelId = String(jsonBody['model'] ?? '').trim();
    if (!modelId) {
      writeJsonError(res, 400, 'missing_model', 'model is required');
      return { handled: true };
    }

    // 2. Auth
    const authResult = authenticateRequest(
      {
        authorizationHeader: req.headers['authorization'],
        modelId,
        estimatedTokens: 100,
        estimatedCostUsd: 0,
      },
      {
        keys: deps.repos.keys,
        rateLimiter,
        budget: budgetTracker,
      },
    );

    if (!authResult.ok) {
      const rejection = authResult as AuthRejection;
      writeJsonError(res, rejection.statusCode, rejection.errorCode, rejection.message);
      if (rejection.headers) {
        for (const [k, v] of Object.entries(rejection.headers)) {
          res.setHeader(k, v);
        }
      }
      return { handled: true };
    }

    const authCtx = authResult as AuthContext;

    // 3. Determine client protocol
    const clientProtocol = inferClientProtocol(pathname);
    if (!clientProtocol) {
      writeJsonError(res, 404, 'route_not_found', `No client protocol for ${pathname}`);
      return { handled: true };
    }

    // 4. Parse IR request
    const serializer = createClientSerializer(clientProtocol);
    let irReq: IRRequest;
    try {
      irReq = serializer.parseIncomingRequest(jsonBody);
    } catch (e) {
      writeJsonError(res, 400, 'invalid_request', e instanceof Error ? e.message : 'Invalid request body');
      return { handled: true };
    }

    // 5. Cache lookup
    const fp = fingerprint(irReq);
    const cacheLookup = cacheOrchestrator.lookup({
      virtualModelId: modelId,
      request: irReq,
      fingerprint: fp,
      keyId: authCtx.key.id,
      clientProtocol,
    });

    if (cacheLookup.kind === 'exact') {
      const cachedResp = cacheLookup.response as IRResponse;
      const clientResp = serializer.serializeResponse(cachedResp, {
        upstreamModel: modelId,
        model: modelId,
        latencyMs: 0,
      });
      writeJsonResponse(res, clientResp as Record<string, unknown>, {
        'X-Gateway-Cache': 'hit',
        'X-Gateway-Model': modelId,
      });
      return { handled: true };
    }

    // 6. Route to upstream
    let decision: RoutingDecision;
    try {
      decision = route(
        { modelId },
        {
          virtualModels: vmIdx as never,
          upstreamModels: umIdx as never,
          availability: availability as never,
          nextCounter: (vmId) => {
            const current = state.nextCounter.get(vmId) ?? 0;
            state.nextCounter.set(vmId, current + 1);
            return current;
          },
          random: state.random,
        },
      );
    } catch (e) {
      if (e instanceof RoutingError) {
        writeJsonError(res, 502, 'all_upstreams_unavailable', e.message);
      } else {
        writeJsonError(res, 500, 'internal_error', e instanceof Error ? e.message : 'Internal error');
      }
      return { handled: true };
    }

    // 7. Get adapter
    const upstreamProtocol = decision.upstream.providerProtocol as Protocol;
    let adapter: ProviderAdapter;
    try {
      adapter = createAdapter(upstreamProtocol);
    } catch (e) {
      writeJsonError(res, 500, 'adapter_error', `No adapter for ${upstreamProtocol}`);
      return { handled: true };
    }

    // 8. Build upstream request
    const envelope = adapter.buildRequestBody(irReq);
    if (!envelope.body) {
      writeJsonError(res, 500, 'adapter_error', 'Failed to build request body');
      return { handled: true };
    }

    // 9. Get provider and API key
    const providerRow = deps.repos.providers.getById(decision.upstream.providerId);
    if (!providerRow) {
      writeJsonError(res, 500, 'provider_not_found', `Provider ${decision.upstream.providerId} not found`);
      return { handled: true };
    }

    // 10. Call upstream
    const startTime = Date.now();
    let callOutcome: Awaited<ReturnType<typeof connector.call>>;
    try {
      callOutcome = await connector.call(
        adapter,
        irReq,
        providerRow.api_key_ciphertext,
        providerRow.base_url,
        {
          requestId: input.requestId,
        },
      );
    } catch (e) {
      const latencyMs = Date.now() - startTime;
      log.error('upstream_error', { requestId: input.requestId, model: modelId, error: e instanceof Error ? e.message : String(e), latencyMs });
      writeJsonError(res, 502, 'upstream_error', e instanceof Error ? e.message : 'Upstream error');
      return { handled: true };
    }

    const latencyMs = Date.now() - startTime;

    // 11. Handle call outcome
    if (callOutcome.kind !== 'success') {
      log.error('upstream_error', {
        requestId: input.requestId,
        model: modelId,
        kind: callOutcome.kind,
        latencyMs,
      });
      if (callOutcome.kind === 'circuit_open') {
        writeJsonError(res, 503, 'circuit_open', `Circuit open for ${callOutcome.vendorId}`);
      } else if (callOutcome.kind === 'network_error') {
        writeJsonError(res, 502, 'network_error', callOutcome.error.message);
      } else if (callOutcome.kind === 'http_error') {
        writeJsonError(res, callOutcome.status, 'upstream_error', `Upstream returned ${callOutcome.status}`);
      } else {
        writeJsonError(res, 502, 'parse_error', 'Failed to parse upstream response');
      }
      return { handled: true };
    }

    const irResp = callOutcome.response;

    // 12. Store in cache
    if (!irReq.stream && deps.config.cacheEnabled) {
      try {
        cacheOrchestrator.store(
          {
            virtualModelId: modelId,
            request: irReq,
            fingerprint: fp,
            keyId: authCtx.key.id,
            clientProtocol,
          },
          irResp,
        );
      } catch {}
    }

    // 13. Serialize to client protocol
    const clientResp = serializer.serializeResponse(irResp, {
      upstreamModel: decision.upstream.upstreamModelName,
      model: modelId,
      latencyMs,
    });

    // 14. Write response
    const responseHeaders: Record<string, string> = {
      'X-Gateway-Model': modelId,
      'X-Gateway-Routed-Provider': decision.upstream.providerId,
      'X-Gateway-Routed-Model': decision.upstream.upstreamModelName,
      'X-Gateway-Latency-Ms': String(latencyMs),
      'X-Gateway-Cache': 'miss',
    };
    writeJsonResponse(res, clientResp as Record<string, unknown>, responseHeaders);

    // 15. Record usage
    recordUsage(deps.repos, {
      requestId: input.requestId,
      keyId: authCtx.key.id,
      virtualModelId: modelId,
      upstreamProviderId: decision.upstream.providerId,
      upstreamModelId: decision.upstream.modelId,
      clientProtocol,
      promptTokens: irResp.usage?.promptTokens ?? 0,
      completionTokens: irResp.usage?.completionTokens ?? 0,
      cachedTokens: irResp.usage?.cachedTokens ?? 0,
      totalTokens: irResp.usage?.totalTokens ?? 0,
      costUsd: 0,
      statusCode: callOutcome.status,
      latencyMs,
      cacheHit: null,
    });

    return { handled: true };
  }

  return { dispatch };
}

function inferClientProtocol(pathname: string): ClientProtocol | null {
  if (pathname === '/v1/chat/completions') return 'OpenAI-Chat';
  if (pathname === '/v1/responses') return 'OpenAI-Responses';
  if (pathname === '/v1/messages') return 'Anthropic-Messages';
  if (pathname.startsWith('/v1beta/models/')) return 'Gemini-GenerateContent';
  return null;
}

function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { type: code, code, message } });
  res.statusCode = status;
  res.statusMessage = getStatusCodeText(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function writeJsonResponse(res: ServerResponse, body: Record<string, unknown>, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers ?? {})) {
    res.setHeader(k, v);
  }
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function getStatusCodeText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    413: 'Payload Too Large', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return texts[status] ?? 'Error';
}

interface UsageRecord {
  requestId: string;
  keyId: string;
  virtualModelId: string;
  upstreamProviderId: string;
  upstreamModelId: string;
  clientProtocol: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  statusCode: number;
  latencyMs: number;
  cacheHit: string | null;
}

function recordUsage(repos: Repositories, record: UsageRecord): void {
  try {
    repos.usage.append({
      requestId: record.requestId,
      keyId: record.keyId,
      virtualModelId: record.virtualModelId,
      upstreamProviderId: record.upstreamProviderId,
      upstreamModelId: record.upstreamModelId,
      clientProtocol: record.clientProtocol as any,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      cachedTokens: record.cachedTokens,
      totalTokens: record.totalTokens,
      costUsd: record.costUsd,
      source: 'gateway' as any,
      cacheHit: record.cacheHit as any,
      latencyMs: record.latencyMs,
      statusCode: record.statusCode,
    });
  } catch (e) {
    log.error('usage_insert_error', { error: e instanceof Error ? e.message : String(e) });
  }
}
