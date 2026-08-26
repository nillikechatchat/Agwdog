import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../../src/connector/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;
  beforeEach(() => { cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1_000, openCooldownMs: 500, halfOpenSuccessThreshold: 1 }); });

  it('starts closed and allows calls', () => {
    expect(cb.stateOf('v')).toBe('closed');
    expect(cb.allow('v')).toBe(true);
  });

  it('trips open after N consecutive failures within the window', () => {
    cb.recordFailure('v');
    cb.recordFailure('v');
    expect(cb.stateOf('v')).toBe('closed');
    cb.recordFailure('v');
    expect(cb.stateOf('v')).toBe('open');
    expect(cb.allow('v')).toBe(false);
  });

  it('transitions to half-open after cooldown, then closes on success', () => {
    cb.recordFailure('v');
    cb.recordFailure('v');
    cb.recordFailure('v');
    // Force the breaker to half-open by back-dating openedAt.
    const stats = (cb as unknown as { stats: Map<string, { state: string; openedAt: number }> }).stats.get('v')!;
    stats.state = 'half-open';
    stats.openedAt = 0;
    expect(cb.stateOf('v')).toBe('half-open');
    cb.recordSuccess('v');
    expect(cb.stateOf('v')).toBe('closed');
  });

  it('resets cleanly', () => {
    cb.recordFailure('v');
    cb.recordFailure('v');
    cb.reset('v');
    expect(cb.stateOf('v')).toBe('closed');
  });

  it('half-open failure re-opens the breaker', () => {
    cb.recordFailure('v');
    cb.recordFailure('v');
    cb.recordFailure('v');
    // Manually flip to half-open via virtual time.
    (cb as unknown as { stats: Map<string, { state: string; openedAt: number }> }).stats.get('v')!.state = 'half-open';
    (cb as unknown as { stats: Map<string, { state: string; openedAt: number }> }).stats.get('v')!.openedAt = 0;
    cb.recordFailure('v');
    expect(cb.stateOf('v')).toBe('open');
  });
});
