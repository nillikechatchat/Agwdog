import type { MetricFamily, Registry, Sample } from './registry.js';

/**
 * Render the registry as Prometheus text format (version 0.0.4).
 * Each metric family emits:
 *   # HELP <name> <help>
 *   # TYPE <name> counter|gauge|histogram
 *   <name>{labels} value [timestamp?]
 */
export function renderPrometheus(registry: Registry): string {
  const families = registry.collect();
  const lines: string[] = [];
  for (const fam of families) {
    lines.push(`# HELP ${fam.meta.name} ${fam.meta.help}`);
    lines.push(`# TYPE ${fam.meta.name} ${fam.meta.type}`);
    for (const s of fam.samples) {
      lines.push(formatSampleLine(fam.meta.name, s));
    }
  }
  return lines.join('\n') + '\n';
}

function formatSampleLine(name: string, s: Sample): string {
  const fullName = s.suffix ? `${name}${s.suffix}` : name;
  if (Object.keys(s.labels).length === 0) return `${fullName} ${formatNumber(s.value)}`;
  const pairs = Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(',');
  return `${fullName}{${pairs}} ${formatNumber(s.value)}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/** Re-export the family type so callers can build a custom exporter. */
export type { MetricFamily };
