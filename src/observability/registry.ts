/**
 * In-process metrics registry. Implements the three metric types Prometheus
 * understands (Counter, Gauge, Histogram) plus a labelling mechanism. Zero
 * dependencies — the registry stores the metrics, the Prometheus exporter
 * (see ./prometheus.ts) formats them on the wire.
 *
 * Histograms use the standard fixed-bucket approach: per-bucket cumulative
 * counters and a separate sum / count. The default buckets match the
 * histograms in Prometheus' `client_golang` for HTTP latencies.
 */

export type LabelValues = Record<string, string>;

export interface MetricMeta {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  labelNames: readonly string[];
}

abstract class Metric {
  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: readonly string[]) {}
  abstract collect(): MetricFamily;
  protected labelsKey(values: LabelValues): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => `${n}=${escapeLabelValue(values[n] ?? '')}`).join(',');
  }
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class Counter extends Metric {
  readonly type = 'counter' as const;
  private readonly values = new Map<string, number>();

  inc(values: LabelValues = {}, amount: number = 1): void {
    if (amount < 0) throw new Error('counter only increases');
    const k = this.labelsKey(values);
    this.values.set(k, (this.values.get(k) ?? 0) + amount);
  }

  get(values: LabelValues = {}): number {
    return this.values.get(this.labelsKey(values)) ?? 0;
  }

  override collect(): MetricFamily {
    return {
      meta: { name: this.name, help: this.help, type: 'counter', labelNames: this.labelNames },
      samples: Array.from(this.values.entries()).map(([k, v]) => ({
        labels: parseLabelKey(k),
        value: v,
      })),
    };
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  private readonly values = new Map<string, number>();

  set(values: LabelValues, value: number): void;
  set(value: number): void;
  set(a: LabelValues | number, b?: number): void {
    if (typeof a === 'number') {
      this.values.set('', a);
    } else {
      this.values.set(this.labelsKey(a), b ?? 0);
    }
  }

  inc(values: LabelValues = {}, amount: number = 1): void {
    const k = this.labelsKey(values);
    this.values.set(k, (this.values.get(k) ?? 0) + amount);
  }

  dec(values: LabelValues = {}, amount: number = 1): void {
    const k = this.labelsKey(values);
    this.values.set(k, (this.values.get(k) ?? 0) - amount);
  }

  get(values: LabelValues = {}): number {
    return this.values.get(this.labelsKey(values)) ?? 0;
  }

  override collect(): MetricFamily {
    return {
      meta: { name: this.name, help: this.help, type: 'gauge', labelNames: this.labelNames },
      samples: Array.from(this.values.entries()).map(([k, v]) => ({
        labels: parseLabelKey(k),
        value: v,
      })),
    };
  }
}

export interface HistogramOptions {
  buckets: number[];
}

export const DEFAULT_BUCKETS: number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  private readonly buckets: number[];
  private readonly counts = new Map<string, number[]>(); // key -> per-bucket cumulative counts
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();

  constructor(name: string, help: string, labelNames: readonly string[], opts: HistogramOptions = { buckets: DEFAULT_BUCKETS }) {
    super(name, help, labelNames);
    const sorted = [...opts.buckets].sort((a, b) => a - b);
    this.buckets = sorted;
  }

  observe(values: LabelValues, value: number): void {
    const k = this.labelsKey(values);
    let arr = this.counts.get(k);
    if (!arr) {
      arr = new Array(this.buckets.length).fill(0);
      this.counts.set(k, arr);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) arr[i] = (arr[i] ?? 0) + 1;
    }
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.totals.set(k, (this.totals.get(k) ?? 0) + 1);
  }

  override collect(): MetricFamily {
    const out: MetricFamily = {
      meta: { name: this.name, help: this.help, type: 'histogram', labelNames: this.labelNames },
      samples: [],
    };
    for (const [k, arr] of this.counts) {
      const labels = parseLabelKey(k);
      for (let i = 0; i < this.buckets.length; i += 1) {
        out.samples.push({
          labels: { ...labels, le: String(this.buckets[i]) },
          value: arr[i] ?? 0,
          suffix: '_bucket',
        });
      }
      out.samples.push({ labels: { ...labels, le: '+Inf' }, value: this.totals.get(k) ?? 0, suffix: '_bucket' });
      out.samples.push({ labels, value: this.sums.get(k) ?? 0, suffix: '_sum' });
      out.samples.push({ labels, value: this.totals.get(k) ?? 0, suffix: '_count' });
    }
    return out;
  }
}

export interface Sample {
  labels: LabelValues;
  value: number;
  /** Suffix to append to the metric name (e.g. `_bucket`, `_sum`, `_count`). */
  suffix?: string;
}

export interface MetricFamily {
  meta: MetricMeta;
  samples: Sample[];
}

function parseLabelKey(k: string): LabelValues {
  if (k === '') return {};
  const out: LabelValues = {};
  for (const part of k.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    out[name] = value;
  }
  return out;
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.register(new Gauge(name, help, labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], opts?: HistogramOptions): Histogram {
    return this.register(new Histogram(name, help, labelNames, opts));
  }

  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  collect(): MetricFamily[] {
    return Array.from(this.metrics.values()).map((m) => m.collect());
  }

  private register<T extends Metric>(m: T): T {
    if (this.metrics.has(m.name)) throw new Error(`metric already registered: ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }
}
