import { describe, it, expect } from 'vitest';
import { Tracer, GEN_AI_ATTRIBUTES } from '../../../src/observability/tracer.js';
import { Registry } from '../../../src/observability/registry.js';

describe('Tracer', () => {
  it('startSpan and endSpan produces a complete record', () => {
    const r = new Registry();
    const t = new Tracer(r);
    const span = t.startSpan('chat', { [GEN_AI_ATTRIBUTES.requestModel]: 'gpt-4o' });
    t.endSpan(span, 'ok', { [GEN_AI_ATTRIBUTES.inputTokens]: 10 });
    expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
    expect(span.status).toBe('ok');
    expect(span.attributes[GEN_AI_ATTRIBUTES.inputTokens]).toBe(10);
    const drained = t.drain();
    expect(drained).toHaveLength(1);
  });

  it('recordEvent adds an event entry', () => {
    const r = new Registry();
    const t = new Tracer(r);
    const span = t.startSpan('chat');
    t.recordEvent(span, 'first-token', { delay_ms: 50 });
    t.endSpan(span);
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.name).toBe('first-token');
  });

  it('drain empties the buffer; snapshot does not', () => {
    const r = new Registry();
    const t = new Tracer(r);
    const s = t.startSpan('x');
    t.endSpan(s);
    expect(t.snapshot()).toHaveLength(1);
    expect(t.drain()).toHaveLength(1);
    expect(t.snapshot()).toHaveLength(0);
  });

  it('respects maxSpans by evicting oldest', () => {
    const r = new Registry();
    const t = new Tracer(r, { maxSpans: 2 });
    for (let i = 0; i < 5; i += 1) {
      const s = t.startSpan(`s${i}`);
      t.endSpan(s);
    }
    expect(t.snapshot()).toHaveLength(2);
  });

  it('records a duration histogram per span name/status', () => {
    const r = new Registry();
    const t = new Tracer(r);
    const s = t.startSpan('chat');
    t.endSpan(s, 'ok');
    const fam = r.collect();
    const hist = fam.find((f) => f.meta.name === 'gen_ai_span_duration_seconds');
    expect(hist).toBeDefined();
  });
});
