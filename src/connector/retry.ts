export interface RetryConfig {
  /** Max total attempts (including the first). 1 = no retry. */
  maxAttempts: number;
  /** Base delay for exponential backoff (ms). */
  baseDelayMs: number;
  /** Cap on the per-attempt delay (ms). */
  maxDelayMs: number;
  /** Multiplier between attempts. */
  multiplier: number;
  /** Random jitter 0..jitterMs added to each delay. */
  jitterMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  multiplier: 2,
  jitterMs: 100,
};

/**
 * Decide whether an HTTP status is retryable (in addition to network errors).
 * 408/409/425/429/5xx -> retry. 4xx other than those -> not retryable.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

export function computeBackoff(attempt: number, cfg: RetryConfig, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs + Math.random() * cfg.jitterMs, cfg.maxDelayMs);
  }
  const exp = cfg.baseDelayMs * Math.pow(cfg.multiplier, attempt - 1);
  const capped = Math.min(exp, cfg.maxDelayMs);
  return capped + Math.random() * cfg.jitterMs;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}
