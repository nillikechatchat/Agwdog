import type { IRRequest } from '../ir/types.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleOptions } from './openai-compatible.js';

/**
 * 豆包 Ark (Volcengine). Wire format is OpenAI Chat Completions; defaults to
 * the public Ark base URL and a Bearer-token auth header. Callers can still
 * override the path or inject extra headers via the options.
 */
export class DoubaoAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleOptions = {}) {
    super(options);
  }
  // baseUrl/host is resolved at the HTTP client layer from the Provider row;
  // this adapter only contributes path + auth defaults.
  override buildRequestHeaders(ir: IRRequest, apiKey: string): Record<string, string> {
    return super.buildRequestHeaders(ir, apiKey);
  }
}
