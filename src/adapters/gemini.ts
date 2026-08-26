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

interface GeminiPartText {
  text: string;
}
interface GeminiPartFunctionCall {
  functionCall: { name: string; args: Record<string, unknown> };
}
interface GeminiPartFunctionResponse {
  functionResponse: { name: string; response: Record<string, unknown> };
}
interface GeminiPartThought {
  thought: string;
}
type GeminiPart = GeminiPartText | GeminiPartFunctionCall | GeminiPartFunctionResponse | GeminiPartThought;

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { role: 'system'; parts: GeminiPartText[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: 'text/plain' | 'application/json';
  };
  tools?: GeminiTool[];
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  cachedContentTokenCount?: number;
  totalTokenCount: number;
}

interface GeminiCandidate {
  content: { role: 'model'; parts: GeminiPart[] };
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | string;
  index: number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  modelVersion?: string;
  usageMetadata?: GeminiUsageMetadata;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly protocol = 'Gemini' as const;
  buildRequestBody(ir: IRRequest): ProviderRequestEnvelope {
    const system = collectSystemInstruction(ir.messages);
    const contents: GeminiContent[] = [];
    for (const m of ir.messages) {
      if (m.role === 'system' || m.role === 'developer') continue;
      const parts: GeminiPart[] = [];
      for (const c of m.content) {
        if (isText(c)) parts.push({ text: c.text });
        else if (isToolUse(c)) parts.push({ functionCall: { name: c.name, args: typeof c.arguments === 'string' ? safeParse(c.arguments) : (c.arguments as Record<string, unknown>) } });
        else if (isToolResult(c)) parts.push({ functionResponse: { name: c.toolCallId, response: { result: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) } } });
        else if (isThinking(c)) parts.push({ thought: c.text });
      }
      if (parts.length === 0) continue;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    const body: GeminiRequestBody = { contents };
    if (system) body.systemInstruction = system;
    const cfg: GeminiRequestBody['generationConfig'] = {};
    if (ir.temperature !== undefined) cfg.temperature = ir.temperature;
    if (ir.topP !== undefined) cfg.topP = ir.topP;
    if (ir.maxTokens !== undefined) cfg.maxOutputTokens = ir.maxTokens;
    if (ir.stopSequences?.stop) cfg.stopSequences = ir.stopSequences.stop;
    if (ir.responseFormat?.kind === 'json_object' || ir.responseFormat?.kind === 'json_schema') {
      cfg.responseMimeType = 'application/json';
    }
    if (Object.keys(cfg).length > 0) body.generationConfig = cfg;
    if (ir.tools && ir.tools.length > 0) {
      body.tools = [{
        functionDeclarations: ir.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters as unknown as Record<string, unknown>,
        })),
      }];
    }
    if (ir.toolChoice) body.toolConfig = { functionCallingConfig: toGeminiToolChoice(ir.toolChoice) };
    return { body, stream: ir.stream };
  }

  buildRequestHeaders(_ir: IRRequest, apiKey: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  endpointPath(ir: IRRequest): string {
    // Gemini embeds the model in the path; the model is the upstream model id.
    return `/v1beta/models/${encodeURIComponent(ir.model)}:generateContent`;
  }

  parseResponse(raw: unknown, _request: IRRequest): IRResponse {
    const r = raw as GeminiResponse;
    if (!r || !Array.isArray(r.candidates) || r.candidates.length === 0) {
      throw new Error('Gemini response missing candidates[]');
    }
    const choices: IRChoice[] = r.candidates.map((c) => ({
      index: c.index,
      message: fromGeminiCandidate(c),
      finishReason: mapGeminiFinishReason(c.finishReason),
    }));
    const usage: IRUsage = {
      promptTokens: r.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: r.usageMetadata?.candidatesTokenCount ?? 0,
      cachedTokens: r.usageMetadata?.cachedContentTokenCount ?? 0,
      totalTokens: r.usageMetadata?.totalTokenCount ?? 0,
    };
    return {
      id: `gemini-${Date.now()}`,
      model: r.modelVersion ?? '',
      choices,
      usage,
      finishReason: choices[0]?.finishReason ?? 'stop',
    };
  }

  parseStreamEvent(raw: unknown, _request: IRRequest): IRStreamEvent | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    const candidates = Array.isArray(obj['candidates']) ? (obj['candidates'] as Array<Record<string, unknown>>) : [];
    const first = candidates[0];
    if (!first) return null;
    const ev: IRStreamEvent = {};
    const content = first['content'] as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.['parts']) ? (content['parts'] as Array<Record<string, unknown>>) : [];
    for (const part of parts) {
      if (typeof part['text'] === 'string') {
        ev.textDelta = (ev.textDelta ?? '') + part['text'];
      }
      if (typeof part['thought'] === 'string') {
        ev.thinkingDelta = { ...ev.thinkingDelta, text: (ev.thinkingDelta?.text ?? '') + part['thought'] };
      }
    }
    if (typeof first['finishReason'] === 'string') {
      ev.finishReason = mapGeminiFinishReason(first['finishReason']);
    }
    return ev;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function collectSystemInstruction(messages: IRMessage[]): GeminiRequestBody['systemInstruction'] {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system' && m.role !== 'developer') continue;
    for (const c of m.content) {
      if (isText(c)) texts.push(c.text);
    }
  }
  if (texts.length === 0) return undefined;
  return { role: 'system', parts: texts.map((t) => ({ text: t })) };
}

function fromGeminiCandidate(c: GeminiCandidate): IRMessage {
  const content: IRContent[] = [];
  for (const part of c.content.parts) {
    if ('text' in part) {
      const t: IRTextContent = { type: 'text', text: part.text };
      content.push(t);
    } else if ('thought' in part) {
      const t: IRThinking = { type: 'thinking', text: part.thought };
      content.push(t);
    } else if ('functionCall' in part) {
      const tu: IRToolUse = {
        type: 'tool_use',
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      };
      content.push(tu);
    }
  }
  return { role: 'assistant', content };
}

function toGeminiToolChoice(choice: IRToolChoice): { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } {
  if (choice === 'auto') return { mode: 'AUTO' };
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  return { mode: 'ANY', allowedFunctionNames: [choice.name] };
}

function mapGeminiFinishReason(r: string): IRFinishReason {
  switch (r) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'error';
  }
}

export type { GeminiRequestBody, GeminiResponse, GeminiContent, GeminiPart };
