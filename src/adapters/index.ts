import type { Protocol } from '../storage/types.js';
import { OpenAIAdapter } from './openai.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleOptions } from './openai-compatible.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { DoubaoAdapter } from './doubao.js';
import { WenxinAdapter } from './wenxin.js';
import type { ProviderAdapter } from './types.js';

export interface AdapterFactoryOptions {
  pathOverride?: string;
  headerExtras?: Record<string, string>;
}

/**
 * Resolve a `Protocol` (the upstream protocol declared in the provider row)
 * to a concrete `ProviderAdapter` instance. Pure factory — no I/O, no state.
 */
export function createAdapter(protocol: Protocol, options: AdapterFactoryOptions = {}): ProviderAdapter {
  const opts: OpenAICompatibleOptions = {
    ...(options.pathOverride ? { pathOverride: options.pathOverride } : {}),
    ...(options.headerExtras ? { headerExtras: options.headerExtras } : {}),
  };
  switch (protocol) {
    case 'OpenAI':
      return new OpenAIAdapter();
    case 'OpenAI-Compatible':
      return new OpenAICompatibleAdapter(opts);
    case 'Anthropic':
      return new AnthropicAdapter();
    case 'Gemini':
      return new GeminiAdapter();
    case 'Doubao':
      return new DoubaoAdapter(opts);
    case 'Wenxin':
      return new WenxinAdapter(opts);
  }
}

export { OpenAIAdapter } from './openai.js';
export { OpenAICompatibleAdapter, type OpenAICompatibleOptions } from './openai-compatible.js';
export { AnthropicAdapter } from './anthropic.js';
export { GeminiAdapter } from './gemini.js';
export { DoubaoAdapter } from './doubao.js';
export { WenxinAdapter } from './wenxin.js';
export type { ProviderAdapter, ProviderRequestEnvelope } from './types.js';
export { AdapterError } from './types.js';
