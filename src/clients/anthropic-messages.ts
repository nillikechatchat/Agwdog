import type {
  IRContent,
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
import type {
  ClientSseEvent,
  ClientSerializer,
  ExpectedRequestShape,
  ResponseMeta,
  StreamState,
} from './types.js';
import { SerializerError } from './types.js';

interface IncomingBody {
  model?: string;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages?: Array<{
    role: 'user' | 'assistant';
    content: string | Array<IncomingContentBlock>;
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  stop_sequences?: string[];
  thinking?: { type: 'enabled'; budget_tokens: number };
}

type IncomingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string }> }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking'; data: string };

export class AnthropicMessagesSerializer implements ClientSerializer {
  readonly protocol = 'Anthropic-Messages' as const;

  buildExpectedRequestBodyShape(): ExpectedRequestShape {
    return { description: '{ model, messages[], system?, max_tokens, stream? }' };
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
    const messages: IRMessage[] = [];
    if (body.system) {
      const sysText = typeof body.system === 'string'
        ? body.system
        : body.system.map((s) => s.text).join('\n');
      if (sysText.length > 0) {
        messages.push({ role: 'system', content: [{ type: 'text', text: sysText } as IRTextContent] });
      }
    }
    for (const m of body.messages) messages.push(fromAnthropicMessage(m));
    if (messages.some((m) => m.role === 'system')) {
      // Anthropic requires system as a top-level field, but we collapse to a
      // leading "system" message that the adapter layer is expected to hoist.
    }
    const ir: IRRequest = {
      model: body.model,
      messages,
      stream: body.stream === true,
    };
    if (typeof body.temperature === 'number') ir.temperature = body.temperature;
    if (typeof body.top_p === 'number') ir.topP = body.top_p;
    if (typeof body.max_tokens === 'number') ir.maxTokens = body.max_tokens;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
      ir.stopSequences = { stop: body.stop_sequences };
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      ir.tools = body.tools.map(toIRTool);
    }
    if (body.tool_choice !== undefined) ir.toolChoice = toIRToolChoice(body.tool_choice);
    return ir;
  }

  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown {
    const content: unknown[] = [];
    for (const c of ir.choices) {
      for (const part of c.message.content) {
        if (isText(part)) {
          content.push({ type: 'text', text: part.text });
        } else if (isToolUse(part)) {
          content.push({
            type: 'tool_use',
            id: part.id,
            name: part.name,
            input: part.arguments,
          });
        }
      }
    }
    return {
      id: ir.id,
      type: 'message',
      role: 'assistant',
      model: meta.upstreamModel || ir.model,
      content,
      stop_reason: toAnthropicStopReason(ir.choices[0]?.finishReason ?? 'stop'),
      stop_sequence: null,
      usage: {
        input_tokens: ir.usage.promptTokens,
        output_tokens: ir.usage.completionTokens,
        ...(ir.usage.cachedTokens > 0
          ? { cache_read_input_tokens: ir.usage.cachedTokens }
          : {}),
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
    const id = ev.responseId ?? state.responseId;
    if (ev.textDelta !== undefined) {
      if (state.outputItemId === undefined) {
        state.outputItemId = `text_${Math.floor(Math.random() * 1e9)}`;
        return {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        };
      }
      return {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ev.textDelta },
        },
      };
    }
    if (ev.thinkingDelta) {
      if (!state.toolUseId) {
        state.toolUseId = `think_${Math.floor(Math.random() * 1e9)}`;
        return {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', thinking: '' },
          },
        };
      }
      return {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: ev.thinkingDelta.text },
        },
      };
    }
    if (ev.toolUseDelta !== undefined) {
      const newTool = ev.toolUseDelta.id !== state.toolUseId;
      if (newTool) {
        state.toolUseId = ev.toolUseDelta.id;
        return {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: ev.toolUseDelta.id, name: ev.toolUseDelta.name ?? '', input: {} },
          },
        };
      }
      return {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: ev.toolUseDelta.argumentsDelta ?? '' },
        },
      };
    }
    if (ev.finishReason) {
      return {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: toAnthropicStopReason(ev.finishReason), stop_sequence: null },
          usage: ev.usageDelta
            ? { output_tokens: ev.usageDelta.completionTokens ?? 0 }
            : undefined,
        },
      };
    }
    return null;
  }

  terminalStreamEvent(): ClientSseEvent | null {
    return { event: 'message_stop', data: { type: 'message_stop' } };
  }
}

function fromAnthropicMessage(m: { role: string; content: string | IncomingContentBlock[] }): IRMessage {
  if (typeof m.content === 'string') {
    return { role: m.role as IRMessage['role'], content: [{ type: 'text', text: m.content }] };
  }
  const content: IRContent[] = [];
  for (const block of m.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({ type: 'tool_use', id: block.id, name: block.name, arguments: block.input });
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : block.content.map((c) => c.text).join('\n');
      content.push({ type: 'tool_result', toolCallId: block.tool_use_id, content: text });
    } else if (block.type === 'thinking') {
      content.push({ type: 'thinking', text: block.thinking } as IRThinking);
    }
  }
  return { role: m.role as IRMessage['role'], content };
}

function toIRTool(t: { name: string; description?: string; input_schema: Record<string, unknown> }): IRTool {
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.input_schema as unknown as IRTool['parameters'],
  };
}

function toIRToolChoice(c: NonNullable<IncomingBody['tool_choice']>): IRToolChoice {
  if (c.type === 'auto') return 'auto';
  if (c.type === 'any') return 'required';
  if (c.type === 'tool' && c.name) return { name: c.name };
  return 'auto';
}

function toAnthropicStopReason(r: string): string {
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  if (r === 'content_filter') return 'refusal';
  return 'end_turn';
}
