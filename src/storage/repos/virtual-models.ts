import type { Database } from 'better-sqlite3';
import type { RoutingStrategy, VirtualModelRow, VirtualModelMemberRow } from '../types.js';

export interface NewVirtualModelInput {
  id: string;
  name: string;
  strategy: RoutingStrategy;
  latencyWindow?: number | null;
  failureThreshold?: number | null;
  recoveryThreshold?: number | null;
  maxRetries?: number;
  fallbackChain?: string[] | null;
}

export interface NewMemberInput {
  virtualModelId: string;
  upstreamModelId: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface MemberWithUpstream extends VirtualModelMemberRow {
  availability: string;
  provider_id: string;
  provider_name: string;
  provider_protocol: string;
  model_id: string;
}

export class VirtualModelRepo {
  constructor(private readonly db: Database) {}

  insert(input: NewVirtualModelInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO virtual_models (
          id, name, strategy, latency_window, failure_threshold, recovery_threshold,
          max_retries, fallback_chain_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.strategy,
        input.latencyWindow ?? null,
        input.failureThreshold ?? null,
        input.recoveryThreshold ?? null,
        input.maxRetries ?? 2,
        input.fallbackChain ? JSON.stringify(input.fallbackChain) : null,
        now,
      );
  }

  list(): VirtualModelRow[] {
    return this.db.prepare(`SELECT * FROM virtual_models ORDER BY name`).all() as VirtualModelRow[];
  }

  getById(id: string): VirtualModelRow | undefined {
    return this.db.prepare(`SELECT * FROM virtual_models WHERE id = ?`).get(id) as VirtualModelRow | undefined;
  }

  getByName(name: string): VirtualModelRow | undefined {
    return this.db.prepare(`SELECT * FROM virtual_models WHERE name = ?`).get(name) as VirtualModelRow | undefined;
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM virtual_models WHERE id = ?`).run(id);
  }

  addMember(input: NewMemberInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO virtual_model_members (
          virtual_model_id, upstream_model_id, weight, priority, enabled, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.virtualModelId,
        input.upstreamModelId,
        input.weight ?? 1,
        input.priority ?? 100,
        input.enabled === false ? 0 : 1,
        now,
      );
  }

  removeMember(virtualModelId: string, upstreamModelId: string): void {
    this.db
      .prepare(`DELETE FROM virtual_model_members WHERE virtual_model_id = ? AND upstream_model_id = ?`)
      .run(virtualModelId, upstreamModelId);
  }

  listMembers(virtualModelId: string): VirtualModelMemberRow[] {
    return this.db
      .prepare(`SELECT * FROM virtual_model_members WHERE virtual_model_id = ? ORDER BY priority, joined_at`)
      .all(virtualModelId) as VirtualModelMemberRow[];
  }

  /** List members joined with provider model + provider availability for routing decisions. */
  listMembersWithAvailability(virtualModelId: string): MemberWithUpstream[] {
    return this.db
      .prepare(
        `SELECT
          m.virtual_model_id, m.upstream_model_id, m.weight, m.priority, m.enabled, m.joined_at,
          pm.availability, pm.provider_id, p.name AS provider_name, p.protocol AS provider_protocol, pm.model_id
        FROM virtual_model_members m
        JOIN provider_models pm ON pm.id = m.upstream_model_id
        JOIN providers p ON p.id = pm.provider_id
        WHERE m.virtual_model_id = ?
        ORDER BY m.priority, m.joined_at`,
      )
      .all(virtualModelId) as MemberWithUpstream[];
  }
}