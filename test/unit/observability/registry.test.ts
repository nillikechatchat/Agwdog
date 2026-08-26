import { describe, it, expect } from 'vitest';
import { Registry, Counter, Gauge, Histogram, DEFAULT_BUCKETS } from '../../../src/observability/registry.js';

describe('Registry', () => {
  it('registers a counter, increments, and reads back', () => {
    const r = new Registry();
    const c = r.counter('foo_total', 'help', ['method']);
    c.inc({ method: 'GET' });
    c.inc({ method: 'GET' }, 4);
    c.inc({ method: 'POST' });
    expect(c.get({ method: 'GET' })).toBe(5);
    expect(c.get({ method: 'POST' })).toBe(1);
  });

  it('rejects negative counter increments', () => {
    const r = new Registry();
    const c = r.counter('c', 'h');
    expect(() => c.inc({}, -1)).toThrow();
  });

  it('gauge set/inc/dec', () => {
    const r = new Registry();
    const g = r.gauge('g', 'h');
    g.set(5);
    g.inc();
    g.dec({}, 2);
    expect(g.get({})).toBe(4);
  });

  it('gauge with labels', () => {
    const r = new Registry();
    const g = r.gauge('g', 'h', ['k']);
    g.set({ k: 'a' }, 10);
    g.set({ k: 'b' }, 20);
    expect(g.get({})).toBe(0);
    const fam = g.collect();
    const a = fam.samples.find((s) => s.labels['k'] === 'a');
    expect(a?.value).toBe(10);
  });

  it('histogram observations go into cumulative buckets', () => {
    const r = new Registry();
    const h = r.histogram('lat', 'help', ['route'], { buckets: [1, 5, 10] });
    h.observe({ route: '/' }, 0.5);
    h.observe({ route: '/' }, 3);
    h.observe({ route: '/' }, 7);
    const fam = h.collect();
    const samples = fam.samples.filter((s) => s.suffix === '_bucket');
    const le1 = samples.find((s) => s.labels['le'] === '1');
    const le5 = samples.find((s) => s.labels['le'] === '5');
    const le10 = samples.find((s) => s.labels['le'] === '10');
    expect(le1?.value).toBe(1);
    expect(le5?.value).toBe(2);
    expect(le10?.value).toBe(3);
    const count = fam.samples.find((s) => s.suffix === '_count');
    expect(count?.value).toBe(3);
  });

  it('duplicate registration throws', () => {
    const r = new Registry();
    r.counter('x', 'h');
    expect(() => r.counter('x', 'h')).toThrow(/already registered/);
  });

  it('collects all families', () => {
    const r = new Registry();
    r.counter('a', 'h');
    r.gauge('b', 'h');
    r.histogram('c', 'h');
    expect(r.collect()).toHaveLength(3);
  });

  it('exposes DEFAULT_BUCKETS', () => {
    expect(DEFAULT_BUCKETS.length).toBeGreaterThan(0);
  });

  it('escapes special characters in label values', () => {
    const r = new Registry();
    const c = r.counter('e', 'h', ['k']);
    c.inc({ k: 'a"b\nc' });
    const fam = c.collect();
    const s = fam.samples[0]!;
    expect(s.labels['k']).toBe('a"b\nc');
  });
});
