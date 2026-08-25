/**
 * Structured JSON logger for ai-gateway.
 *
 * Every log line is a single JSON object on stdout with `ts`, `level`,
 * `msg`, plus arbitrary structured fields. Sensitive fields (Authorization,
 * Cookie, X-Api-Key, plus inline credentials like `sk-…`, `Bearer …`,
 * `AKIA…`, `ghp_…`, PEM blocks) are recursively replaced with `***` before
 * emission.
 *
 * Level control:
 *   - Set `LOG_LEVEL=debug|info|warn|error` to override the default `info`.
 *   - Set `LOG_QUIET=1` to suppress all but errors (e.g. inside tests).
 *   - Set `LOG_JSON=0` to emit pretty lines instead of JSON (dev convenience).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_RE =
  /^(authorization|cookie|x-api-key|x-auth-token|x-goog-api-key|api[-_]?key|access[-_]?token|secret|password|passwd|pwd)$/i;
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bxoxb-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const REDACTED = '***';

function redactString(value: string): string {
  let out = value;
  for (const pat of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pat, (m) => {
      if (m.startsWith('-----')) return '***PEM***';
      if (m.startsWith('Bearer')) return 'Bearer ***';
      return REDACTED;
    });
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return REDACTED;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function resolveLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function shouldUseJson(): boolean {
  const raw = process.env['LOG_JSON'];
  if (raw === undefined) return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined, bindings: Record<string, unknown> | undefined): void {
  if (process.env['LOG_QUIET'] === '1' && LEVEL_RANK[level] < LEVEL_RANK.error) return;
  if (LEVEL_RANK[level] < LEVEL_RANK[resolveLevel()]) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(bindings ?? {}),
    ...(fields ?? {}),
  };
  const redacted = redactValue(record) as Record<string, unknown>;

  if (shouldUseJson()) {
    process.stdout.write(JSON.stringify(redacted) + '\n');
  } else {
    const fieldsStr = Object.keys(redacted)
      .filter((k) => k !== 'ts' && k !== 'level' && k !== 'msg')
      .map((k) => `${k}=${JSON.stringify((redacted as Record<string, unknown>)[k])}`)
      .join(' ');
    process.stdout.write(`[${redacted['ts']}] ${String(redacted['level']).toUpperCase()} ${redacted['msg']}${fieldsStr ? ' ' + fieldsStr : ''}\n`);
  }
}

export function createLogger(bindings?: Record<string, unknown>): Logger {
  const bound = bindings ?? {};
  return {
    debug: (msg, fields) => emit('debug', msg, fields, bound),
    info: (msg, fields) => emit('info', msg, fields, bound),
    warn: (msg, fields) => emit('warn', msg, fields, bound),
    error: (msg, fields) => emit('error', msg, fields, bound),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

/** Default process-wide logger. */
export const log = createLogger();

/**
 * Redact a value explicitly (useful for unit tests and external callers).
 */
export function redact(value: unknown): unknown {
  return redactValue(value);
}