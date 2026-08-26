import type { Database } from 'better-sqlite3';
import type { ClientProtocol, UsageRecordRow, UsageSource, CacheHit } from '../types.js';

export interface NewUsageInput {
  requestId: string;
  keyId?: string | null;
  virtualModelId?: string | null;
  upstreamProviderId?: string | null;
  upstreamModelId?: string | null;
  clientProtocol: ClientProtocol;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  totalTokens: number;
  costUsd: number;
  source: UsageSource;
  cacheHit?: CacheHit;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  latencyMs: number;
  statusCode: number;
  errorCode?: string | null;
}

export interface UsageAggregateOptions {
  groupBy: 'day' | 'model' | 'key' | 'virtualModel';
  range: 'today' | '7d' | '30d' | 'all';
}

export interface UsageAggregateRow {
  bucket: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

function rangeStartMs(range: UsageAggregateOptions['range'], now: Date): number {
  switch (range) {
    case 'today':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    case '7d':
      return now.getTime() - 7 * 24 * 3600 * 1000;
    case '30d':
      return now.getTime() - 30 * 24 * 3600 * 1000;
    case 'all':
      return 0;
  }
}

function bucketKey(period: 'day', ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export class UsageRepo {
  constructor(private readonly db: Database) {}

  append(input: NewUsageInput, now = Date.now()): number {
    const result = this.db
      .prepare(
        `INSERT INTO usage_records (
          request_id, key_id, virtual_model_id, upstream_provider_id, upstream_model_id,
          client_protocol, prompt_tokens, completion_tokens, cached_tokens, total_tokens,
          cost_usd, source, cache_hit, ttft_ms, tokens_per_second, latency_ms, status_code, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.keyId ?? null,
        input.virtualModelId ?? null,
        input.upstreamProviderId ?? null,
        input.upstreamModelId ?? null,
        input.clientProtocol,
        input.promptTokens,
        input.completionTokens,
        input.cachedTokens ?? 0,
        input.totalTokens,
        input.costUsd,
        input.source,
        input.cacheHit ?? 'none',
        input.ttftMs ?? null,
        input.tokensPerSecond ?? null,
        input.latencyMs,
        input.statusCode,
        input.errorCode ?? null,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  aggregate(opts: UsageAggregateOptions): UsageAggregateRow[] {
    const start = rangeStartMs(opts.range, new Date());

    if (opts.groupBy === 'day') {
      const rows = this.db
        .prepare(
          `SELECT created_at, prompt_tokens, completion_tokens, cached_tokens,
                  total_tokens, cost_usd
           FROM usage_records WHERE created_at >= ?`,
        )
        .all(start) as Array<{ created_at: number } & { [k: string]: number | string }>;
      const map = new Map<string, UsageAggregateRow>();
      for (const r of rows) {
        const bucket = bucketKey('day', r['created_at'] as number);
        let row = map.get(bucket);
        if (!row) {
          row = {
            bucket,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            requestCount: 0,
          };
          map.set(bucket, row);
        }
        row.promptTokens += Number(r['prompt_tokens']);
        row.completionTokens += Number(r['completion_tokens']);
        row.cachedTokens += Number(r['cached_tokens']);
        row.totalTokens += Number(r['total_tokens']);
        row.costUsd += Number(r['cost_usd']);
        row.requestCount += 1;
      }
      return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    }

    if (opts.groupBy === 'model') {
      return this.db
        .prepare(
          `SELECT upstream_model_id AS bucket,
                  SUM(prompt_tokens) AS promptTokens,
                  SUM(completion_tokens) AS completionTokens,
                  SUM(cached_tokens) AS cachedTokens,
                  SUM(total_tokens) AS totalTokens,
                  SUM(cost_usd) AS costUsd,
                  COUNT(*) AS requestCount
           FROM usage_records
           WHERE created_at >= ?
           GROUP BY upstream_model_id
           ORDER BY costUsd DESC`,
        )
        .all(start) as UsageAggregateRow[];
    }

    if (opts.groupBy === 'virtualModel') {
      return this.db
        .prepare(
          `SELECT virtual_model_id AS bucket,
                  SUM(prompt_tokens) AS promptTokens,
                  SUM(completion_tokens) AS completionTokens,
                  SUM(cached_tokens) AS cachedTokens,
                  SUM(total_tokens) AS totalTokens,
                  SUM(cost_usd) AS costUsd,
                  COUNT(*) AS requestCount
           FROM usage_records
           WHERE created_at >= ?
           GROUP BY virtual_model_id
           ORDER BY costUsd DESC`,
        )
        .all(start) as UsageAggregateRow[];
    }

    // groupBy === 'key'
    return this.db
      .prepare(
        `SELECT key_id AS bucket,
                SUM(prompt_tokens) AS promptTokens,
                SUM(completion_tokens) AS completionTokens,
                SUM(cached_tokens) AS cachedTokens,
                SUM(total_tokens) AS totalTokens,
                SUM(cost_usd) AS costUsd,
                COUNT(*) AS requestCount
         FROM usage_records
         WHERE created_at >= ?
         GROUP BY key_id
         ORDER BY costUsd DESC`,
      )
      .all(start) as UsageAggregateRow[];
  }
}