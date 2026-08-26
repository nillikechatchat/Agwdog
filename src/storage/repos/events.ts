import type { Database } from 'better-sqlite3';
import type { EventRow, EventType } from '../types.js';

export interface NewEventInput {
  keyId?: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}

export class EventRepo {
  constructor(private readonly db: Database) {}

  append(input: NewEventInput, now = Date.now()): number {
    const result = this.db
      .prepare(`INSERT INTO events (key_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(input.keyId ?? null, input.type, JSON.stringify(input.payload), now);
    return Number(result.lastInsertRowid);
  }

  listByKey(keyId: string, limit = 100): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE key_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(keyId, limit) as EventRow[];
  }

  listByType(type: EventType, limit = 100): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE type = ? ORDER BY created_at DESC LIMIT ?`)
      .all(type, limit) as EventRow[];
  }
}