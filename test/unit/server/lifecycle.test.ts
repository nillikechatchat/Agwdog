import { describe, it, expect } from 'vitest';

import { createInflightTracker, type InflightTracker } from '@/server/lifecycle.js';

describe('createInflightTracker', () => {
  it('starts at 0', () => {
    const t = createInflightTracker();
    expect(t.count()).toBe(0);
  });

  it('increments on begin()', () => {
    const t = createInflightTracker();
    t.begin();
    t.begin();
    expect(t.count()).toBe(2);
  });

  it('decrements on end()', () => {
    const t = createInflightTracker();
    t.begin();
    t.begin();
    t.end();
    expect(t.count()).toBe(1);
  });

  it('end() cannot go below 0', () => {
    const t = createInflightTracker();
    t.end();
    t.end();
    expect(t.count()).toBe(0);
  });

  it('tracks concurrent inflight correctly', () => {
    const t: InflightTracker = createInflightTracker();
    expect(t.count()).toBe(0);
    t.begin();
    expect(t.count()).toBe(1);
    t.begin();
    expect(t.count()).toBe(2);
    t.end();
    expect(t.count()).toBe(1);
    t.begin();
    expect(t.count()).toBe(2);
    t.end();
    t.end();
    expect(t.count()).toBe(0);
  });
});