/**
 * IR normalisation and request fingerprinting.
 *
 * The fingerprint is the cornerstone of Exact Cache (Requirement 13). It must
 * be:
 *   - Stable: the same logical request produces the same hash on every machine
 *     and across process restarts.
 *   - Collision-resistant: changing any key field yields a different hash.
 *   - Cheap: O(n) in total payload size; we will compute it on every request.
 *
 * Implementation notes
 * --------------------
 * 1. JSON canonicalisation with sorted object keys, no whitespace.
 * 2. Only the cache-relevant fields participate (model + messages + temperature
 *    + top_p + max_tokens + tools + tool_choice + response_format + seed).
 * 3. Messages are normalised first: empty text chunks dropped, tool_use ids
 *    preserved verbatim, system/developer merged.
 */

import { createHash } from 'node:crypto';
import type {
  IRMessage,
  IRRequest,
  IRContent,
  IRTextContent,
  IRToolResult,
} from './types.js';

const SYSTEM_MERGED_ROLES = new Set(['system', 'developer']);

export function emptyIRRequest(): IRRequest {
  return { model: '', messages: [], stream: false };
}

/**
 * Drop empty text fragments and trim whitespace on text content.
 * Keeps all other content kinds untouched (image/audio/tool_use/thinking).
 */
export function normalizeMessage(msg: IRMessage): IRMessage {
  const content: IRContent[] = [];
  for (const c of msg.content) {
    if (c.type === 'text') {
      const trimmed = c.text.replace(/\s+/g, ' ').trim();
      if (trimmed.length > 0) content.push({ ...c, text: trimmed });
    } else {
      content.push(c);
    }
  }
  return { ...msg, content };
}

/**
 * Merge adjacent system/developer messages into a single system message.
 * Required so that Chat-Completions (which supports both `system` and
 * `developer` as the first user/system message) and Anthropic (which has a
 * dedicated `system` array parameter) end up with equivalent fingerprints.
 */
export function normalizeMessages(messages: IRMessage[]): IRMessage[] {
  const out: IRMessage[] = [];
  let systemBuffer: IRContent[] = [];
  const flushSystem = (): void => {
    if (systemBuffer.length === 0) return;
    out.push({ role: 'system', content: systemBuffer });
    systemBuffer = [];
  };
  for (const raw of messages) {
    const msg = normalizeMessage(raw);
    if (SYSTEM_MERGED_ROLES.has(msg.role)) {
      systemBuffer.push(...msg.content);
    } else {
      flushSystem();
      out.push(msg);
    }
  }
  flushSystem();
  return out;
}

/** Canonical JSON: sorted object keys, no extra whitespace, deterministic number handling. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value instanceof Date) return value.toISOString();
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalise(obj[k]);
  }
  return sorted;
}

export interface FingerprintInput {
  model: string;
  messages: IRMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: IRRequest['tools'];
  toolChoice?: IRRequest['toolChoice'];
  responseFormat?: IRRequest['responseFormat'];
  seed?: number;
}

/**
 * Compute a stable SHA-256 hash over the cache-relevant fields.
 *
 * Behaviour
 * ---------
 * - Two requests with byte-identical cache-relevant fields yield the same hash.
 * - Any semantic difference (model id, message order, tool definition, parameter value)
 *   yields a different hash.
 * - Returns a 64-character hex string.
 */
export function fingerprint(req: FingerprintInput): string {
  const normMessages = normalizeMessages(req.messages);
  const payload = {
    model: req.model,
    messages: normMessages.map(stripVolatileFields),
    temperature: normaliseNumber(req.temperature),
    top_p: normaliseNumber(req.topP),
    max_tokens: normaliseNumber(req.maxTokens),
    tools: req.tools ? req.tools.map(canonicalise) : undefined,
    tool_choice: req.toolChoice ? canonicalise(req.toolChoice) : undefined,
    response_format: req.responseFormat ? canonicalise(req.responseFormat) : undefined,
    seed: typeof req.seed === 'number' ? req.seed : undefined,
  };
  return createHash('sha256').update(canonicalJSON(payload)).digest('hex');
}

/**
 * For fingerprinting purposes we want tool_result `name` fields dropped (they
 * are sometimes added by Anthropic but not by OpenAI) and we want every IRContent
 * to compare exactly.
 */
function stripVolatileFields(msg: IRMessage): unknown {
  return {
    role: msg.role,
    name: msg.name,
    content: msg.content.map((c) => {
      if (c.type === 'tool_result') {
        const r: Record<string, unknown> = {
          type: 'tool_result',
          toolCallId: c.toolCallId,
          isError: c.isError ?? false,
        };
        r['content'] = typeof c.content === 'string' ? c.content : canonicalise(c.content);
        return r;
      }
      return canonicalise(c);
    }),
  };
}

/**
 * Numeric canonicalisation: undefined → undefined; integer-valued floats stay
 * floats; NaN/Infinity are coerced to undefined to avoid nondeterministic
 * serialisation differences across V8 versions.
 */
function normaliseNumber(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n)) return undefined;
  // Round to 6 decimal places to defeat harmless binary noise (e.g. 0.70000001).
  return Math.round(n * 1e6) / 1e6;
}

export interface TokenEstimateOptions {
  /** OpenAI-ish approximation: ~4 chars per token. */
  charsPerToken?: number;
}

/** Conservative token estimate based on textual content of an IR request. */
export function estimateTokens(req: { messages: IRMessage[] }, opts: TokenEstimateOptions = {}): number {
  const charsPerToken = opts.charsPerToken ?? 4;
  let total = 0;
  for (const msg of req.messages) {
    for (const c of msg.content) {
      if (c.type === 'text') total += c.text.length;
      else if (c.type === 'image') total += 85;
      else if (c.type === 'audio') total += 100;
      else if (c.type === 'tool_use') total += JSON.stringify(c.arguments).length;
      else if (c.type === 'tool_result') {
        if (typeof c.content === 'string') total += c.content.length;
        else for (const inner of c.content) total += (inner as IRTextContent).text?.length ?? 0;
      }
      else if (c.type === 'thinking') total += c.text.length;
    }
  }
  return Math.floor(total / charsPerToken);
}

/** Helper for tests: produce a fixed-shape IR message with one text part. */
export function textMsg(role: IRMessage['role'], text: string): IRMessage {
  return { role, content: [{ type: 'text', text }] };
}

export function toolResultMsg(toolCallId: string, output: string, isError = false): IRMessage {
  const result: IRToolResult = { type: 'tool_result', toolCallId, content: output, isError };
  return { role: 'tool', content: [result] };
}