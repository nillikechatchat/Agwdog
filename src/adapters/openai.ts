import type {
  IRChoice,
  IRContent,
  IRFinishReason,
  IRMessage,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRTextContent,
  IRTool,
  IRToolChoice,
  IRToolUse,
  IRUsage,
} from '../ir/types.js';
import { isText, isToolUse, isToolResult } from '../ir/types.js';
import type { ProviderAdapter, ProviderRequestEnvelope } from './types.js';

interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  response_format?: { type: 'json_object' | 'text' };
  reasoning_effort?: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
}

interface OpenAIChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

/** Adapter for the OpenAI Chat Completions API. */
export class OpenAIAdapter implements ProviderAdapter {
  buildRequestBody(ir: IRRequest): ProviderRequestEnvelope {
    const body: OpenAIRequestBody = {
      model: ir.model,
      messages: ir.messages.map(toOpenAIMessage),
    };
    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.topP !== undefined) body.top_p = ir.topP;
    if (ir.maxTokens !== undefined) body.max_tokens = ir.maxTokens;
    if (ir.stopSequences?.stop) body.stop = ir.stopSequences.stop;
    if (ir.stream) body.stream = true;
    if (ir.tools && ir.tools.length > 0) body.tools = ir.tools.map(toOpenAITool);
    if (ir.toolChoice) {
      const tc = toOpenAIToolChoice(ir.toolChoice);
      if (tc !== undefined) body.tool_choice = tc;
    }
    if (ir.responseFormat) {
      body.response_format = ir.responseFormat.kind === 'json_object' || ir.responseFormat.kind === 'json_schema'
        ? { type: 'json_object' }
        : { type: 'text' };
    }
    if (ir.reasoning?.effort) body.reasoning_effort = ir.reasoning.effort;
    if (ir.metadata) body.metadata = ir.metadata;
    return { body, stream: ir.stream };
  }

  buildRequestHeaders(_ir: IRRequest, apiKey: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
  }

  endpointPath(_ir: IRRequest): string {
    return '/v1/chat/completions';
  }

  parseResponse(raw: unknown): IRResponse {
    const r = raw as OpenAIResponse;
    if (!r || !Array.isArray(r.choices)) {
      throw new Error('OpenAI response missing choices[]');
    }
    const choices: IRChoice[] = r.choices.map((c) => ({
      index: c.index,
      message: fromOpenAIAssistantMessage(c.message),
      finishReason: mapOpenAIFinishReason(c.finish_reason),
    }));
    const usage: IRUsage = {
      promptTokens: r.usage?.prompt_tokens ?? 0,
      completionTokens: r.usage?.completion_tokens ?? 0,
      cachedTokens: r.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      totalTokens: r.usage?.total_tokens ?? 0,
    };
    const finishReason = choices[0]?.finishReason ?? 'stop';
    return {
      id: r.id,
      model: r.model,
      choices,
      usage,
      finishReason,
    };
  }

  parseStreamEvent(raw: unknown): IRStreamEvent | null {
    // The OpenAI SSE payload is a JSON object per `data:` line.
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    const choices = Array.isArray(obj['choices']) ? (obj['choices'] as Array<Record<string, unknown>>) : [];
    const first = choices[0];
    if (!first) return null;
    const delta = first['delta'] as Record<string, unknown> | undefined;
    const ev: IRStreamEvent = {};
    if (delta && typeof delta['content'] === 'string') ev.textDelta = delta['content'];
    if (Array.isArray(delta?.['tool_calls'])) {
      const tc = (delta['tool_calls'] as Array<Record<string, unknown>>)[0];
      if (tc) {
        const fn = tc['function'] as Record<string, unknown> | undefined;
        const id = String(tc['id'] ?? '');
        const name = typeof fn?.['name'] === 'string' ? (fn['name'] as string) : undefined;
        const args = typeof fn?.['arguments'] === 'string' ? (fn['arguments'] as string) : undefined;
        const obj: { id: string; name?: string; argumentsDelta?: string } = { id };
        if (name !== undefined) obj.name = name;
        if (args !== undefined) obj.argumentsDelta = args;
        ev.toolUseDelta = obj;
      }
    }
    const finishRaw = first['finish_reason'];
    if (typeof finishRaw === 'string') ev.finishReason = mapOpenAIFinishReason(finishRaw);
    if (typeof obj['id'] === 'string') ev.responseId = obj['id'];
    const usage = obj['usage'];
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      const partial: Partial<IRUsage> = {};
      const pt = numberOrUndef(u['prompt_tokens']);
      const ct = numberOrUndef(u['completion_tokens']);
      const tt = numberOrUndef(u['total_tokens']);
      const cache = numberOrUndef((u['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']);
      if (pt !== undefined) partial.promptTokens = pt;
      if (ct !== undefined) partial.completionTokens = ct;
      if (tt !== undefined) partial.totalTokens = tt;
      if (cache !== undefined) partial.cachedTokens = cache;
      ev.usageDelta = partial;
    }
    return ev;
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function toOpenAIMessage(m: IRMessage): OpenAIMessage {
  if (m.role === 'tool') {
    const results = m.content.filter(isToolResult);
    if (results.length === 1) {
      const r = results[0]!;
      return {
        role: 'tool',
        tool_call_id: r.toolCallId,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
      };
    }
    // Multi tool results collapse to a single tool message in OpenAI; pick the first id.
    const first = results[0];
    return {
      role: 'tool',
      ...(first ? { tool_call_id: first.toolCallId } : {}),
      content: results.map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content))).join('\n'),
    };
  }
  const textOrNull = concatText(m.content);
  if (m.role === 'assistant') {
    const toolUses = m.content.filter(isToolUse);
    const msg: OpenAIMessage = {
      role: 'assistant',
      content: toolUses.length === m.content.length ? null : textOrNull,
    };
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) },
      }));
    }
    return msg;
  }
  // system / developer / user
  return {
    role: m.role === 'developer' ? 'developer' : m.role === 'system' ? 'system' : 'user',
    content: textOrNull ?? '',
    ...(m.name ? { name: m.name } : {}),
  };
}

function concatText(contents: IRContent[]): string | null {
  const texts = contents.filter(isText);
  if (texts.length === 0) return null;
  return texts.map((t) => t.text).join('');
}

function toOpenAITool(t: IRTool): OpenAITool {
  return {
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  };
}

function toOpenAIToolChoice(choice: IRToolChoice): OpenAIRequestBody['tool_choice'] {
  if (choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  return { type: 'function', function: { name: choice.name } };
}

function fromOpenAIAssistantMessage(m: OpenAIChoice['message']): IRMessage {
  const content: IRContent[] = [];
  if (typeof m.content === 'string' && m.content.length > 0) {
    const t: IRTextContent = { type: 'text', text: m.content };
    content.push(t);
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      let parsedArgs: unknown = tc.function.arguments;
      if (typeof tc.function.arguments === 'string') {
        try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = {}; }
      }
      const tu: IRToolUse = {
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      };
      content.push(tu);
    }
  }
  return { role: 'assistant', content };
}

function mapOpenAIFinishReason(r: string): IRFinishReason {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}

export type { OpenAIRequestBody, OpenAIResponse, OpenAIMessage, OpenAITool, OpenAIUsage };
