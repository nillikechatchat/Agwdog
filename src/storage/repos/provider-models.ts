import type { Database } from 'better-sqlite3';
import type { Availability, ProviderModelRow } from '../types.js';

export interface NewProviderModelInput {
  id: string;
  providerId: string;
  modelId: string;
  displayName?: string | null;
  contextWindow?: number | null;
  supportsStream?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  enabled?: boolean;
}

export class ProviderModelRepo {
  constructor(private readonly db: Database) {}

  insert(input: NewProviderModelInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO provider_models (
          id, provider_id, model_id, display_name, context_window,
          supports_stream, supports_tools, supports_vision, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.providerId,
        input.modelId,
        input.displayName ?? null,
        input.contextWindow ?? null,
        input.supportsStream === false ? 0 : 1,
        input.supportsTools === false ? 0 : 1,
        input.supportsVision ? 1 : 0,
        input.enabled === false ? 0 : 1,
        now,
      );
  }

  bulkInsert(rows: NewProviderModelInput[], now = Date.now()): void {
    const stmt = this.db.prepare(
      `INSERT INTO provider_models (
        id, provider_id, model_id, display_name, context_window,
        supports_stream, supports_tools, supports_vision, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(
          r.id,
          r.providerId,
          r.modelId,
          r.displayName ?? null,
          r.contextWindow ?? null,
          r.supportsStream === false ? 0 : 1,
          r.supportsTools === false ? 0 : 1,
          r.supportsVision ? 1 : 0,
          r.enabled === false ? 0 : 1,
          now,
        );
      }
    });
    tx();
  }

  getById(id: string): ProviderModelRow | undefined {
    return this.db.prepare(`SELECT * FROM provider_models WHERE id = ?`).get(id) as ProviderModelRow | undefined;
  }

  getByProviderAndModel(providerId: string, modelId: string): ProviderModelRow | undefined {
    return this.db
      .prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?`)
      .get(providerId, modelId) as ProviderModelRow | undefined;
  }

  listByProvider(providerId: string): ProviderModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_models WHERE provider_id = ? ORDER BY model_id`)
      .all(providerId) as ProviderModelRow[];
  }

  listEnabled(): ProviderModelRow[] {
    return this.db.prepare(`SELECT * FROM provider_models WHERE enabled = 1 ORDER BY model_id`).all() as ProviderModelRow[];
  }

  /** Replace models for a provider in one transaction; used by /sync-models. */
  replaceForProvider(providerId: string, rows: NewProviderModelInput[], now = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM provider_models WHERE provider_id = ?`).run(providerId);
      this.bulkInsert(rows, now);
    });
    tx();
  }

  updateAvailability(id: string, availability: Availability, now = Date.now()): void {
    if (availability === 'unavailable') {
      this.db
        .prepare(`UPDATE provider_models SET availability = ?, unavailable_since = COALESCE(unavailable_since, ?) WHERE id = ?`)
        .run(availability, now, id);
    } else {
      this.db
        .prepare(`UPDATE provider_models SET availability = ?, unavailable_since = NULL WHERE id = ?`)
        .run(availability, id);
    }
  }

  recordProbeSuccess(id: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE provider_models SET
          consecutive_successes = consecutive_successes + 1,
          consecutive_failures = 0,
          last_probe_at = ?
        WHERE id = ?`,
      )
      .run(now, id);
  }

  recordProbeFailure(id: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE provider_models SET
          consecutive_failures = consecutive_failures + 1,
          consecutive_successes = 0,
          last_probe_at = ?
        WHERE id = ?`,
      )
      .run(now, id);
  }

  /** Reset success counter and mark available. */
  markAvailable(id: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE provider_models SET
          availability = 'available',
          unavailable_since = NULL,
          consecutive_failures = 0,
          consecutive_successes = 0,
          last_probe_at = ?
        WHERE id = ?`,
      )
      .run(now, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM provider_models WHERE id = ?`).run(id);
  }
}