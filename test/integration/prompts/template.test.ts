import { describe, it, expect, beforeEach } from 'vitest';
import { PromptTemplateRepo } from '../../../src/prompts/template.js';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';

describe('PromptTemplateRepo', () => {
  let db: TestDbHandle;
  let repo: PromptTemplateRepo;

  beforeEach(() => {
    db = openTestDatabase();
    repo = new PromptTemplateRepo(db.db);
  });

  it('saves and retrieves a template', () => {
    const now = Date.now();
    repo.save({
      id: 't-1', name: 'system-a', version: 1, body: 'You are {{persona}}',
      variables: ['persona'], modelHints: ['claude'],
      createdAt: now, updatedAt: now,
    });
    const t = repo.get('t-1');
    expect(t?.body).toBe('You are {{persona}}');
    expect(t?.variables).toEqual(['persona']);
  });

  it('publish marks a version as latest and unsets others', () => {
    const now = Date.now();
    repo.save({ id: 't-1', name: 'p', version: 1, body: 'v1', variables: [], modelHints: [], createdAt: now, updatedAt: now });
    repo.save({ id: 't-2', name: 'p', version: 2, body: 'v2', variables: [], modelHints: [], createdAt: now + 1, updatedAt: now + 1 });
    repo.publish('t-1');
    expect(repo.getLatest('p')?.id).toBe('t-1');
    repo.publish('t-2');
    expect(repo.getLatest('p')?.id).toBe('t-2');
    expect(repo.get('t-1')?.isLatest).toBe(false);
  });

  it('listLatest returns one row per name', () => {
    const now = Date.now();
    repo.save({ id: 'a1', name: 'a', version: 1, body: 'x', variables: [], modelHints: [], createdAt: now, updatedAt: now });
    repo.save({ id: 'b1', name: 'b', version: 1, body: 'y', variables: [], modelHints: [], createdAt: now, updatedAt: now });
    repo.publish('a1');
    repo.publish('b1');
    expect(repo.listLatest()).toHaveLength(2);
  });

  it('listVersions returns newest first', () => {
    const now = Date.now();
    repo.save({ id: 'a1', name: 'a', version: 1, body: 'v1', variables: [], modelHints: [], createdAt: now, updatedAt: now });
    repo.save({ id: 'a2', name: 'a', version: 2, body: 'v2', variables: [], modelHints: [], createdAt: now + 1, updatedAt: now + 1 });
    const vs = repo.listVersions('a');
    expect(vs.map((v) => v.version)).toEqual([2, 1]);
  });

  it('delete removes a template', () => {
    const now = Date.now();
    repo.save({ id: 'a', name: 'a', version: 1, body: 'x', variables: [], modelHints: [], createdAt: now, updatedAt: now });
    expect(repo.delete('a')).toBe(1);
    expect(repo.get('a')).toBeNull();
  });
});
