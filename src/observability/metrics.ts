import { Registry, type HistogramOptions, DEFAULT_BUCKETS } from './registry.js';

export interface GatewayMetrics {
  requestsTotal: ReturnType<Registry['counter']>;
  errorsTotal: ReturnType<Registry['counter']>;
  cacheHitsTotal: ReturnType<Registry['counter']>;
  cacheMissesTotal: ReturnType<Registry['counter']>;
  budgetBlocksTotal: ReturnType<Registry['counter']>;
  rateLimitBlocksTotal: ReturnType<Registry['counter']>;
  requestDuration: ReturnType<Registry['histogram']>;
  tokensTotal: ReturnType<Registry['counter']>;
  costUsdTotal: ReturnType<Registry['counter']>;
  upstreamLatency: ReturnType<Registry['histogram']>;
  circuitState: ReturnType<Registry['gauge']>;
}

const DEFAULT_OPTS: HistogramOptions = { buckets: [...DEFAULT_BUCKETS, 60] };

export function registerGatewayMetrics(registry: Registry): GatewayMetrics {
  return {
    requestsTotal: registry.counter('gateway_requests_total', 'Total requests served by the gateway', ['method', 'path', 'status']),
    errorsTotal: registry.counter('gateway_errors_total', 'Total error responses', ['method', 'path', 'code']),
    cacheHitsTotal: registry.counter('gateway_cache_hits_total', 'Cache hits by layer', ['layer']),
    cacheMissesTotal: registry.counter('gateway_cache_misses_total', 'Cache misses by layer', ['layer']),
    budgetBlocksTotal: registry.counter('gateway_budget_blocks_total', 'Requests blocked by budget enforcement', ['key_id']),
    rateLimitBlocksTotal: registry.counter('gateway_rate_limit_blocks_total', 'Requests blocked by rate limiting', ['key_id', 'reason']),
    requestDuration: registry.histogram('gateway_request_duration_seconds', 'Wall-clock duration of HTTP requests in seconds', ['method', 'path'], DEFAULT_OPTS),
    tokensTotal: registry.counter('gateway_tokens_total', 'Tokens consumed by type', ['type']),
    costUsdTotal: registry.counter('gateway_cost_usd_total', 'Estimated cost in USD', ['vendor']),
    upstreamLatency: registry.histogram('gateway_upstream_duration_seconds', 'Upstream provider latency', ['vendor', 'model', 'status'], DEFAULT_OPTS),
    circuitState: registry.gauge('gateway_circuit_state', 'Circuit breaker state per vendor (0=closed, 1=half-open, 2=open)', ['vendor']),
  };
}
