import type { IRRequest } from '../ir/types.js';
import type { ProviderAdapter, ProviderRequestEnvelope } from './types.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleOptions } from './openai-compatible.js';
import { isText } from '../ir/types.js';
import type { IRMessage } from '../ir/types.js';

/**
 * 百度文心千帆. Underlying transport is OpenAI Chat Completions at
 * `{baseUrl}/v2/chat/completions`; the adapter is responsible for OAuth2
 * `client_credentials` access tokens (managed out of band by the HTTP client)
 * and for collapsing `system`/`developer` messages into the first `user`
 * turn — Wenxin only supports `user` / `assistant` roles.
 */
export class WenxinAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleOptions = {}) {
    super(options);
  }
  override endpointPath(_ir: IRRequest): string {
    return '/v2/chat/completions';
  }
  override buildRequestBody(ir: IRRequest): ProviderRequestEnvelope {
    // Collapse system/developer into a single user turn so Wenxin accepts it.
    const rewritten = collapseSystemIntoUser(ir.messages);
    return super.buildRequestBody({ ...ir, messages: rewritten });
  }
}

function collapseSystemIntoUser(messages: IRMessage[]): IRMessage[] {
  const out: IRMessage[] = [];
  const sysTexts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      for (const c of m.content) if (isText(c)) sysTexts.push(c.text);
      continue;
    }
    out.push(m);
  }
  if (sysTexts.length === 0) return messages;
  const prefix = sysTexts.join('\n');
  const firstUserIdx = out.findIndex((m) => m.role === 'user');
  if (firstUserIdx === -1) {
    out.unshift({ role: 'user', content: [{ type: 'text', text: prefix }] });
  } else {
    const first = out[firstUserIdx]!;
    const firstText = first.content.find(isText);
    if (firstText) firstText.text = `${prefix}\n${firstText.text}`;
    else out[firstUserIdx] = { role: 'user', content: [{ type: 'text', text: prefix }, ...first.content] };
  }
  return out;
}
