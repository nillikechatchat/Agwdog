import type { IRRequest, IRResponse, IRStreamEvent } from '../ir/types.js';

/**
 * A Client Serializer converts between the gateway's internal IR and the wire
 * format expected by one of the 4 outbound Client Protocols:
 *
 *  - OpenAI Chat Completions
 *  - OpenAI Responses
 *  - Anthropic Messages
 *  - Gemini GenerateContent
 *
 * The interface mirrors `ProviderAdapter` but in reverse: we build bodies the
 * *client* sends to *us*, and we shape the response we send back to them.
 */
export interface ClientSerializer {
  /**
   * Path on the gateway that this serializer handles. The router already maps
   * the path to a handler; the serializer itself is unaware of routing.
   */
  readonly protocol: ClientProtocol;

  /**
   * Build the JSON body that we expect the client to send. Used to validate /
   * parse the incoming request before the IR conversion.
   */
  buildExpectedRequestBodyShape(): ExpectedRequestShape;

  /**
   * Parse the raw JSON body the client posted into the gateway's IRRequest.
   * Throws SerializerError when the body is malformed.
   */
  parseIncomingRequest(raw: unknown): IRRequest;

  /**
   * Serialize an IRResponse into the JSON body we send back to the client.
   */
  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown;

  /**
   * Serialize an `IRStreamEvent` into a single SSE event payload (the part
   * after the `data: ` line in a Server-Sent-Events response). Return `null`
   * for events that should be suppressed (e.g. intermediate usage ticks that
   * the client protocol has no slot for).
   */
  serializeStreamEvent(ev: IRStreamEvent, state: StreamState): ClientSseEvent | null;

  /**
   * Return the final SSE event for a completed stream (the `[DONE]` sentinel
   * in OpenAI, the `message_stop` event in Anthropic, etc.).
   */
  terminalStreamEvent(): ClientSseEvent | null;
}

export type ClientProtocol =
  | 'OpenAI-Chat'
  | 'OpenAI-Responses'
  | 'Anthropic-Messages'
  | 'Gemini-GenerateContent';

export interface ExpectedRequestShape {
  /** Loose description of the expected fields; used for error messages only. */
  description: string;
}

export interface ResponseMeta {
  /** The virtual model name the client originally requested. */
  model: string;
  /** The upstream model that actually served the request. */
  upstreamModel: string;
  /** Wall-clock duration of the request in ms (latency). */
  latencyMs: number;
  /** Time to first byte in ms (streaming only). */
  ttftMs?: number;
}

export interface ClientSseEvent {
  /** SSE event name (e.g. `message_start`, `data`, etc.). Empty string for unnamed events. */
  event: string;
  /** The data payload (will be JSON-stringified). */
  data: unknown;
  /** Optional explicit `id:` line. */
  id?: string;
}

/**
 * Per-stream mutable state shared between consecutive `serializeStreamEvent`
 * calls. Serializers use this to thread an accumulating response id, the
 * current text block, etc.
 */
export interface StreamState {
  responseId: string;
  model: string;
  /** Output-item id, for Responses API. */
  outputItemId?: string;
  /** Tool-use id currently being streamed. */
  toolUseId?: string;
  /** True after the terminal event has been emitted. */
  done: boolean;
}

export class SerializerError extends Error {
  constructor(public readonly protocol: string, message: string, public readonly cause?: unknown) {
    super(`[${protocol}] ${message}`);
  }
}
