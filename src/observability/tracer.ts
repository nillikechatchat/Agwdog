import { randomUUID } from 'node:crypto';
import { Registry } from './registry.js';

/**
 * OTel-style semantic-attribute tracer for generative-AI requests.
 *
 * The OpenTelemetry GenAI semantic conventions define a stable set of
 * attribute names (gen_ai.system, gen_ai.request.model, gen_ai.usage.input_tokens,
 * etc.). We surface those attributes through a `Tracer` interface so other
 * components can attach them to spans without depending on the OTel SDK.
 *
 * A `Span` is a thin record: start/end time, status, attributes. The tracer
 * records each span; consumers (OTLP exporter, logs, etc.) can drain them.
 */

export const GEN_AI_ATTRIBUTES = {
  system: 'gen_ai.system',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  operation: 'gen_ai.operation.name',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  totalTokens: 'gen_ai.usage.total_tokens',
  cachedInputTokens: 'gen_ai.usage.cached_input_tokens',
  finishReasons: 'gen_ai.response.finish_reasons',
  requestTemperature: 'gen_ai.request.temperature',
  requestTopP: 'gen_ai.request.top_p',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  clientProtocol: 'gen_ai.client.protocol',
  upstreamVendor: 'gen_ai.upstream.vendor',
  cacheHit: 'gen_ai.cache.hit',
} as const;

export type SpanStatus = 'ok' | 'error';

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean | null>;
  events: Array<{ name: string; at: number; attributes?: Record<string, string | number | boolean> }>;
}

export interface TracerConfig {
  /** Maximum number of completed spans to retain. Older spans are dropped. */
  maxSpans: number;
}

export const DEFAULT_TRACER_CONFIG: TracerConfig = { maxSpans: 1000 };

export class Tracer {
  private readonly spans: Span[] = [];
  private readonly liveSpans = new Map<string, Span>();
  private spansCounter?: ReturnType<Registry['counter']>;
  private durationHist?: ReturnType<Registry['histogram']>;
  constructor(public readonly registry: Registry, public readonly config: TracerConfig = DEFAULT_TRACER_CONFIG) {}

  startSpan(name: string, attributes: Record<string, string | number | boolean | null> = {}, traceId?: string): Span {
    const span: Span = {
      traceId: traceId ?? randomUUID(),
      spanId: randomUUID(),
      name,
      startMs: Date.now(),
      status: 'ok',
      attributes,
      events: [],
    };
    this.liveSpans.set(span.spanId, span);
    if (!this.spansCounter) {
      try {
        this.spansCounter = this.registry.counter('gen_ai_spans_started_total', 'Total spans started by the tracer');
      } catch { /* already registered in a different Tracer sharing this Registry */ }
    }
    this.spansCounter?.inc();
    return span;
  }

  endSpan(span: Span, status: SpanStatus = 'ok', extraAttributes: Record<string, string | number | boolean | null> = {}): void {
    span.endMs = Date.now();
    span.status = status;
    Object.assign(span.attributes, extraAttributes);
    this.liveSpans.delete(span.spanId);
    this.spans.push(span);
    while (this.spans.length > this.config.maxSpans) this.spans.shift();
    if (!this.durationHist) {
      try {
        this.durationHist = this.registry.histogram('gen_ai_span_duration_seconds', 'Span duration in seconds', ['name', 'status']);
      } catch { /* see above */ }
    }
    this.durationHist?.observe({ name: span.name, status }, Math.max(0, (span.endMs - span.startMs) / 1000));
  }

  recordEvent(span: Span, name: string, attributes?: Record<string, string | number | boolean>): void {
    span.events.push({ name, at: Date.now(), ...(attributes ? { attributes } : {}) });
  }

  /** Drain completed spans (caller can ship them to an OTLP collector, etc.). */
  drain(): Span[] {
    const out = this.spans.splice(0, this.spans.length);
    return out;
  }

  /** Snapshot of live + completed spans (without removing). */
  snapshot(): Span[] {
    return [...this.spans, ...this.liveSpans.values()];
  }
}
