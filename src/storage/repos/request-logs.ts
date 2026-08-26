import type { Database } from 'better-sqlite3';
import type { ClientProtocol, RequestLogRow } from '../types.js';

export interface NewRequestLogInput {
  requestId: string;
  keyId?: string | null;
  clientProtocol: ClientProtocol;
  virtualModelId?: string | null;
  upstreamProviderId?: string | null;
  upstreamModelId?: string | null;
  requestBodyRedacted: string;
  responseBodyRedacted?: string | null;
  routingDecision?: Record<string, unknown>;
  timing?: Record<string, unknown>;
}

export class RequestLogRepo {
  constructor(private readonly db: Database) {}

  append(input: NewRequestLogInput, now = Date.now()): number {
    const result = this.db
      .prepare(
        `INSERT INTO request_logs (
          request_id, key_id, client_protocol, virtual_model_id, upstream_provider_id, upstream_model_id,
          request_body_redacted, response_body_redacted, routing_decision_json, timing_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.keyId ?? null,
        input.clientProtocol,
        input.virtualModelId ?? null,
        input.upstreamProviderId ?? null,
        input.upstreamModelId ?? null,
        input.requestBodyRedacted,
        input.responseBodyRedacted ?? null,
        input.routingDecision ? JSON.stringify(input.routingDecision) : null,
        input.timing ? JSON.stringify(input.timing) : null,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  findByRequestId(requestId: string): RequestLogRow[] {
    return this.db
      .prepare(`SELECT * FROM request_logs WHERE request_id = ? ORDER BY created_at DESC`)
      .all(requestId) as RequestLogRow[];
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM request_logs`).get() as { c: number }).c;
  }
}