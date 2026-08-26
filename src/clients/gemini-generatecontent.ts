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
import { isText, isToolResult, isToolUse } from '../ir/types.js';
import type {
  ClientSseEvent,
  ClientSerializer,
  ExpectedRequestShape,
  ResponseMeta,
  StreamState,
} from './types.js';
import { SerializerError } from './types.js';

interface IncomingBody {
  contents?: Array<{
    role?: 'user' | 'model';
    parts: Array<IncomingPart>;
  }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parameters: Record<string, unknown> }> }>;
  toolConfig?: { functionCallingConfig?: { mode: 'AUTO' | 'ANY' | 'NONE' } };
}

type IncomingPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

export class GeminiSerializer implements ClientSerializer {
  readonly protocol = 'Gemini-GenerateContent' as const;

  buildExpectedRequestBodyShape(): ExpectedRequestShape {
    return { description: '{ contents[], generationConfig?, tools? } (model in URL path)' };
  }

  parseIncomingRequest(raw: unknown): IRRequest {
    const body = raw as IncomingBody;
    if (!body || typeof body !== 'object') {
      throw new SerializerError(this.protocol, 'body must be a JSON object');
    }
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      throw new SerializerError(this.protocol, 'missing required field: contents[]');
    }
    const messages: IRMessage[] = [];
    if (body.systemInstruction) {
      const sysText = body.systemInstruction.parts.map((p) => p.text).join('\n');
      if (sysText.length > 0) {
        messages.push({ role: 'system', content: [{ type: 'text', text: sysText } as IRTextContent] });
      }
    }
    for (const c of body.contents) messages.push(fromGeminiContent(c));
    const ir: IRRequest = { model: '<gemini>', messages, stream: false };
    const gc = body.generationConfig;
    if (gc) {
      if (typeof gc.temperature === 'number') ir.temperature = gc.temperature;
      if (typeof gc.topP === 'number') ir.topP = gc.topP;
      if (typeof gc.maxOutputTokens === 'number') ir.maxTokens = gc.maxOutputTokens;
      if (Array.isArray(gc.stopSequences) && gc.stopSequences.length > 0) {
        ir.stopSequences = { stop: gc.stopSequences };
      }
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      ir.tools = body.tools.flatMap((t) => t.functionDeclarations.map(toIRTool));
    }
    if (body.toolConfig?.functionCallingConfig) {
      const mode = body.toolConfig.functionCallingConfig.mode;
      if (mode === 'NONE') ir.toolChoice = 'none';
      else if (mode === 'ANY') ir.toolChoice = 'required';
    }
    return ir;
  }

  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown {
    return {
      candidates: ir.choices.map((c) => ({
        index: c.index,
        content: { role: 'model', parts: toGeminiParts(c.message.content) },
        finishReason: toGeminiFinishReason(c.finishReason),
        avgLogprobs: null,
      })),
      modelVersion: meta.upstreamModel || ir.model,
      usageMetadata: {
        promptTokenCount: ir.usage.promptTokens,
        candidatesTokenCount: ir.usage.completionTokens,
        totalTokenCount: ir.usage.totalTokens,
        ...(ir.usage.cachedTokens > 0 ? { cachedContentTokenCount: ir.usage.cachedTokens } : {}),
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
    const parts: unknown[] = [];
    if (ev.textDelta !== undefined) parts.push({ text: ev.textDelta });
    if (ev.thinkingDelta) parts.push({ thought: ev.thinkingDelta.text });
    if (ev.toolUseDelta) {
      parts.push({ functionCall: { name: ev.toolUseDelta.name ?? '', args: tryParseJson(ev.toolUseDelta.argumentsDelta) } });
    }
    if (parts.length === 0) return null;
    return {
      event: '',
      data: { candidates: [{ content: { role: 'model', parts } }] },
    };
  }

  terminalStreamEvent(): ClientSseEvent | null {
    return null;
  }
}

function fromGeminiContent(c: { role?: string; parts: IncomingPart[] }): IRMessage {
  const content: IRContent[] = [];
  for (const p of c.parts) {
    if ('text' in p && typeof p.text === 'string') {
      content.push({ type: 'text', text: p.text });
    } else if ('functionCall' in p) {
      content.push({ type: 'tool_use', id: `call_${Math.floor(Math.random() * 1e9)}`, name: p.functionCall.name, arguments: p.functionCall.args });
    } else if ('functionResponse' in p) {
      const respText = typeof p.functionResponse.response === 'string'
        ? p.functionResponse.response
        : JSON.stringify(p.functionResponse.response);
      content.push({ type: 'tool_result', toolCallId: '', content: respText });
    }
  }
  const role: IRMessage['role'] = c.role === 'model' ? 'assistant' : 'user';
  return { role, content };
}

function toIRTool(d: { name: string; description?: string; parameters: Record<string, unknown> }): IRTool {
  return {
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    parameters: d.parameters as unknown as IRTool['parameters'],
  };
}

function toGeminiParts(content: IRContent[]): unknown[] {
  const out: unknown[] = [];
  for (const p of content) {
    if (isText(p)) out.push({ text: p.text });
    else if (isToolUse(p)) out.push({ functionCall: { name: p.name, args: p.arguments } });
  }
  return out;
}

function toGeminiFinishReason(r: string): string {
  if (r === 'length') return 'MAX_TOKENS';
  if (r === 'content_filter') return 'SAFETY';
  if (r === 'tool_calls') return 'STOP';
  return 'STOP';
}

function tryParseJson(s: string | undefined): unknown {
  if (s === undefined) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
