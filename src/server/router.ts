/**
 * Route matching for the HTTP server.
 *
 * The router uses a tiny trie-free matcher: each route declares a pattern
 * with `:name` placeholders, and `match(path, pattern)` returns a params map
 * or `null`. This keeps startup cost at O(routes) without pulling in Express,
 * Fastify, or find-my-way.
 *
 * Patterns:
 *   - `:` matches a single path segment (not nested under `/`)
 *   - `*` is a trailing wildcard (e.g. `/admin/api/*` → params = { rest: 'foo/bar' })
 *   - Otherwise the segment must match verbatim
 */

export interface RouteMatch {
  pattern: string;
  params: Record<string, string>;
}

export function match(pathname: string, pattern: string): RouteMatch | null {
  const pathSegs = pathname.split('/').filter(Boolean);
  const patSegs = pattern.split('/').filter(Boolean);

  // Special-case trailing wildcard: `/admin/api/*` or `/admin/api/*rest`
  if (patSegs.length > 0 && patSegs[patSegs.length - 1] === '*') {
    if (pathSegs.length < patSegs.length - 1) return null;
    for (let i = 0; i < patSegs.length - 1; i++) {
      if (!segmentMatches(pathSegs[i] ?? '', patSegs[i] ?? '')) return null;
    }
    const rest = pathSegs.slice(patSegs.length - 1).join('/');
    return { pattern, params: { rest } };
  }

  if (patSegs[patSegs.length - 1]?.startsWith('*')) {
    // `/admin/api/*rest` — named wildcard without leading slash separator
    const namedRest = patSegs[patSegs.length - 1]?.slice(1) ?? 'rest';
    if (pathSegs.length < patSegs.length - 1) return null;
    for (let i = 0; i < patSegs.length - 1; i++) {
      if (!segmentMatches(pathSegs[i] ?? '', patSegs[i] ?? '')) return null;
    }
    const rest = pathSegs.slice(patSegs.length - 1).join('/');
    return { pattern, params: { [namedRest]: rest } };
  }

  if (pathSegs.length !== patSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    const ps = patSegs[i] ?? '';
    const cs = pathSegs[i] ?? '';
    if (ps.startsWith(':')) {
      params[ps.slice(1)] = decodeURIComponent(cs);
    } else if (ps !== cs) {
      return null;
    }
  }
  return { pattern, params };
}

function segmentMatches(actual: string, expected: string): boolean {
  if (expected.startsWith(':')) return actual.length > 0;
  return expected === actual;
}

/** HTTP method names we care about. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface Route {
  method: HttpMethod;
  pattern: string;
  handler: string;
  /** Optional post-processing of captured params (e.g. splitting a colon-bearing value). */
  transformParams?: (params: Record<string, string>) => Record<string, string>;
}

/**
 * Canonical route table for ai-gateway.
 *
 * Pattern order matters only when two routes share a method and prefix — the
 * router scans the table in declaration order and stops at the first match.
 * `handler` is an opaque string the caller maps to a concrete function.
 */
export const ROUTE_TABLE: Route[] = [
  // ── Client Protocol endpoints (4 families) ─────────────────────────────
  { method: 'POST', pattern: '/v1/chat/completions',          handler: 'openaiChat' },
  { method: 'POST', pattern: '/v1/responses',                 handler: 'openaiResponses' },
  { method: 'GET',  pattern: '/v1/responses/:id',            handler: 'openaiResponsesGet' },
  { method: 'POST', pattern: '/v1/messages',                  handler: 'anthropicMessages' },
  { method: 'POST', pattern: '/v1/messages/count_tokens',     handler: 'anthropicCountTokens' },
  // Gemini uses a single-segment `models/<model>:<action>` form; the colon is part of the URL.
  { method: 'POST', pattern: '/v1beta/models/:modelAndAction',  handler: 'geminiGenerate',
    transformParams: (p) => {
      const joined = p['modelAndAction'] ?? '';
      const colonIdx = joined.lastIndexOf(':');
      if (colonIdx === -1) return { model: joined, action: '' };
      return { model: joined.slice(0, colonIdx), action: joined.slice(colonIdx + 1) };
    },
  },
  { method: 'GET',  pattern: '/v1/models',                    handler: 'listModels' },
  { method: 'GET',  pattern: '/v1beta/models',                handler: 'listGeminiModels' },

  // ── Admin + Observability ───────────────────────────────────────────────
  // adminApi must come before adminStatic since adminStatic's `/admin/*rest`
  // would otherwise match `/admin/api/...` first.
  { method: 'POST', pattern: '/admin/api/*rest',              handler: 'adminApi' },
  { method: 'GET',  pattern: '/admin/api/*rest',              handler: 'adminApi' },
  { method: 'PUT',  pattern: '/admin/api/*rest',              handler: 'adminApi' },
  { method: 'PATCH',pattern: '/admin/api/*rest',              handler: 'adminApi' },
  { method: 'DELETE',pattern:'/admin/api/*rest',              handler: 'adminApi' },
  { method: 'GET',  pattern: '/admin',                        handler: 'adminIndex' },
  { method: 'GET',  pattern: '/admin/*rest',                  handler: 'adminStatic' },
  { method: 'GET',  pattern: '/metrics',                      handler: 'prometheusMetrics' },
  { method: 'GET',  pattern: '/healthz',                      handler: 'healthz' },
];

export function resolveRoute(method: HttpMethod, pathname: string): { handler: string; params: Record<string, string> } | null {
  for (const route of ROUTE_TABLE) {
    if (route.method !== method) continue;
    const m = match(pathname, route.pattern);
    if (!m) continue;
    const params = route.transformParams ? route.transformParams(m.params) : m.params;
    return { handler: route.handler, params };
  }
  return null;
}