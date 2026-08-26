import type { Database } from 'better-sqlite3';
import type { ProviderRow, Protocol } from '../types.js';

export interface NewProviderInput {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyTag: string;
  inputPricePerMTokensUsd?: number | null;
  outputPricePerMTokensUsd?: number | null;
  cachedInputPricePerMTokensUsd?: number | null;
  enabled?: boolean;
  extra?: Record<string, unknown> | null;
}

export class ProviderRepo {
  constructor(private readonly db: Database) {}

  insert(input: NewProviderInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO providers (
          id, name, protocol, base_url, api_key_ciphertext, api_key_iv, api_key_tag,
          enabled, input_price_per_mtokens_usd, output_price_per_mtokens_usd,
          cached_input_price_per_mtokens_usd, extra_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.protocol,
        input.baseUrl,
        input.apiKeyCiphertext,
        input.apiKeyIv,
        input.apiKeyTag,
        input.enabled === false ? 0 : 1,
        input.inputPricePerMTokensUsd ?? null,
        input.outputPricePerMTokensUsd ?? null,
        input.cachedInputPricePerMTokensUsd ?? null,
        input.extra ? JSON.stringify(input.extra) : null,
        now,
        now,
      );
  }

  list(): ProviderRow[] {
    return this.db.prepare(`SELECT * FROM providers ORDER BY name`).all() as ProviderRow[];
  }

  getById(id: string): ProviderRow | undefined {
    return this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  }

  getByName(name: string): ProviderRow | undefined {
    return this.db.prepare(`SELECT * FROM providers WHERE name = ?`).get(name) as ProviderRow | undefined;
  }

  updateEnabled(id: string, enabled: boolean, now = Date.now()): void {
    this.db.prepare(`UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, now, id);
  }

  updatePrices(
    id: string,
    prices: { inputPrice?: number | null; outputPrice?: number | null; cachedInputPrice?: number | null },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE providers SET
          input_price_per_mtokens_usd = ?,
          output_price_per_mtokens_usd = ?,
          cached_input_price_per_mtokens_usd = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(prices.inputPrice ?? null, prices.outputPrice ?? null, prices.cachedInputPrice ?? null, now, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  }

  update(
    id: string,
    updates: {
      name?: string;
      protocol?: Protocol;
      baseUrl?: string;
      apiKeyCiphertext?: string;
      apiKeyIv?: string;
      apiKeyTag?: string;
      inputPricePerMTokensUsd?: number | null;
      outputPricePerMTokensUsd?: number | null;
      cachedInputPricePerMTokensUsd?: number | null;
      enabled?: boolean;
    },
    now = Date.now(),
  ): void {
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.protocol !== undefined) {
      setClauses.push('protocol = ?');
      values.push(updates.protocol);
    }
    if (updates.baseUrl !== undefined) {
      setClauses.push('base_url = ?');
      values.push(updates.baseUrl);
    }
    if (updates.apiKeyCiphertext !== undefined) {
      setClauses.push('api_key_ciphertext = ?');
      values.push(updates.apiKeyCiphertext);
    }
    if (updates.apiKeyIv !== undefined) {
      setClauses.push('api_key_iv = ?');
      values.push(updates.apiKeyIv);
    }
    if (updates.apiKeyTag !== undefined) {
      setClauses.push('api_key_tag = ?');
      values.push(updates.apiKeyTag);
    }
    if (updates.inputPricePerMTokensUsd !== undefined) {
      setClauses.push('input_price_per_mtokens_usd = ?');
      values.push(updates.inputPricePerMTokensUsd ?? null);
    }
    if (updates.outputPricePerMTokensUsd !== undefined) {
      setClauses.push('output_price_per_mtokens_usd = ?');
      values.push(updates.outputPricePerMTokensUsd ?? null);
    }
    if (updates.cachedInputPricePerMTokensUsd !== undefined) {
      setClauses.push('cached_input_price_per_mtokens_usd = ?');
      values.push(updates.cachedInputPricePerMTokensUsd ?? null);
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    values.push(id);
    this.db.prepare(`UPDATE providers SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }
}