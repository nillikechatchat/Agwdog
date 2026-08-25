/**
 * AES-256-GCM encryption for upstream provider API keys.
 *
 * Keys are stored in SQLite as ciphertext + IV + auth tag.
 * The 32-byte master key comes from:
 *   1. `GATEWAY_MASTER_KEY` environment variable (preferred for production), or
 *   2. The local file `<dataDir>/master.key` (created on first run with mode 0600)
 *
 * The format on disk is:
 *   { version(1) | iv(12) | tag(16) | ciphertext }  (base64-encoded, "v1:" prefixed)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const VERSION = 'v1';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Load the 32-byte master key, generating one if it doesn't exist.
 *
 * @param dataDir  the gateway data directory; master.key lives inside it
 * @param envValue optional override from `GATEWAY_MASTER_KEY` env (hex string)
 */
export function loadMasterKey(dataDir: string, envValue?: string): Buffer {
  if (envValue !== undefined && envValue !== '') {
    const key = Buffer.from(envValue, 'hex');
    if (key.length !== KEY_LEN) {
      throw new CryptoError(
        `GATEWAY_MASTER_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`,
      );
    }
    return key;
  }

  const keyPath = resolve(dataDir, 'master.key');
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length !== KEY_LEN) {
      throw new CryptoError(`Master key file at ${keyPath} is corrupt (expected ${KEY_LEN} bytes, got ${raw.length})`);
    }
    return raw;
  }

  const fresh = randomBytes(KEY_LEN);
  const parent = dirname(keyPath);
  if (!existsSync(parent)) {
    throw new CryptoError(`Data directory ${parent} does not exist`);
  }
  writeFileSync(keyPath, fresh, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return fresh;
}

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Encrypt a UTF-8 plaintext. Returns base64-encoded iv/tag/ciphertext.
 */
export function encrypt(plaintext: string, masterKey: Buffer): EncryptedBlob {
  if (masterKey.length !== KEY_LEN) {
    throw new CryptoError(`Master key must be ${KEY_LEN} bytes`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    throw new CryptoError(`Unexpected GCM tag length: ${tag.length}`);
  }
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an {@link EncryptedBlob} produced by {@link encrypt}.
 *
 * Throws {@link CryptoError} if the blob is malformed or the auth tag fails to verify.
 */
export function decrypt(blob: EncryptedBlob, masterKey: Buffer): string {
  if (masterKey.length !== KEY_LEN) {
    throw new CryptoError(`Master key must be ${KEY_LEN} bytes`);
  }
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  if (iv.length !== IV_LEN) throw new CryptoError(`Invalid IV length: ${iv.length}`);
  if (tag.length !== TAG_LEN) throw new CryptoError(`Invalid tag length: ${tag.length}`);
  const decipher = createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new CryptoError(
      `Decryption failed (likely wrong master key or tampered ciphertext): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Round-trip helper: encrypt a plaintext, then decrypt, asserting equality.
 */
export function roundTrip(plaintext: string, masterKey: Buffer): string {
  return decrypt(encrypt(plaintext, masterKey), masterKey);
}