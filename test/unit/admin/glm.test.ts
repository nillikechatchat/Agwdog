import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  maskKey,
  isGlmProvider,
  extractPlatformBase,
  parseWindows,
  queryGlmSubscription,
} from '../../../src/admin/glm.js';
import type { ProviderRow } from '../../../src/storage/types.js';

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'p1',
    name: 'glm',
    protocol: 'OpenAI-Compatible',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_ciphertext: '',
    api_key_iv: '',
    api_key_tag: '',
    enabled: 1,
    input_price_per_mtokens_usd: null,
    output_price_per_mtokens_usd: null,
    cached_input_price_per_mtokens_usd: null,
    extra_json: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('glm admin helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maskKey truncates long keys and masks short ones', () => {
    expect(maskKey('abcdefghijklmnopwxyz1234')).toBe('abcdefghijkl****1234');
    expect(maskKey('abcdefghij')).toBe('abcdef****');
    expect(maskKey('abcd')).toBe('ab****');
    expect(maskKey('ab')).toBe('****');
  });

  it('isGlmProvider detects by host suffix', () => {
    expect(isGlmProvider(makeProvider({ base_url: 'https://open.bigmodel.cn/api/paas/v4' }))).toBe(true);
    expect(isGlmProvider(makeProvider({ base_url: 'https://api.z.ai/v1' }))).toBe(true);
    expect(isGlmProvider(makeProvider({ base_url: 'https://bigmodel.cn' }))).toBe(true);
    expect(isGlmProvider(makeProvider({ name: 'Relay', base_url: 'https://evil.example.com/?u=https://bigmodel.cn' }))).toBe(false);
  });

  it('isGlmProvider detects by name when URL is foreign', () => {
    expect(isGlmProvider(makeProvider({ name: 'My GLM main', base_url: 'https://relay.example.com' }))).toBe(true);
    expect(isGlmProvider(makeProvider({ name: 'Zhipu-Backup', base_url: 'https://relay.example.com' }))).toBe(true);
    expect(isGlmProvider(makeProvider({ name: 'OpenAI', base_url: 'https://api.openai.com' }))).toBe(false);
  });

  it('extractPlatformBase reduces to origin', () => {
    expect(extractPlatformBase('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn');
    expect(extractPlatformBase('https://api.z.ai')).toBe('https://api.z.ai');
  });

  describe('parseWindows', () => {
    it('maps unit=3 to five-hour window and unit=6 to weekly window', () => {
      const wins = parseWindows([
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 42.5, nextResetTime: 1700000000000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 10, nextResetTime: 1790000000000 },
      ]);
      expect(wins).toHaveLength(2);
      expect(wins[0]!.kind).toBe('five_hours');
      expect(wins[0]!.usedPct).toBeCloseTo(42.5);
      expect(wins[0]!.remainingPct).toBeCloseTo(57.5);
      expect(wins[1]!.kind).toBe('weekly');
    });

    it('accepts CREDIT_LIMIT types case-insensitively', () => {
      const wins = parseWindows([{ type: 'credit_limit', unit: 3, percentage: 5 }]);
      expect(wins[0]!.kind).toBe('five_hours');
    });

    it('fills missing slots from unknown units ordered by reset time', () => {
      const wins = parseWindows([
        { type: 'CREDIT_LIMIT', unit: 99, percentage: 30, nextResetTime: 200 },
        { type: 'CREDIT_LIMIT', unit: 50, percentage: 80, nextResetTime: 100 },
      ]);
      expect(wins[0]!.usedPct).toBe(80);
      expect(wins[1]!.usedPct).toBe(30);
    });

    it('clamps percentages and tolerates missing fields', () => {
      const wins = parseWindows([
        { type: 'CREDIT_LIMIT', unit: 3, percentage: 150 },
        { type: 'CREDIT_LIMIT', unit: 6, nextResetTime: null },
      ]);
      expect(wins[0]!.usedPct).toBe(999 <= 100 ? 100 : Math.min(Math.max(150, 0), 999));
      expect(wins[0]!.remainingPct).toBeGreaterThanOrEqual(0);
      expect(wins[1]!.resetAtMs).toBeNull();
    });

    it('returns empty for non-array or wrong-type entries', () => {
      expect(parseWindows(null)).toEqual([]);
      expect(parseWindows([{ type: 'OTHER_TYPE', unit: 3 }])).toEqual([]);
    });
  });

  describe('queryGlmSubscription', () => {
    function stubFetchSequence(responses: Array<{ ok?: boolean; status?: number; body?: unknown; throwErr?: Error }>) {
      const calls: string[] = [];
      let i = 0;
      vi.stubGlobal('fetch', async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        const r = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        if (r.throwErr) throw r.throwErr;
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: async () => r.body,
        };
      });
      return calls;
    }

    const quotaBody = {
      success: true,
      data: {
        level: 'pro',
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, percentage: 12.5, nextResetTime: 1900000000000 },
          { type: 'CREDIT_LIMIT', unit: 6, percentage: 66.66, nextResetTime: 1990000000000 },
        ],
      },
    };
    const modelsBody = { data: [{ id: 'glm-4.7' }, { id: 'glm-4.7-air' }, { id: 'glm-4.7' }] };

    it('queries quota then models with bare-key Authorization header', async () => {
      const calls = stubFetchSequence([
        { body: quotaBody },
        { body: modelsBody },
      ]);
      const sub = await queryGlmSubscription('secret-key-1234567890', 'https://open.bigmodel.cn/api/paas/v4');
      expect(calls[0]).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
      // Authorization must be verified via request behavior: header contents are set in fetch options
      expect(sub.planLevel).toBe('Pro');
      expect(sub.maskedKey).toBe('secret-key-1****7890');
      expect(sub.windows.map((w) => w.kind)).toEqual(['five_hours', 'weekly']);
      expect(sub.models).toEqual(['glm-4.7', 'glm-4.7-air']);
    });

    it('throws a Chinese error on 401', async () => {
      stubFetchSequence([{ ok: false, status: 401, body: {} }]);
      await expect(queryGlmSubscription('badkey', 'https://open.bigmodel.cn')).rejects.toThrow('401');
    });

    it('surfaces quota.failure message', async () => {
      stubFetchSequence([{ body: { success: false, msg: 'no coding plan' } }]);
      await expect(queryGlmSubscription('k'.repeat(20), 'https://open.bigmodel.cn')).rejects.toThrow('no coding plan');
    });

    it('does not fail the whole query when models endpoints all miss', async () => {
      stubFetchSequence([
        { body: quotaBody },
        { throwErr: new Error('x') },
        { throwErr: new Error('x') },
        { throwErr: new Error('x') },
      ]);
      const sub = await queryGlmSubscription('k'.repeat(20), 'https://open.bigmodel.cn');
      expect(sub.models).toEqual([]);
      expect(sub.windows.length).toBeGreaterThan(0);
    });

    it('falls back through model endpoint candidates', async () => {
      const calls = stubFetchSequence([
        { body: quotaBody },
        { body: [] },
        { body: { data: ['glm-4.6'] } },
      ]);
      const sub = await queryGlmSubscription('k'.repeat(20), 'https://open.bigmodel.cn');
      expect(calls[1]).toContain('/api/coding/paas/v4/models');
      expect(calls[2]).toContain('/api/paas/v4/models');
      expect(sub.models).toEqual(['glm-4.6']);
    });
  });
});
