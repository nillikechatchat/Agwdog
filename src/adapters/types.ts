import type { IRRequest, IRResponse, IRStreamEvent } from '../ir/types.js';

/**
 * A Provider Adapter converts between the gateway's internal IR and one
 * specific upstream API format. The interface is intentionally minimal so the
 * six concrete adapters (OpenAI, OpenAI-Compatible, Anthropic, Gemini,
 * Doubao, Wenxin) can share most of their logic through composition.
 */
export interface ProviderAdapter {
  /**
   * Build the JSON-serializable request body for the upstream HTTP call.
   * Streaming requests still get a JSON body (the OpenAI/Anthropic protocol
   * uses `stream: true` in the body, not chunked transfer).
   */
  buildRequestBody(ir: IRRequest): ProviderRequestEnvelope;

  /**
   * Build the HTTP headers (auth + content-type) for the upstream call.
   * The API key is passed in already-decrypted.
   */
  buildRequestHeaders(ir: IRRequest, apiKey: string): Record<string, string>;

  /**
   * Return the path (no host) to POST to. Most providers use the same path
   * for all models, but some (Gemini, Wenxin) embed the model in the URL.
   */
  endpointPath(ir: IRRequest): string;

  /**
   * Parse a non-streaming JSON response into an IRResponse.
   * Throws AdapterError when the body is malformed.
   */
  parseResponse(raw: unknown): IRResponse;

  /**
   * Parse a single SSE event (already JSON-decoded from the `data:` line) into
   * an IRStreamEvent. Returns null for events that carry no payload (e.g. the
   * terminal `[DONE]` sentinel, heartbeat comments, etc.).
   */
  parseStreamEvent(raw: unknown): IRStreamEvent | null;
}

export interface ProviderRequestEnvelope {
  body: unknown;
  stream: boolean;
}

export class AdapterError extends Error {
  constructor(public readonly provider: string, public readonly statusCode: number | null, message: string, public readonly cause?: unknown) {
    super(`[${provider}] ${message}`);
  }
}
