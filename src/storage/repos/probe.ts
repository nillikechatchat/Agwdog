import type { Database } from 'better-sqlite3';
import type { ClientProtocol, ProbeResultRow } from '../types.js';

export interface NewProbeResultInput {
  upstreamModelId: string;
  latencyMs?: number | null;
  statusCode?: number | null;
  success: boolean;
  errorMessage?: string | null;
}

export interface ProbeAggregate {
  total: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export class ProbeRepo {
  constructor(private readonly db: Database) {}

  append(input: NewProbeResultInput, now = Date.now()): number {
    const result = this.db
      .prepare(
        `INSERT INTO probe_results (upstream_model_id, latency_ms, status_code, success, error_message, probed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.upstreamModelId,
        input.latencyMs ?? null,
        input.statusCode ?? null,
        input.success ? 1 : 0,
        input.errorMessage ?? null,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  recentForModel(upstreamModelId: string, limit = 10): ProbeResultRow[] {
    return this.db
      .prepare(`SELECT * FROM probe_results WHERE upstream_model_id = ? ORDER BY probed_at DESC LIMIT ?`)
      .all(upstreamModelId, limit) as ProbeResultRow[];
  }

  /** Aggregate over the last N probes for a model. */
  aggregate(upstreamModelId: string, window = 20): ProbeAggregate {
    const rows = this.recentForModel(upstreamModelId, window);
    const total = rows.length;
    if (total === 0) {
      return { total: 0, successCount: 0, failureCount: 0, avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null };
    }
    let successCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    const latencies: number[] = [];
    for (const r of rows) {
      if (r.success) successCount++;
      if (r.latency_ms !== null) {
        latencySum += r.latency_ms;
        latencyCount++;
        latencies.push(r.latency_ms);
      }
    }
    latencies.sort((a, b) => a - b);
    const percentile = (p: number): number | null => {
      if (latencies.length === 0) return null;
      const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
      return latencies[idx] ?? null;
    };
    return {
      total,
      successCount,
      failureCount: total - successCount,
      avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
      p50LatencyMs: percentile(50),
      p95LatencyMs: percentile(95),
    };
  }

  // Suppress unused import warning when ClientProtocol is not referenced elsewhere.
  private _phantom?: ClientProtocol;
}