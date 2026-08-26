import { authenticate, extractBearerToken, isModelAllowed, type AuthSuccess } from './keys.js';
import type { KeyRow } from '../storage/types.js';
import type { BudgetTracker } from '../budget/tracker.js';
import type { RateLimiter, RateLimitConfig } from './rate-limit.js';
import type { KeyRepo } from '../storage/repos/keys.js';

/**
 * The combined auth + rate-limit + budget result. Exactly one of the two fields is set
 * depending on whether the request is allowed to proceed or must be rejected.
 */
export interface AuthContext {
  ok: true;
  key: KeyRow;
  plaintext: string;
}

export interface AuthRejection {
  ok: false;
  statusCode: number;
  errorCode: string;
  message: string;
  headers?: Record<string, string>;
}

export interface AuthRequestInput {
  authorizationHeader: string | string[] | undefined;
  /** Requested model id; used for both rate-limit accounting and whitelist checks. */
  modelId: string;
  /** Estimated total tokens for the upcoming call. */
  estimatedTokens: number;
  /** Cost in USD for the upcoming call. `0` when unknown. */
  estimatedCostUsd: number;
}

export interface AuthRequestDeps {
  keys: KeyRepo;
  rateLimiter: RateLimiter;
  budget: BudgetTracker;
  now?: () => number;
}

/**
 * Run the full auth pipeline (token lookup, state check, whitelist, rate limit, budget).
 * Returns either a populated `AuthContext` or a structured rejection the caller turns
 * into an HTTP response.
 */
export function authenticateRequest(
  input: AuthRequestInput,
  deps: AuthRequestDeps,
): AuthContext | AuthRejection {
  const now = deps.now ?? Date.now;

  // 1. Bearer token extraction + lookup.
  const plaintext = extractBearerToken(input.authorizationHeader);
  if (!plaintext) {
    return { ok: false, statusCode: 401, errorCode: 'unauthorized', message: 'Missing Authorization: Bearer token' };
  }
  const auth = authenticate(plaintext, deps.keys);
  if (!auth.ok) {
    const code = auth.reason === 'revoked' ? 'key_revoked' : 'invalid_api_key';
    return { ok: false, statusCode: 401, errorCode: code, message: auth.message };
  }
  const key = auth.key;

  // 2. allowedModels whitelist check (pre-rate-limit so attackers cannot exhaust quota).
  if (!isModelAllowed(key, input.modelId)) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: 'model_not_allowed',
      message: `Model '${input.modelId}' is not in the allowed list for this key`,
    };
  }

  // 3. Rate limit (RPM + TPM).
  const rlConfig: RateLimitConfig = { rpm: key.rpm_limit, tpm: key.tpm_limit };
  const rl = deps.rateLimiter.check(key.id, input.estimatedTokens, rlConfig);
  if (!rl.ok) {
    return {
      ok: false,
      statusCode: 429,
      errorCode: rl.dimension === 'rpm' ? 'rate_limit_rpm' : 'rate_limit_tpm',
      message: `Rate limit exceeded (${rl.dimension})`,
      headers: { 'Retry-After': String(rl.retryAfterSeconds) },
    };
  }

  // 4. Budget check (hard mode only). We do NOT mutate the counter here; commit() does.
  const budget = deps.budget.check(key, input.estimatedCostUsd);
  if (!budget.ok) {
    return {
      ok: false,
      statusCode: 402,
      errorCode: 'budget_exceeded',
      message: `Budget exceeded for period '${budget.exceeded}'`,
    };
  }

  return { ok: true, key, plaintext };
}

/** Re-export the success type for downstream consumers. */
export type { AuthSuccess };
