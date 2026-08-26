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
  IRToolResult,
  IRToolUse,
  IRUsage,
} from '../ir/types.js';
import { isText, isToolResult, isToolUse } from '../ir/types.js';
import type {
  ClientSseEvent,
  ClientSerializer,
  ExpectedRequestShape,
  ResponseMeta,
  StreamState,
} from './types.js';
import { SerializerError } from './types.js';

interface IncomingMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface IncomingTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface IncomingBody {
  model?: string;
  messages?: IncomingMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: IncomingTool[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  stop?: string[] | string;
}

export class OpenAIChatSerializer implements ClientSerializer {
  readonly protocol = 'OpenAI-Chat' as const;

  buildExpectedRequestBodyShape(): ExpectedRequestShape {
    return { description: '{ model, messages[], stream? }' };
  }

  parseIncomingRequest(raw: unknown): IRRequest {
    const body = raw as IncomingBody;
    if (!body || typeof body !== 'object') {
      throw new SerializerError(this.protocol, 'body must be a JSON object');
    }
    if (typeof body.model !== 'string' || body.model.length === 0) {
      throw new SerializerError(this.protocol, 'missing required field: model');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new SerializerError(this.protocol, 'missing required field: messages[]');
    }
    const messages: IRMessage[] = body.messages.map(fromIncomingMessage);
    const ir: IRRequest = {
      model: body.model,
      messages,
      stream: body.stream === true,
    };
    if (typeof body.temperature === 'number') ir.temperature = body.temperature;
    if (typeof body.top_p === 'number') ir.topP = body.top_p;
    if (typeof body.max_tokens === 'number') ir.maxTokens = body.max_tokens;
    if (body.stop) ir.stopSequences = { stop: Array.isArray(body.stop) ? body.stop : [body.stop] };
    if (Array.isArray(body.tools) && body.tools.length > 0) ir.tools = body.tools.map(toIRTool);
    if (body.tool_choice !== undefined) ir.toolChoice = toIRToolChoice(body.tool_choice);
    return ir;
  }

  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown {
    return {
      id: ir.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: meta.upstreamModel || ir.model,
      choices: ir.choices.map((c) => ({
        index: c.index,
        message: {
          role: 'assistant',
          content: pickText(c.message.content),
          ...(hasToolUse(c.message.content) ? { tool_calls: toOutgoingToolCalls(c.message.content) } : {}),
        },
        finish_reason: toOpenAIFinishReason(c.finishReason),
      })),
      usage: {
        prompt_tokens: ir.usage.promptTokens,
        completion_tokens: ir.usage.completionTokens,
        total_tokens: ir.usage.totalTokens,
        ...(ir.usage.cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: ir.usage.cachedTokens } } : {}),
      },
      x_gateway: {
        requested_model: meta.model,
        served_by: ir.model,
        latency_ms: meta.latencyMs,
      },
    };
  }

  serializeStreamEvent(ev: IRStreamEvent, state: StreamState): ClientSseEvent | null {
    if (state.done) return null;
    const delta: Record<string, unknown> = { role: 'assistant' };
    if (ev.textDelta !== undefined) delta['content'] = ev.textDelta;
    if (ev.toolUseDelta !== undefined) {
      const td: Record<string, unknown> = {
        index: 0,
        id: ev.toolUseDelta.id,
        type: 'function',
        function: {},
      };
      if (ev.toolUseDelta.name !== undefined) (td['function'] as Record<string, unknown>)['name'] = ev.toolUseDelta.name;
      if (ev.toolUseDelta.argumentsDelta !== undefined) (td['function'] as Record<string, unknown>)['arguments'] = ev.toolUseDelta.argumentsDelta;
      delta['tool_calls'] = [td];
    }
    const chunk: Record<string, unknown> = {
      id: ev.responseId ?? state.responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: ev.finishReason ? toOpenAIFinishReason(ev.finishReason) : null,
        },
      ],
    };
    if (ev.usageDelta) {
      const u: Record<string, unknown> = {};
      if (typeof ev.usageDelta.promptTokens === 'number') u['prompt_tokens'] = ev.usageDelta.promptTokens;
      if (typeof ev.usageDelta.completionTokens === 'number') u['completion_tokens'] = ev.usageDelta.completionTokens;
      if (typeof ev.usageDelta.totalTokens === 'number') u['total_tokens'] = ev.usageDelta.totalTokens;
      if (typeof ev.usageDelta.cachedTokens === 'number') u['prompt_tokens_details'] = { cached_tokens: ev.usageDelta.cachedTokens };
      chunk['usage'] = u;
    }
    return { event: '', data: chunk };
  }

  terminalStreamEvent(): ClientSseEvent | null {
    return { event: '', data: '[DONE]' };
  }
}

function fromIncomingMessage(m: IncomingMessage): IRMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: [{
        type: 'tool_result',
        toolCallId: m.tool_call_id ?? '',
        content: m.content ?? '',
      } as IRToolResult],
    };
  }
  if (m.role === 'assistant') {
    const content: IRContent[] = [];
    if (typeof m.content === 'string' && m.content.length > 0) {
      content.push({ type: 'text', text: m.content });
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let parsed: unknown = tc.function.arguments;
        if (typeof tc.function.arguments === 'string') {
          try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = {}; }
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, arguments: parsed });
      }
    }
    return { role: 'assistant', content };
  }
  return {
    role: m.role,
    content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [],
  };
}

function toIRTool(t: IncomingTool): IRTool {
  return {
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    parameters: t.function.parameters as unknown as IRTool['parameters'],
  };
}

function toIRToolChoice(c: IncomingBody['tool_choice']): IRToolChoice {
  if (c === undefined) return 'auto';
  if (typeof c === 'string') {
    if (c === 'auto' || c === 'none' || c === 'required') return c;
    return 'auto';
  }
  if (c.type === 'function') return { name: c.function.name };
  return 'auto';
}

function pickText(content: IRContent[]): string {
  return content.filter(isText).map((t) => t.text).join('') ?? '';
}

function hasToolUse(content: IRContent[]): boolean {
  return content.some(isToolUse);
}

function toOutgoingToolCalls(content: IRContent[]) {
  return content.filter(isToolUse).map((t) => ({
    id: t.id,
    type: 'function',
    function: {
      name: t.name,
      arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments),
    },
  }));
}

function toOpenAIFinishReason(r: IRFinishReason): string {
  switch (r) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'tool_calls';
    case 'content_filter': return 'content_filter';
    case 'error': return 'stop';
  }
}
