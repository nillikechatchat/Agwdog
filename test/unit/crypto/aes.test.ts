import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CryptoError, decrypt, encrypt, loadMasterKey, roundTrip } from '@/crypto/aes.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ai-gateway-crypto-'));
});

function cleanup() {
  rmSync(dataDir, { recursive: true, force: true });
}

describe('encrypt / decrypt round-trip', () => {
  it('returns the same plaintext after decrypt', () => {
    const key = randomBytes(32);
    expect(roundTrip('sk-test-123', key)).toBe('sk-test-123');
    expect(roundTrip('', key)).toBe('');
    expect(roundTrip('中文混合 + emoji 🚀', key)).toBe('中文混合 + emoji 🚀');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const key = randomBytes(32);
    const a = encrypt('same-text', key);
    const b = encrypt('same-text', key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(decrypt(a, key)).toBe('same-text');
    expect(decrypt(b, key)).toBe('same-text');
  });

  it('returns base64 strings of expected lengths', () => {
    const key = randomBytes(32);
    const blob = encrypt('hello', key);
    expect(Buffer.from(blob.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(blob.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(blob.ciphertext, 'base64')).toHaveLength(5);
  });
});

describe('decrypt — error paths', () => {
  it('throws on wrong master key', () => {
    const blob = encrypt('sk-test', randomBytes(32));
    expect(() => decrypt(blob, randomBytes(32))).toThrow(CryptoError);
  });

  it('throws on tampered ciphertext', () => {
    const key = randomBytes(32);
    const blob = encrypt('sk-test', key);
    const tampered = { ...blob, ciphertext: Buffer.from('xxxxx').toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow(CryptoError);
  });

  it('throws on tampered tag', () => {
    const key = randomBytes(32);
    const blob = encrypt('sk-test', key);
    const badTag = Buffer.alloc(16, 0).toString('base64');
    expect(() => decrypt({ ...blob, tag: badTag }, key)).toThrow(CryptoError);
  });

  it('throws on malformed IV length', () => {
    const key = randomBytes(32);
    const blob = encrypt('sk-test', key);
    expect(() => decrypt({ ...blob, iv: Buffer.alloc(8).toString('base64') }, key)).toThrow(CryptoError);
  });

  it('throws on master key of wrong length', () => {
    const blob = encrypt('sk-test', randomBytes(32));
    expect(() => decrypt(blob, randomBytes(16))).toThrow(CryptoError);
    expect(() => encrypt('sk-test', randomBytes(16))).toThrow(CryptoError);
  });
});

describe('loadMasterKey', () => {
  it('returns the env-provided key when valid', () => {
    const k = randomBytes(32);
    const got = loadMasterKey(dataDir, k.toString('hex'));
    expect(got.equals(k)).toBe(true);
    expect(existsSync(join(dataDir, 'master.key'))).toBe(false);
    cleanup();
  });

  it('rejects env-provided key of wrong length', () => {
    expect(() => loadMasterKey(dataDir, randomBytes(16).toString('hex'))).toThrow(CryptoError);
    cleanup();
  });

  it('generates and persists a 32-byte key on first run', () => {
    const k = loadMasterKey(dataDir);
    expect(k).toHaveLength(32);
    const path = join(dataDir, 'master.key');
    expect(existsSync(path)).toBe(true);
    const persisted = readFileSync(path);
    expect(persisted).toHaveLength(32);
    expect(persisted.equals(k)).toBe(true);
    const st = statSync(path);
    expect((st.mode & 0o777).toString(8)).toBe('600');
    cleanup();
  });

  it('reuses an existing key file on subsequent calls', () => {
    const first = loadMasterKey(dataDir);
    const second = loadMasterKey(dataDir);
    expect(second.equals(first)).toBe(true);
    cleanup();
  });

  it('throws when persisted key is corrupt', () => {
    loadMasterKey(dataDir);
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(join(dataDir, 'master.key'), Buffer.alloc(8, 0));
    expect(() => loadMasterKey(dataDir)).toThrow(CryptoError);
    cleanup();
  });
});