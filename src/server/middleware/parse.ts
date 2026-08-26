/**
 * Request body parsing.
 *
 * We accept JSON only (matches every supported Client Protocol), with a
 * configurable upper bound to defend against payload floods. The parsed body
 * is attached to `req.gateway.body` so downstream handlers can read it as
 * strongly-typed JSON without re-parsing.
 */

import type { IncomingMessage } from 'node:http';

export interface ParseOptions {
  /** Maximum body size in bytes. Default 1 MiB. */
  maxBytes?: number;
}

export class BodyTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number) {
    super(`Request body of ${size} bytes exceeds limit of ${limit}`);
    this.name = 'BodyTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

export class InvalidJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJsonError';
  }
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Read and JSON-parse the request body. Resolves with the parsed value or
 * rejects with `BodyTooLargeError` / `InvalidJsonError`.
 */
export async function readJsonBody(req: IncomingMessage, options: ParseOptions = {}): Promise<unknown> {
  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > limit) {
      // Drain the socket so the connection can be reused; reject afterwards.
      req.resume();
      throw new BodyTooLargeError(received, limit);
    }
    chunks.push(buf);
  }

  if (received === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InvalidJsonError(
      `Failed to parse JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}