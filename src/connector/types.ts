import type { IRRequest, IRResponse, IRStreamEvent } from '../ir/types.js';
import type { ProviderAdapter } from '../adapters/types.js';

/**
 * The outcome of a single upstream call attempt. Used by the retry layer to
 * decide whether to retry, fail-over, or surface the error to the client.
 */
export type CallOutcome =
  | { kind: 'success'; response: IRResponse; latencyMs: number; status: number }
  | { kind: 'http_error'; status: number; body: unknown; latencyMs: number; retryable: boolean; retryAfterMs?: number }
  | { kind: 'network_error'; error: Error; latencyMs: number; retryable: boolean }
  | { kind: 'parse_error'; error: Error; latencyMs: number; raw: string }
  | { kind: 'circuit_open'; vendorId: string };

export interface ConnectorCallOptions {
  /** Override the per-attempt timeout (ms). */
  timeoutMs?: number;
  /** Abort signal from the caller (e.g. client disconnect). */
  signal?: AbortSignal;
  /** Trace id propagated to the upstream via `x-request-id`. */
  requestId?: string;
  /** Skip the in-connector retry loop; useful for the router's own failure detection. */
  disableRetry?: boolean;
  /** Skip the circuit-breaker check (e.g. health probes). */
  bypassCircuit?: boolean;
}

export interface StreamChunk {
  /** Decoded IR stream event, or `null` if this chunk is a usage tick / heartbeat. */
  event: IRStreamEvent | null;
  /** Raw SSE event name (e.g. `message_start`, `data`). */
  sseEvent: string;
  /** Raw `data:` line payload (string, not yet JSON-parsed). */
  sseData: string;
}

export interface ProviderConnector {
  /**
   * Make a single non-streaming call to the upstream provider.
   */
  call(
    adapter: ProviderAdapter,
    request: IRRequest,
    apiKey: string,
    baseUrl: string,
    options?: ConnectorCallOptions,
  ): Promise<CallOutcome>;

  /**
   * Make a streaming call. The returned async iterable yields decoded SSE
   * events; the caller is responsible for emitting them to the client.
   */
  stream(
    adapter: ProviderAdapter,
    request: IRRequest,
    apiKey: string,
    baseUrl: string,
    options?: ConnectorCallOptions,
  ): AsyncIterable<StreamChunk>;

  /**
   * Force a circuit-breaker transition (admin / health endpoint).
   */
  resetCircuit(vendorId: string): void;
  getCircuitState(vendorId: string): CircuitState;
}

export type CircuitState = 'closed' | 'open' | 'half-open';
