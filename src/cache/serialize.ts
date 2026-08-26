import type { ServerResponse } from 'node:http';
import type { CacheHit } from './exact.js';
import type { ClientProtocol } from '../storage/types.js';

/**
 * Format a cache hit for the wire. OpenAI Chat Completions and OpenAI Responses
 * respond with JSON; Anthropic Messages responds with JSON; Gemini
 * GenerateContent also responds with JSON. Streaming endpoints (which never
 * hit the cache) are not handled here.
 *
 * The response is sent with `X-Gateway-Cache: hit` so observability tooling
 * can attribute latency to the cache layer.
 */
export function writeCacheHit(
  res: ServerResponse,
  protocol: ClientProtocol,
  hit: CacheHit,
): void {
  const body = JSON.stringify(hit.response);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    'x-gateway-cache': 'hit',
    'x-gateway-cache-age-ms': String(hit.age),
  };
  res.writeHead(200, headers);
  res.end(body);
}
