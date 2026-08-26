import type {
  IRContent,
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

interface IncomingInputMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
}

interface IncomingTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

interface IncomingBody {
  model?: string;
  input?: IncomingInputMessage[] | string;
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  tools?: IncomingTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
}

export class OpenAIResponsesSerializer implements ClientSerializer {
  readonly protocol = 'OpenAI-Responses' as const;

  buildExpectedRequestBodyShape(): ExpectedRequestShape {
    return { description: '{ model, input[] | string, instructions?, stream? }' };
  }

  parseIncomingRequest(raw: unknown): IRRequest {
    const body = raw as IncomingBody;
    if (!body || typeof body !== 'object') {
      throw new SerializerError(this.protocol, 'body must be a JSON object');
    }
    if (typeof body.model !== 'string' || body.model.length === 0) {
      throw new SerializerError(this.protocol, 'missing required field: model');
    }
    const messages: IRMessage[] = [];
    if (typeof body.instructions === 'string' && body.instructions.length > 0) {
      messages.push({ role: 'system', content: [{ type: 'text', text: body.instructions } as IRTextContent] });
    }
    if (Array.isArray(body.input)) {
      for (const m of body.input) messages.push(fromInput(m));
    } else if (typeof body.input === 'string') {
      messages.push({ role: 'user', content: [{ type: 'text', text: body.input }] });
    } else {
      throw new SerializerError(this.protocol, 'missing required field: input');
    }
    const ir: IRRequest = {
      model: body.model,
      messages,
      stream: body.stream === true,
    };
    if (typeof body.temperature === 'number') ir.temperature = body.temperature;
    if (typeof body.top_p === 'number') ir.topP = body.top_p;
    if (typeof body.max_output_tokens === 'number') ir.maxTokens = body.max_output_tokens;
    if (Array.isArray(body.tools) && body.tools.length > 0) ir.tools = body.tools.map(toIRTool);
    if (body.tool_choice !== undefined) ir.toolChoice = toIRToolChoice(body.tool_choice);
    return ir;
  }

  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown {
    return {
      id: ir.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: meta.upstreamModel || ir.model,
      status: 'completed',
      output: ir.choices.map((c) => buildOutputItem(c)),
      usage: {
        input_tokens: ir.usage.promptTokens,
        output_tokens: ir.usage.completionTokens,
        total_tokens: ir.usage.totalTokens,
        ...(ir.usage.cachedTokens > 0
          ? { input_tokens_details: { cached_tokens: ir.usage.cachedTokens } }
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
    const model = state.model;
    if (ev.textDelta !== undefined) {
      return {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', item_id: state.outputItemId, delta: ev.textDelta },
      };
    }
    if (ev.toolUseDelta !== undefined) {
      if (ev.toolUseDelta.name !== undefined) state.toolUseId = ev.toolUseDelta.id;
      return {
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          item_id: ev.toolUseDelta.id,
          delta: ev.toolUseDelta.argumentsDelta ?? '',
        },
      };
    }
    if (ev.finishReason) {
      return {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            status: 'completed',
            usage: ev.usageDelta
              ? {
                  input_tokens: ev.usageDelta.promptTokens ?? 0,
                  output_tokens: ev.usageDelta.completionTokens ?? 0,
                  total_tokens: ev.usageDelta.totalTokens ?? 0,
                }
              : undefined,
          },
        },
      };
    }
    return null;
  }

  terminalStreamEvent(): ClientSseEvent | null {
    return { event: 'response.done', data: '[DONE]' };
  }
}

function fromInput(m: IncomingInputMessage): IRMessage {
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
    return { role: m.role, content: [{ type: 'text', text }] };
  }
  return { role: m.role, content: [{ type: 'text', text: m.content }] };
}

function toIRTool(t: IncomingTool): IRTool {
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters as unknown as IRTool['parameters'],
  };
}

function toIRToolChoice(c: IncomingBody['tool_choice']): IRToolChoice {
  if (c === undefined) return 'auto';
  if (typeof c === 'string') {
    if (c === 'auto' || c === 'none' || c === 'required') return c;
    return 'auto';
  }
  if (c.type === 'function') return { name: c.name };
  return 'auto';
}

function buildOutputItem(c: { index: number; message: { content: IRContent[] }; finishReason: string }): unknown {
  const parts: unknown[] = [];
  const text = c.message.content.filter(isText).map((t) => t.text).join('');
  if (text.length > 0) {
    parts.push({ type: 'output_text', text, annotations: [] });
  }
  const toolUses = c.message.content.filter(isToolUse);
  for (const tu of toolUses) {
    parts.push({
      type: 'function_call',
      call_id: tu.id,
      name: tu.name,
      arguments: typeof tu.arguments === 'string' ? tu.arguments : JSON.stringify(tu.arguments),
    });
  }
  return {
    id: `msg_${c.index}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: parts,
  };
}
