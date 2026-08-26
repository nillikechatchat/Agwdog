import { describe, it, expect } from 'vitest';
import { renderPrometheus } from '../../../src/observability/prometheus.js';
import { Registry } from '../../../src/observability/registry.js';

describe('renderPrometheus', () => {
  it('emits HELP and TYPE lines plus a sample line for a counter', () => {
    const r = new Registry();
    const c = r.counter('foo_total', 'help', ['m']);
    c.inc({ m: 'GET' }, 2);
    const out = renderPrometheus(r);
    expect(out).toContain('# HELP foo_total help');
    expect(out).toContain('# TYPE foo_total counter');
    expect(out).toMatch(/foo_total\{m="GET"\} 2/);
  });

  it('emits histogram bucket/sum/count lines', () => {
    const r = new Registry();
    const h = r.histogram('lat', 'help', [], { buckets: [1, 5] });
    h.observe({}, 0.5);
    h.observe({}, 3);
    const out = renderPrometheus(r);
    expect(out).toMatch(/lat_bucket\{le="1"\} 1/);
    expect(out).toMatch(/lat_bucket\{le="5"\} 2/);
    expect(out).toMatch(/lat_bucket\{le="\+Inf"\} 2/);
    expect(out).toMatch(/lat_sum 3\.5/);
    expect(out).toMatch(/lat_count 2/);
  });

  it('emits a metric with no labels as bare name + value', () => {
    const r = new Registry();
    r.counter('plain', 'h').inc();
    const out = renderPrometheus(r);
    expect(out).toMatch(/plain 1/);
  });

  it('escapes double-quotes, backslashes, and newlines in label values', () => {
    const r = new Registry();
    const c = r.counter('x', 'h', ['k']);
    c.inc({ k: 'a"b\\c\nd' });
    const out = renderPrometheus(r);
    expect(out).toMatch(/x\{k="a\\"b\\\\c\\nd"\} 1/);
  });

  it('handles special numeric values', () => {
    const r = new Registry();
    const g = r.gauge('g', 'h');
    g.set(Infinity);
    let out = renderPrometheus(r);
    expect(out).toMatch(/g \+Inf/);
    g.set(NaN);
    out = renderPrometheus(r);
    expect(out).toMatch(/g NaN/);
  });
});
