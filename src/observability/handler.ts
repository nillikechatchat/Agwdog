import type { Registry } from './registry.js';
import { renderPrometheus } from './prometheus.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Tiny dispatcher for the Prometheus scrape endpoint. Mounts at `/metrics`
 * (and `/v1/metrics` for symmetry with the rest of the API surface).
 */
export function makeMetricsHandler(registry: Registry) {
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '';
    if (url === '/metrics' || url === '/v1/metrics') {
      const body = renderPrometheus(registry);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(body);
      return true;
    }
    return false;
  };
}
