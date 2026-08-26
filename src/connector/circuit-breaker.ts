import { CircuitState } from './types.js';

export interface CircuitBreakerConfig {
  /** Consecutive failures within the window required to trip the breaker. */
  failureThreshold: number;
  /** Sliding window (ms) used to count consecutive failures. */
  windowMs: number;
  /** How long the breaker stays open before transitioning to half-open. */
  openCooldownMs: number;
  /** Successful requests in half-open needed to re-close. */
  halfOpenSuccessThreshold: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  openCooldownMs: 30_000,
  halfOpenSuccessThreshold: 1,
};

interface CircuitStats {
  state: CircuitState;
  recentFailures: number[]; // unix-ms timestamps
  recentSuccesses: number; // within the current half-open trial
  openedAt: number;
}

export class CircuitBreaker {
  private readonly stats = new Map<string, CircuitStats>();
  constructor(private readonly cfg: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {}

  stateOf(vendorId: string): CircuitState {
    const s = this.stats.get(vendorId);
    if (!s) return 'closed';
    this.maybeTransition(s, Date.now());
    return s.state;
  }

  /** Returns `true` if the call should be allowed to proceed. */
  allow(vendorId: string): boolean {
    const s = this.ensure(vendorId);
    this.maybeTransition(s, Date.now());
    return s.state !== 'open';
  }

  recordSuccess(vendorId: string, now: number = Date.now()): void {
    const s = this.ensure(vendorId);
    this.maybeTransition(s, now);
    if (s.state === 'half-open') {
      s.recentSuccesses += 1;
      if (s.recentSuccesses >= this.cfg.halfOpenSuccessThreshold) {
        s.state = 'closed';
        s.recentFailures = [];
        s.recentSuccesses = 0;
      }
    } else if (s.state === 'closed') {
      s.recentFailures = [];
    }
  }

  recordFailure(vendorId: string, now: number = Date.now()): void {
    const s = this.ensure(vendorId);
    this.maybeTransition(s, now);
    if (s.state === 'half-open') {
      s.state = 'open';
      s.openedAt = now;
      s.recentSuccesses = 0;
      return;
    }
    if (s.state === 'closed') {
      s.recentFailures = s.recentFailures.filter((t) => now - t <= this.cfg.windowMs);
      s.recentFailures.push(now);
      if (s.recentFailures.length >= this.cfg.failureThreshold) {
        s.state = 'open';
        s.openedAt = now;
      }
    }
  }

  reset(vendorId: string): void {
    this.stats.delete(vendorId);
  }

  private ensure(vendorId: string): CircuitStats {
    let s = this.stats.get(vendorId);
    if (!s) {
      s = { state: 'closed', recentFailures: [], recentSuccesses: 0, openedAt: 0 };
      this.stats.set(vendorId, s);
    }
    return s;
  }

  private maybeTransition(s: CircuitStats, now: number): void {
    if (s.state === 'open' && now - s.openedAt >= this.cfg.openCooldownMs) {
      s.state = 'half-open';
      s.recentSuccesses = 0;
    }
  }
}
