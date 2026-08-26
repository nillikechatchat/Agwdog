import { describe, it, expect } from 'vitest';
import { extractBearerToken, generateVirtualKey, hashKey } from '../../../src/auth/keys.js';

describe('generateVirtualKey', () => {
  it('produces a key with the default gw- prefix', () => {
    const k = generateVirtualKey();
    expect(k.plaintext.startsWith('gw-')).toBe(true);
    expect(k.keyPrefix).toBe(k.plaintext.slice(0, 8));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honors a custom prefix', () => {
    const k = generateVirtualKey('sk-gw');
    expect(k.plaintext.startsWith('sk-gw-')).toBe(true);
  });

  it('returns distinct keys on each call', () => {
    const a = generateVirtualKey();
    const b = generateVirtualKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashKey', () => {
  it('is deterministic', () => {
    expect(hashKey('gw-abc')).toBe(hashKey('gw-abc'));
  });

  it('produces 64-char hex', () => {
    expect(hashKey('gw-abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractBearerToken', () => {
  it('extracts a token from a well-formed header', () => {
    expect(extractBearerToken('Bearer gw-xyz')).toBe('gw-xyz');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer gw-xyz')).toBe('gw-xyz');
    expect(extractBearerToken('BEARER gw-xyz')).toBe('gw-xyz');
  });

  it('returns null for empty / missing / wrong scheme', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('handles array headers (folded by Node http)', () => {
    expect(extractBearerToken(['Bearer gw-xyz'])).toBe('gw-xyz');
  });

  it('trims trailing whitespace from the token', () => {
    expect(extractBearerToken('Bearer   gw-xyz   ')).toBe('gw-xyz');
  });
});
