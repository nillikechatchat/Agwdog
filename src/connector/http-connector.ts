import type { ProviderAdapter } from '../adapters/types.js';
import type { IRRequest } from '../ir/types.js';
import { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from './circuit-breaker.js';
import { VendorRateLimiter, DEFAULT_VENDOR_BUCKET, type TokenBucketConfig } from './token-bucket.js';
import {
  DEFAULT_RETRY_CONFIG,
  RetryConfig,
  computeBackoff,
  isRetryableStatus,
  parseRetryAfter,
  sleep,
} from './retry.js';
import { SSEDecoder } from './sse-decoder.js';
import type {
  CallOutcome,
  CircuitState,
  ConnectorCallOptions,
  ProviderConnector,
  StreamChunk,
} from './types.js';

export interface HttpConnectorDeps {
  /** HTTP fetch implementation; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Default per-attempt timeout (ms). */
  defaultTimeoutMs: number;
  /** Retry config. */
  retry?: RetryConfig;
  /** Per-vendor rate limit. */
  vendorRateLimit?: TokenBucketConfig;
  /** Circuit-breaker config. */
  circuit?: ConstructorParameters<typeof CircuitBreaker>[0];
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpProviderConnector implements ProviderConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly rateLimiter: VendorRateLimiter;
  private readonly circuit: CircuitBreaker;
  private readonly vendorBuckets = new Map<string, TokenBucketConfig>();

  constructor(deps: HttpConnectorDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HttpProviderConnector: no fetch implementation available');
    }
    this.defaultTimeoutMs = deps.defaultTimeoutMs;
    this.retry = deps.retry ?? DEFAULT_RETRY_CONFIG;
    this.rateLimiter = new VendorRateLimiter(deps.vendorRateLimit ?? DEFAULT_VENDOR_BUCKET);
    this.circuit = new CircuitBreaker(deps.circuit ?? DEFAULT_CIRCUIT_CONFIG);
  }

  setVendorBucket(vendorId: string, cfg: TokenBucketConfig): void {
    this.vendorBuckets.set(vendorId, cfg);
  }

  resetCircuit(vendorId: string): void {
    this.circuit.reset(vendorId);
  }

  getCircuitState(vendorId: string): CircuitState {
    return this.circuit.stateOf(vendorId);
  }

  async call(
    adapter: ProviderAdapter,
    request: IRRequest,
    apiKey: string,
    baseUrl: string,
    options: ConnectorCallOptions = {},
  ): Promise<CallOutcome> {
    const vendorId = this.vendorId(adapter);
    if (!options.bypassCircuit && !this.circuit.allow(vendorId)) {
      return { kind: 'circuit_open', vendorId };
    }
    await this.rateLimitWait(vendorId, options.signal);

    const envelope = adapter.buildRequestBody(request);
    const headers = adapter.buildRequestHeaders(request, apiKey);
    const path = adapter.endpointPath(request);
    const url = joinUrl(baseUrl, path);
    const body = JSON.stringify(envelope.body);
    const isStream = request.stream === true;
    const finalHeaders: Record<string, string> = { ...headers };
    if (options.requestId) finalHeaders['x-request-id'] = options.requestId;
    if (isStream) finalHeaders['accept'] = 'text/event-stream';

    let lastOutcome: CallOutcome | undefined;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const upstreamSignal = options.signal
        ? combineSignals(controller.signal, options.signal)
        : controller.signal;
      const start = Date.now();
      let outcome: CallOutcome;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: finalHeaders,
          body,
          signal: upstreamSignal,
        });
        const latencyMs = Date.now() - start;
        const text = await res.text();
        if (res.ok) {
          let parsed: unknown;
          try { parsed = text.length === 0 ? {} : JSON.parse(text); }
          catch (e) {
            outcome = { kind: 'parse_error', error: e as Error, latencyMs, raw: text };
            this.circuit.recordFailure(vendorId);
            return outcome;
          }
          try {
            const response = adapter.parseResponse(parsed, request);
            this.circuit.recordSuccess(vendorId);
            return { kind: 'success', response, latencyMs, status: res.status };
          } catch (e) {
            outcome = { kind: 'parse_error', error: e as Error, latencyMs, raw: text };
            this.circuit.recordFailure(vendorId);
            return outcome;
          }
        }
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        let bodyParsed: unknown = text;
        try { bodyParsed = text.length === 0 ? null : JSON.parse(text); } catch { /* leave as text */ }
        outcome = {
          kind: 'http_error',
          status: res.status,
          body: bodyParsed,
          latencyMs,
          retryable: isRetryableStatus(res.status),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const error = err instanceof Error ? err : new Error(String(err));
        outcome = {
          kind: 'network_error',
          error,
          latencyMs,
          retryable: error.name !== 'AbortError' || !options.signal?.aborted,
        };
      } finally {
        clearTimeout(timer);
      }

      lastOutcome = outcome;
      const retryable = outcome.kind === 'network_error' || (outcome.kind === 'http_error' && outcome.retryable);
      const isLast = attempt === this.retry.maxAttempts;
      if (!retryable || isLast || options.disableRetry) {
        if (retryable) this.circuit.recordFailure(vendorId);
        else this.circuit.recordSuccess(vendorId);
        return outcome;
      }
      const retryAfterMs = outcome.kind === 'http_error' ? outcome.retryAfterMs : undefined;
      const delay = computeBackoff(attempt, this.retry, retryAfterMs);
      this.circuit.recordFailure(vendorId);
      try {
        await sleep(delay, options.signal);
      } catch {
        return { kind: 'network_error', error: new Error('aborted'), latencyMs: Date.now() - start, retryable: false };
      }
    }
    return lastOutcome ?? { kind: 'network_error', error: new Error('exhausted'), latencyMs: 0, retryable: false };
  }

  async *stream(
    adapter: ProviderAdapter,
    request: IRRequest,
    apiKey: string,
    baseUrl: string,
    options: ConnectorCallOptions = {},
  ): AsyncIterable<StreamChunk> {
    const vendorId = this.vendorId(adapter);
    if (!options.bypassCircuit && !this.circuit.allow(vendorId)) {
      throw new CircuitOpenError(vendorId);
    }
    await this.rateLimitWait(vendorId, options.signal);

    const envelope = adapter.buildRequestBody({ ...request, stream: true });
    const headers = adapter.buildRequestHeaders(request, apiKey);
    const path = adapter.endpointPath(request);
    const url = joinUrl(baseUrl, path);
    const body = JSON.stringify(envelope.body);
    const finalHeaders: Record<string, string> = { ...headers, accept: 'text/event-stream' };
    if (options.requestId) finalHeaders['x-request-id'] = options.requestId;

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const upstreamSignal = options.signal
      ? combineSignals(controller.signal, options.signal)
      : controller.signal;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: finalHeaders,
      body,
      signal: upstreamSignal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text();
      this.circuit.recordFailure(vendorId);
      throw new UpstreamHttpError(res.status, text);
    }
    this.circuit.recordSuccess(vendorId);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const sse = new SSEDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const ev of sse.push(text)) {
          yield mapEvent(adapter, request, ev);
        }
      }
      const trailing = sse.end();
      if (trailing) yield mapEvent(adapter, request, trailing);
    } finally {
      clearTimeout(timer);
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }

  private async rateLimitWait(vendorId: string, signal?: AbortSignal): Promise<void> {
    const cfg = this.vendorBuckets.get(vendorId);
    if (cfg) this.rateLimiter.bucketFor(vendorId, cfg);
    await this.rateLimiter.waitFor(vendorId, signal);
  }

  private vendorId(adapter: ProviderAdapter): string {
    return adapter.protocol;
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly vendorId: string) { super(`circuit open for ${vendorId}`); }
}

export class UpstreamHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) { super(`upstream ${status}`); }
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  const onA = () => c.abort(a.reason);
  const onB = () => c.abort(b.reason);
  if (a.aborted) c.abort(a.reason);
  else a.addEventListener('abort', onA, { once: true });
  if (b.aborted) c.abort(b.reason);
  else b.addEventListener('abort', onB, { once: true });
  return c.signal;
}

function mapEvent(adapter: ProviderAdapter, request: IRRequest, ev: { event: string; data: string }): StreamChunk {
  if (ev.data === '[DONE]') {
    return { event: null, sseEvent: ev.event, sseData: ev.data };
  }
  let parsed: unknown = ev.data;
  if (ev.data.length > 0) {
    try { parsed = JSON.parse(ev.data); } catch { /* keep raw */ }
  }
  let ir: import('../ir/types.js').IRStreamEvent | null = null;
  try { ir = adapter.parseStreamEvent(parsed, request); } catch { /* leave null */ }
  return { event: ir, sseEvent: ev.event, sseData: ev.data };
}
