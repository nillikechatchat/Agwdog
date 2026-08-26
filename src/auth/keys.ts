import { createHash, randomBytes } from 'node:crypto';
import type { KeyRepo } from '../storage/repos/keys.js';
import type { KeyRow } from '../storage/types.js';

/**
 * Generate a cryptographically random Virtual Key in the form `gw-` + 32 base32-like chars.
 * The plaintext is returned once and never persisted; only the SHA-256 digest and a short
 * prefix for human identification are stored.
 */
export function generateVirtualKey(prefix = 'gw'): { plaintext: string; hash: string; keyPrefix: string } {
  const raw = randomBytes(20);
  const body = raw.toString('base64url');
  const plaintext = `${prefix}-${body}`;
  return {
    plaintext,
    hash: hashKey(plaintext),
    keyPrefix: plaintext.slice(0, 8),
  };
}

/** Compute the SHA-256 hex digest of a plaintext Virtual Key. */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Extract the bearer token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(authorizationHeader: string | string[] | undefined): string | null {
  if (!authorizationHeader) return null;
  const value = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!value) return null;
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ? m[1].trim() : null;
}

export interface AuthSuccess {
  ok: true;
  key: KeyRow;
  plaintext: string;
}

export interface AuthFailure {
  ok: false;
  reason: 'missing' | 'malformed' | 'not_found' | 'revoked';
  message: string;
}

/** Look up a plaintext key in the repository. */
export function authenticate(plaintext: string, keys: KeyRepo): AuthSuccess | AuthFailure {
  if (!plaintext) return { ok: false, reason: 'missing', message: 'Missing API key' };
  if (plaintext.length < 8) return { ok: false, reason: 'malformed', message: 'Malformed API key' };
  const row = keys.findByHash(hashKey(plaintext));
  if (!row) return { ok: false, reason: 'not_found', message: 'Invalid API key' };
  if (row.status === 'revoked') return { ok: false, reason: 'revoked', message: 'API key revoked' };
  return { ok: true, key: row, plaintext };
}

/** Parse the allowedModels JSON column into a Set (or null when unrestricted). */
export function parseAllowedModels(row: KeyRow): Set<string> | null {
  if (!row.allowed_models_json) return null;
  try {
    const arr = JSON.parse(row.allowed_models_json) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return new Set(arr.map(String));
  } catch {
    return null;
  }
}

/** Return true if the requested model id is allowed for this key (or when no whitelist is set). */
export function isModelAllowed(row: KeyRow, modelId: string): boolean {
  const allow = parseAllowedModels(row);
  if (!allow) return true;
  if (allow.has(modelId)) return true;
  if (allow.has('*')) return true;
  return false;
}
