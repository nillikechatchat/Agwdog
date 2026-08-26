import type { IncomingMessage, ServerResponse } from 'node:http';
import { renderPrometheus } from './prometheus.js';
import type { Registry } from './registry.js';
import type { GatewayMetrics } from './metrics.js';

export interface MetricsMiddlewareOptions {
  registry: Registry;
  metrics: GatewayMetrics;
  /** When true, wrap the request and record duration / status. */
  observeRequests: boolean;
}

/**
 * Wrap a single HTTP request to record duration + status + tokens. Returns
 * a `close` listener that records once the response is finalised.
 */
export function instrumentRequest(
  options: MetricsMiddlewareOptions,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { method: string; path: string },
): void {
  if (!options.observeRequests) return;
  const start = process.hrtime.bigint();
  res.on('close', () => {
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
    options.metrics.requestDuration.observe({ method: ctx.method, path: ctx.path }, elapsedSec);
    options.metrics.requestsTotal.inc({ method: ctx.method, path: ctx.path, status: String(res.statusCode) });
    if (res.statusCode >= 500) {
      options.metrics.errorsTotal.inc({ method: ctx.method, path: ctx.path, code: String(res.statusCode) });
    }
  });
}

/** Write the Prometheus text format to a response. */
export function writePrometheusResponse(
  registry: Registry,
  res: ServerResponse,
  status: number = 200,
  contentType: string = 'text/plain; version=0.0.4; charset=utf-8',
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(renderPrometheus(registry));
}
