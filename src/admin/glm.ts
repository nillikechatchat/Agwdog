import { decrypt } from '../crypto/aes.js';
import type { ProviderRow } from '../storage/types.js';

export interface GlmWindow {
  kind: 'five_hours' | 'weekly' | 'other';
  label: string;
  usedPct: number;
  remainingPct: number;
  resetAtMs: number | null;
}

export interface GlmSubscription {
  providerId: string;
  providerName: string;
  maskedKey: string;
  platformBase: string;
  planLevel: string;
  windows: GlmWindow[];
  models: string[];
}

export interface GlmCandidate {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
}

const GLM_HOSTS = ['bigmodel.cn', 'z.ai', 'zhipu.ai'];
const QUOTA_TIMEOUT_MS = 20_000;
const MODELS_TIMEOUT_MS = 15_000;

export function maskKey(key: string): string {
  if (key.length >= 16) return key.slice(0, 12) + '****' + key.slice(-4);
  if (key.length >= 10) return key.slice(0, 6) + '****';
  if (key.length >= 4) return key.slice(0, 2) + '****';
  return '****';
}

/** Detect a GLM/Zhipu provider by its base URL host or display name. */
export function isGlmProvider(p: ProviderRow): boolean {
  try {
    const host = new URL(p.base_url).hostname.toLowerCase();
    if (GLM_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
  } catch {
    // malformed URL falls through to name check
  }
  const name = p.name.toLowerCase();
  return /glm|zhipu|zhipuai/.test(name);
}

/** Reduce a configured upstream base URL to the API platform origin. */
export function extractPlatformBase(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface ZhipuLimitItem {
  type?: unknown;
  unit?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

/**
 * Parse the limits array from the quota endpoint.
 * unit=3 → 5-hour window, unit=6 → weekly window; both TOKENS_LIMIT and
 * CREDIT_LIMIT types are accepted (case-insensitive). Unknown units fill
 * empty slots ordered by reset time, mirroring the reference client.
 */
export function parseWindows(limits: unknown): GlmWindow[] {
  if (!Array.isArray(limits)) return [];
  const five = { entry: null as ZhipuLimitItem | null };
  const week = { entry: null as ZhipuLimitItem | null };
  const others: ZhipuLimitItem[] = [];
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const typeRaw = rec['type'] === null || rec['type'] === undefined ? '' : String(rec['type']);
    const t = typeRaw.toUpperCase();
    if (t !== 'TOKENS_LIMIT' && t !== 'CREDIT_LIMIT') continue;
    const unit = Number.isFinite(Number(rec['unit'])) ? Number(rec['unit']) : -1;
    if (unit === 3 && !five.entry) five.entry = rec as ZhipuLimitItem;
    else if (unit === 6 && !week.entry) week.entry = rec as ZhipuLimitItem;
    else others.push(rec as ZhipuLimitItem);
  }
  if (!five.entry || !week.entry) {
    others
      .sort((a, b) => toNumber(a.nextResetTime) - toNumber(b.nextResetTime))
      .forEach((e) => {
        if (!five.entry) five.entry = e;
        else if (!week.entry) week.entry = e;
      });
  }
  const out: GlmWindow[] = [];
  const build = (entry: ZhipuLimitItem | null, kind: GlmWindow['kind'], label: string): void => {
    if (!entry) return;
    const used = Math.min(Math.max(toNumber(entry.percentage), 0), 999);
    out.push({
      kind,
      label,
      usedPct: used,
      remainingPct: Math.max(0, 100 - used),
      resetAtMs: Number.isFinite(Number(entry.nextResetTime)) && entry.nextResetTime !== null
        ? Number(entry.nextResetTime)
        : null,
    });
  };
  build(five.entry, 'five_hours', '5 小时窗口');
  build(week.entry, 'weekly', '本周窗口');
  return out;
}

function formatLevel(level: unknown): string {
  const s = String(level ?? '').trim();
  if (!s) return '未知';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { statusCode: res.status });
  return res.json();
}

/** Try each candidate models endpoint until one returns a non-empty list. */
export async function queryAvailableModels(base: string, headers: Record<string, string>): Promise<string[]> {
  const candidates = [
    `${base}/api/coding/paas/v4/models`,
    `${base}/api/paas/v4/models`,
    `${base}/api/anthropic/v1/models`,
  ];
  for (const url of candidates) {
    try {
      const data = await fetchJson(url, headers, MODELS_TIMEOUT_MS);
      const rawItems: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as Record<string, unknown>)?.['data'])
          ? ((data as Record<string, unknown>)['data'] as unknown[])
          : [];
      const items = rawItems
        .map((m) => {
          if (typeof m === 'string') return m;
          if (m && typeof m === 'object') {
            const rec = m as Record<string, unknown>;
            if (typeof rec['id'] === 'string') return rec['id'];
            if (typeof rec['name'] === 'string') return rec['name'];
          }
          return '';
        })
        .filter((s) => s.length > 0);
      if (items.length > 0) return [...new Set(items)];
    } catch {
      // try next candidate
    }
  }
  return [];
}

/** Query the Coding Plan usage/quota endpoint with the plaintext API key. */
export async function queryGlmSubscription(
  apiKeyPlain: string,
  baseUrl: string,
): Promise<Omit<GlmSubscription, 'providerId' | 'providerName'>> {
  const base = extractPlatformBase(baseUrl);
  // Zhipu convention: the Authorization header carries the bare key, no Bearer prefix.
  const headers = {
    'Authorization': apiKeyPlain,
    'Accept-Language': 'en-US,en',
    'User-Agent': 'ai-gateway-admin',
  };

  let payload: Record<string, unknown>;
  try {
    payload = (await fetchJson(`${base}/api/monitor/usage/quota/limit`, headers, QUOTA_TIMEOUT_MS)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 401 || status === 403) throw new Error('Key 无效或无权访问（401/403）');
    if (err instanceof Error && err.name === 'TimeoutError') throw new Error('请求额度接口超时');
    throw new Error(`额度接口不可达：${err instanceof Error ? err.message : String(err)}`);
  }

  if (payload['success'] === false) {
    throw new Error(String(payload['msg'] ?? '接口返回失败，请确认 Key 属于 Coding Plan 个人版套餐'));
  }
  const data = payload['data'] as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    throw new Error('接口返回缺少 data 字段，响应结构可能已变更');
  }

  const windows = parseWindows(data['limits']);
  const models = await queryAvailableModels(base, headers);

  return {
    maskedKey: maskKey(apiKeyPlain),
    platformBase: base,
    planLevel: formatLevel(data['level']),
    windows,
    models,
  };
}

/** Decrypt the stored provider key; throws when unavailable for this request. */
export function decryptProviderKey(p: ProviderRow, masterKey: Buffer | undefined): string {
  if (!p.api_key_ciphertext) throw new Error('该提供方未配置 API Key，请先在「提供方」页填写');
  if (!masterKey) throw new Error('未配置主加密密钥（GATEWAY_MASTER_KEY），无法解密 Key');
  return decrypt({ ciphertext: p.api_key_ciphertext, iv: p.api_key_iv, tag: p.api_key_tag }, masterKey);
}
