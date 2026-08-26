import type {
  IRChoice,
  IRContent,
  IRFinishReason,
  IRMessage,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRTextContent,
  IRThinking,
  IRTool,
  IRToolChoice,
  IRToolResult,
  IRToolUse,
  IRUsage,
} from '../ir/types.js';
import { isText, isThinking, isToolResult, isToolUse } from '../ir/types.js';
import type { ProviderAdapter, ProviderRequestEnvelope } from './types.js';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[] | string;
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystemBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  thinking?: { type: 'enabled'; budget_tokens: number };
  metadata?: { user_id?: string };
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponseContent {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicResponseContent[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  usage: AnthropicUsage;
}

export class AnthropicAdapter implements ProviderAdapter {
  buildRequestBody(ir: IRRequest): ProviderRequestEnvelope {
    const system = collectSystem(ir.messages);
    const messages = ir.messages
      .filter((m) => m.role !== 'system' && m.role !== 'developer')
      .map(toAnthropicMessage);
    const body: AnthropicRequestBody = {
      model: ir.model,
      messages,
      max_tokens: ir.maxTokens ?? 4096,
    };
    if (system.length > 0) body.system = system;
    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.topP !== undefined) body.top_p = ir.topP;
    if (ir.stopSequences?.stop) body.stop_sequences = ir.stopSequences.stop;
    if (ir.stream) body.stream = true;
    if (ir.tools && ir.tools.length > 0) body.tools = ir.tools.map(toAnthropicTool);
    if (ir.toolChoice) {
      const tc = toAnthropicToolChoice(ir.toolChoice);
      if (tc) body.tool_choice = tc;
    }
    if (ir.reasoning?.budgetTokens !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: ir.reasoning.budgetTokens };
    }
    if (ir.metadata) body.metadata = ir.metadata as { user_id?: string };
    return { body, stream: ir.stream };
  }

  buildRequestHeaders(_ir: IRRequest, apiKey: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  endpointPath(_ir: IRRequest): string {
    return '/v1/messages';
  }

  parseResponse(raw: unknown): IRResponse {
    const r = raw as AnthropicResponse;
    if (!r || !Array.isArray(r.content)) {
      throw new Error('Anthropic response missing content[]');
    }
    const content: IRContent[] = [];
    for (const block of r.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const t: IRThinking = {
          type: 'thinking',
          text: block.thinking,
        };
        if (block.signature) t.signature = block.signature;
        content.push(t);
      } else if (block.type === 'tool_use' && block.id && block.name) {
        const tu: IRToolUse = {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        };
        content.push(tu);
      }
    }
    const choice: IRChoice = {
      index: 0,
      message: { role: 'assistant', content },
      finishReason: mapAnthropicStopReason(r.stop_reason),
    };
    const usage: IRUsage = {
      promptTokens: r.usage?.input_tokens ?? 0,
      completionTokens: r.usage?.output_tokens ?? 0,
      cachedTokens: r.usage?.cache_read_input_tokens ?? 0,
      totalTokens: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0),
    };
    return {
      id: r.id,
      model: r.model,
      choices: [choice],
      usage,
      finishReason: choice.finishReason,
    };
  }

  parseStreamEvent(raw: unknown): IRStreamEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    const type = obj['type'];
    const ev: IRStreamEvent = {};
    if (type === 'content_block_delta') {
      const delta = obj['delta'] as Record<string, unknown> | undefined;
      const inner = delta?.['delta'] as Record<string, unknown> | undefined;
      if (typeof inner?.['text'] === 'string') ev.textDelta = inner['text'];
      if (typeof inner?.['thinking'] === 'string') {
        ev.thinkingDelta = { text: inner['thinking'] };
      }
      if (typeof inner?.['signature'] === 'string') {
        ev.thinkingDelta = { ...ev.thinkingDelta, signature: inner['signature'] };
      }
    } else if (type === 'content_block_start') {
      const block = obj['content_block'] as Record<string, unknown> | undefined;
      if (block && block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        const name = typeof block['name'] === 'string' ? (block['name'] as string) : undefined;
        ev.toolUseDelta = name !== undefined
          ? { id: block['id'], name }
          : { id: block['id'] };
      }
    } else if (type === 'message_delta') {
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        ev.usageDelta = {};
        const pt = numberOrUndef(usage['input_tokens']);
        const ct = numberOrUndef(usage['output_tokens']);
        if (pt !== undefined) ev.usageDelta.promptTokens = pt;
        if (ct !== undefined) ev.usageDelta.completionTokens = ct;
      }
      const stop = obj['stop_reason'];
      if (typeof stop === 'string') ev.finishReason = mapAnthropicStopReason(stop);
    } else if (type === 'message_start') {
      const msg = obj['message'] as Record<string, unknown> | undefined;
      if (msg && typeof msg['id'] === 'string') ev.responseId = msg['id'];
      const usage = msg?.['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        ev.usageDelta = {};
        const pt = numberOrUndef(usage['input_tokens']);
        const ct = numberOrUndef(usage['output_tokens']);
        if (pt !== undefined) ev.usageDelta.promptTokens = pt;
        if (ct !== undefined) ev.usageDelta.completionTokens = ct;
      }
    }
    return ev;
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function collectSystem(messages: IRMessage[]): AnthropicSystemBlock[] {
  const blocks: AnthropicSystemBlock[] = [];
  for (const m of messages) {
    if (m.role !== 'system' && m.role !== 'developer') continue;
    const texts = m.content.filter(isText);
    for (const t of texts) {
      blocks.push({ type: 'text', text: t.text });
    }
  }
  return blocks;
}

function toAnthropicMessage(m: IRMessage): AnthropicMessage {
  if (m.role === 'assistant') {
    const blocks: AnthropicContentBlock[] = [];
    for (const c of m.content) {
      if (isText(c)) blocks.push({ type: 'text', text: c.text });
      else if (isToolUse(c)) {
        const inp = typeof c.arguments === 'string' ? safeParseJson(c.arguments) : (c.arguments as Record<string, unknown>);
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: inp });
      } else if (isThinking(c)) {
        const block: AnthropicThinkingBlock = { type: 'thinking', thinking: c.text };
        if (c.signature) block.signature = c.signature;
        blocks.push(block);
      }
    }
    return { role: 'assistant', content: blocks };
  }
  if (m.role === 'user') {
    const blocks: AnthropicContentBlock[] = [];
    for (const c of m.content) {
      if (isText(c)) blocks.push({ type: 'text', text: c.text });
    }
    return { role: 'user', content: blocks };
  }
  if (m.role === 'tool') {
    const blocks: AnthropicContentBlock[] = [];
    for (const c of m.content) {
      if (isToolResult(c)) {
        const block: AnthropicToolResultBlock = { type: 'tool_result', tool_use_id: c.toolCallId, content: stringifyToolResult(c.content) };
        if (c.isError) block.is_error = true;
        blocks.push(block);
      }
    }
    return { role: 'user', content: blocks };
  }
  return { role: 'user', content: '' };
}

function stringifyToolResult(c: IRToolResult['content']): string {
  if (typeof c === 'string') return c;
  return JSON.stringify(c);
}

function toAnthropicTool(t: IRTool): AnthropicTool {
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters as unknown as Record<string, unknown>,
  };
}

function toAnthropicToolChoice(choice: IRToolChoice): AnthropicRequestBody['tool_choice'] {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'auto' }; // Anthropic has no 'none' for tool_choice
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

function mapAnthropicStopReason(r: string | null): IRFinishReason {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'error';
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

export type { AnthropicRequestBody, AnthropicResponse, AnthropicMessage, AnthropicUsage };
