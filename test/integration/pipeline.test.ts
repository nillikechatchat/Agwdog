/**
 * Integration test for the full request pipeline.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { openTestDatabase } from '../helpers/db.js';
import { ExactCache } from '../../src/cache/exact.js';
import { CacheOrchestrator } from '../../src/cache/orchestrator.js';
import { route, RoutingError } from '../../src/router/strategies.js';
import { createAdapter } from '../../src/adapters/index.js';
import { createClientSerializer } from '../../src/clients/index.js';
import type { IRRequest, IRResponse } from '../../src/ir/types.js';
import { AvailabilityCache, VirtualModelIndex, UpstreamModelIndex } from '../../src/storage/indexes.js';

describe('integration pipeline', () => {
  it('returns RoutingError for unknown model', () => {
    const { db } = openTestDatabase();
    try {
      const vmIdx = new VirtualModelIndex();
      const umIdx = new UpstreamModelIndex();
      const availability = new AvailabilityCache();
      expect(() =>
        route({ modelId: 'nonexistent' }, {
          virtualModels: vmIdx as never,
          upstreamModels: umIdx as never,
          availability: availability as never,
          nextCounter: () => 0,
        }),
      ).toThrow(RoutingError);
    } finally {
      db.close();
    }
  });

  it('OpenAI adapter builds valid request body from IR', () => {
    const adapter = createAdapter('OpenAI');
    const ir: IRRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      stream: false,
      temperature: 0.7,
      maxTokens: 100,
    };
    const envelope = adapter.buildRequestBody(ir);
    expect(envelope.body).toBeDefined();
    const body = envelope.body as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(Array.isArray(body['messages'])).toBe(true);
    expect(body['temperature']).toBe(0.7);
  });

  it('Anthropic adapter maps IR to Anthropic format', () => {
    const adapter = createAdapter('Anthropic');
    const ir: IRRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      stream: false,
      maxTokens: 256,
    };
    const envelope = adapter.buildRequestBody(ir);
    expect(envelope.body).toBeDefined();
    const body = envelope.body as Record<string, unknown>;
    expect(body['model']).toBe('claude-sonnet-4-20250514');
    expect(Array.isArray(body['messages'])).toBe(true);
  });

  it('OpenAIChatSerializer produces valid OpenAI Chat response', () => {
    const serializer = createClientSerializer('OpenAI-Chat');
    const irResponse: IRResponse = {
      id: 'resp-1',
      model: 'gpt-4o',
      choices: [
        { index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, finishReason: 'stop' },
      ],
      usage: { promptTokens: 5, completionTokens: 3, cachedTokens: 0, totalTokens: 8 },
      finishReason: 'stop',
    };
    const result = serializer.serializeResponse(irResponse, { upstreamModel: 'gpt-4o', model: 'gpt-4o', latencyMs: 100 }) as Record<string, unknown>;
    expect((result as Record<string, unknown>)['object']).toBe('chat.completion');
    expect(Array.isArray(result['choices'])).toBe(true);
    expect((result as Record<string, unknown>)['object']).toBe('chat.completion');
  });

  it('GeminiSerializer produces valid Gemini response', () => {
    const serializer = createClientSerializer('Gemini-GenerateContent');
    const irResponse: IRResponse = {
      id: 'resp-2',
      model: 'gemini-2.0-flash',
      choices: [
        { index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Gemini reply' }] }, finishReason: 'stop' },
      ],
      usage: { promptTokens: 4, completionTokens: 2, cachedTokens: 0, totalTokens: 6 },
      finishReason: 'stop',
    };
    const result = serializer.serializeResponse(irResponse, { upstreamModel: 'gemini-2.0-flash', model: 'gemini-2.0-flash', latencyMs: 50 }) as Record<string, unknown>;
    expect(result).toHaveProperty('candidates');
  });

  it('ExactCache writes and reads a hit', () => {
    const { db, repos } = openTestDatabase();
    try {
      const exact = new ExactCache(repos.cache);
      const orchestrator = new CacheOrchestrator({ db: db as never, exact });

      const fingerprint = createHash('sha256').update('test-fp').digest('hex');
      const irResponse: IRResponse = {
        id: 'resp-3',
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'cached' }] }, finishReason: 'stop' }],
        usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2 },
        finishReason: 'stop',
      };

      orchestrator.store(
        {
          virtualModelId: 'vm-1',
          request: { model: 'gpt-4o', messages: [], stream: false } as IRRequest,
          fingerprint,
          keyId: 'test-key',
          clientProtocol: 'OpenAI-Chat',
        },
        irResponse,
      );

      const result = orchestrator.lookup({
        virtualModelId: 'vm-1',
        request: { model: 'gpt-4o', messages: [], stream: false } as IRRequest,
        fingerprint,
        keyId: 'test-key',
        clientProtocol: 'OpenAI-Chat',
      });

      expect(result.kind).toBe('exact');
    } finally {
      db.close();
    }
  });

  it('Full happy path: route -> adapter -> serializer', () => {
    const { db, repos } = openTestDatabase();
    try {
      repos.providers.insert({
        id: 'p1', name: 'P1', protocol: 'OpenAI', baseUrl: 'https://api.example.com/v1',
        apiKeyCiphertext: 'x', apiKeyIv: '0000000000000000',
        apiKeyTag: '0000000000000000',
      });
      repos.providerModels.bulkInsert([
        { id: 'm1', providerId: 'p1', modelId: 'gpt-4o', supportsStream: true, enabled: true },
      ]);
      repos.virtualModels.insert({ id: 'vm1', name: 'gpt-4o', strategy: 'RoundRobin', fallbackChain: [] });
      repos.virtualModels.addMember({ virtualModelId: 'vm1', upstreamModelId: 'm1', weight: 1, priority: 1 });

      const vmIdx = VirtualModelIndex.fromRepositories(repos);
      const umIdx = UpstreamModelIndex.fromRepositories(repos);
      const availability = AvailabilityCache.fromRepositories(repos);

      const decision = route({ modelId: 'gpt-4o' }, {
        virtualModels: vmIdx as never,
        upstreamModels: umIdx as never,
        availability: availability as never,
        nextCounter: () => 0,
      });
      expect(decision).toBeDefined();

      const adapter = createAdapter('OpenAI');
      const irReq: IRRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        stream: false,
      };
      const envelope = adapter.buildRequestBody(irReq);
      expect(envelope.body).toBeDefined();

      const serializer = createClientSerializer('OpenAI-Chat');
      const irResp: IRResponse = {
        id: 'resp-4',
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, finishReason: 'stop' }],
        usage: { promptTokens: 2, completionTokens: 3, cachedTokens: 0, totalTokens: 5 },
        finishReason: 'stop',
      };
      const rawResp = serializer.serializeResponse(irResp, { upstreamModel: 'gpt-4o', model: 'gpt-4o', latencyMs: 10 });
      expect((rawResp as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe('Hello!');
    } finally {
      db.close();
    }
  });
});
