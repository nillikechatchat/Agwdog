import type { IRRequest } from '../ir/types.js';
import type { ProviderAdapter, ProviderRequestEnvelope } from './types.js';
import { OpenAIAdapter } from './openai.js';

/**
 * OpenAI-Compatible adapter: same wire format as OpenAI Chat Completions but
 * configured to talk to a third-party endpoint (e.g. a local Ollama proxy, a
 * vLLM box, or a custom relay). The base URL and any header differences are
 * injected at construction; the body shape is identical.
 */
export class OpenAICompatibleAdapter extends OpenAIAdapter {
  constructor(private readonly options: OpenAICompatibleOptions = {}) {
    super('OpenAI-Compatible');
  }
  override buildRequestHeaders(ir: IRRequest, apiKey: string): Record<string, string> {
    const base = super.buildRequestHeaders(ir, apiKey);
    if (this.options.headerExtras) {
      return { ...base, ...this.options.headerExtras };
    }
    return base;
  }
  override endpointPath(ir: IRRequest): string {
    return this.options.pathOverride ?? super.endpointPath(ir);
  }
  buildBody(ir: IRRequest): ProviderRequestEnvelope {
    return this.buildRequestBody(ir);
  }
}

export interface OpenAICompatibleOptions {
  /** Override the request path (default `/v1/chat/completions`). */
  pathOverride?: string;
  /** Additional headers to merge in (e.g. `X-Tenant: foo`). */
  headerExtras?: Record<string, string>;
}
