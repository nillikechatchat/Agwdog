import { describe, it, expect, beforeEach } from 'vitest';
import { PromptCacheTracker } from '../../../src/cache/prompt-cache.js';
import { openTestDatabase, type TestDbHandle } from '../../helpers/db.js';

describe('PromptCacheTracker', () => {
  let db: TestDbHandle;
  let tracker: PromptCacheTracker;

  beforeEach(() => {
    db = openTestDatabase();
    tracker = new PromptCacheTracker(db.db);
  });

  it('records and finds a marker', () => {
    const now = Date.now();
    tracker.record('r1', 'vm', { cacheKey: 'k1', clientProtocol: 'OpenAI-Chat', cacheControl: { type: 'ephemeral' }, prefixTokens: 100 }, 'p1', 'm1', now);
    const found = tracker.find('k1');
    expect(found).not.toBeNull();
    expect(found?.prefix_tokens).toBe(100);
  });

  it('touch increments hit_count and sets last_hit_at', () => {
    const t0 = Date.now();
    tracker.record('r1', 'vm', { cacheKey: 'k1', clientProtocol: 'Anthropic-Messages', cacheControl: {}, prefixTokens: 50 }, null, null, t0);
    tracker.touch('k1', t0 + 1000);
    const found = tracker.find('k1');
    expect(found?.hit_count).toBe(1);
    expect(found?.last_hit_at).toBe(t0 + 1000);
  });

  it('listForVirtualModel returns latest first', () => {
    const t0 = Date.now();
    tracker.record('r1', 'vm', { cacheKey: 'k1', clientProtocol: 'OpenAI-Chat', cacheControl: {}, prefixTokens: 1 }, null, null, t0);
    tracker.record('r2', 'vm', { cacheKey: 'k2', clientProtocol: 'OpenAI-Chat', cacheControl: {}, prefixTokens: 2 }, null, null, t0 + 1);
    const list = tracker.listForVirtualModel('vm', 10);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe('r2');
  });

  it('clear removes all markers for a vm', () => {
    const t0 = Date.now();
    tracker.record('r1', 'vm', { cacheKey: 'k1', clientProtocol: 'OpenAI-Chat', cacheControl: {}, prefixTokens: 1 }, null, null, t0);
    tracker.record('r2', 'vm', { cacheKey: 'k2', clientProtocol: 'OpenAI-Chat', cacheControl: {}, prefixTokens: 2 }, null, null, t0);
    expect(tracker.clear('vm')).toBe(2);
    expect(tracker.listForVirtualModel('vm', 10)).toHaveLength(0);
  });
});
