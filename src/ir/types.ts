/**
 * Internal protocol-neutral representation (IR) used by ai-gateway.
 *
 * Every client request is decoded by a `Client Adapter` into an {@link IRRequest},
 * routed to an upstream via the Router, encoded by a `Provider Adapter` into
 * a provider-native body, and finally re-serialized into the client's preferred
 * protocol by a `Client Serializer`. Splitting the conversion into two stages
 * lets us support `N providers × M client protocols` with N+M pieces instead of
 * N*M direct transforms.
 *
 * The IR deliberately mirrors the union of OpenAI Chat Completions,
 * Anthropic Messages, OpenAI Responses, and Google Gemini GenerateContent so
 * that any field used by any of them has a corresponding node here.
 */

export type IRRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type ImageDetail = 'auto' | 'low' | 'high';

export interface IRTextContent {
  type: 'text';
  text: string;
}

export interface IRImageContent {
  type: 'image';
  source: { kind: 'url' | 'base64'; url?: string; mediaType?: string; data?: string };
  detail?: ImageDetail;
}

export interface IRAudioContent {
  type: 'audio';
  source: { kind: 'url' | 'base64'; url?: string; mediaType?: string; data?: string };
}

export interface IRToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  arguments: unknown;
}

export interface IRToolResult {
  type: 'tool_result';
  toolCallId: string;
  content: string | IRTextContent[] | IRImageContent[];
  isError?: boolean;
}

export interface IRThinking {
  type: 'thinking';
  text: string;
  /** Provider-specific signature (Anthropic signature, OpenAI reasoning encrypted_content). */
  signature?: string;
}

export type IRContent = IRTextContent | IRImageContent | IRAudioContent | IRToolUse | IRToolResult | IRThinking;

export interface IRMessage {
  role: IRRole;
  content: IRContent[];
  name?: string;
  /** When set, signals the message is a partial follow-up of a prior assistant turn. */
  partial?: boolean;
}

export interface IRToolParameter {
  type: 'string' | 'number' | 'boolean' | 'integer' | 'object' | 'array';
  description?: string;
  enum?: (string | number)[];
  properties?: Record<string, IRToolParameter>;
  items?: IRToolParameter;
  required?: string[];
}

export interface IRTool {
  name: string;
  description?: string;
  parameters: IRToolParameter;
  /** Set when this tool is implemented server-side by the provider (Responses-only today). */
  providerExecuted?: boolean;
  /** Marker for Responses-API builtin tools. */
  builtinKind?: 'web_search' | 'code_interpreter' | 'file_search';
  /** Provider-specific opaque configuration (e.g. search recency filter). */
  config?: Record<string, unknown>;
}

export type IRToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface IRReasoning {
  effort?: 'low' | 'medium' | 'high';
  /** OpenAI Responses-only: 'auto' | 'concise' | 'detailed'. */
  summary?: 'auto' | 'concise' | 'detailed';
  /** Anthropic/OpenAI opaque blobs for round-tripping reasoning. */
  encryptedContent?: string;
  /** Budget in tokens for the thinking block (mapped to Anthropic budget_tokens). */
  budgetTokens?: number;
}

export interface IRResponseFormat {
  /** 'text' means "no constraint"; 'json_object' is OpenAI's legacy mode; 'json_schema' is structured outputs. */
  kind: 'text' | 'json_object' | 'json_schema';
  jsonSchema?: Record<string, unknown>;
  /** When true, the provider must enforce the schema strictly. */
  strict?: boolean;
}

export interface IRContinuation {
  /** Provider Responses ID we want to thread onto. */
  previousResponseId?: string;
  /** Anthropic conversation continuity (optional future use). */
  conversationId?: string;
  /** Token-count hints passed verbatim by adapters. */
  systemFingerprint?: string;
}

export interface IRStopSequences {
  stop?: string[];
  /** Provider-specific stop tokens (e.g. Anthropic stop_sequences). */
  providerStops?: string[];
}

export interface IRExtra {
  /** Anything that does not fit the canonical schema. Adapters pass it through when supported. */
  [k: string]: unknown;
}

export interface IRRequest {
  model: string;
  messages: IRMessage[];
  tools?: IRTool[];
  toolChoice?: IRToolChoice;
  reasoning?: IRReasoning;
  continuation?: IRContinuation;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: IRStopSequences;
  responseFormat?: IRResponseFormat;
  stream: boolean;
  metadata?: Record<string, unknown>;
  extra?: IRExtra;
}

export interface IRUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export type IRFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface IRTextOutputItem {
  type: 'message';
  id: string;
  role: 'assistant';
  content: IRTextContent[];
  stopReason?: IRFinishReason;
}

export interface IRFunctionCallItem {
  type: 'function_call';
  id: string;
  callId: string;
  name: string;
  arguments: unknown;
}

export interface IRFunctionCallOutputItem {
  type: 'function_call_output';
  id: string;
  callId: string;
  output: string;
}

export interface IRReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  encryptedContent?: string;
}

export interface IRWebSearchItem {
  type: 'web_search_call';
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  query?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
}

export type IROutputItem =
  | IRTextOutputItem
  | IRFunctionCallItem
  | IRFunctionCallOutputItem
  | IRReasoningItem
  | IRWebSearchItem;

export interface IRChoice {
  index: number;
  message: IRMessage;
  finishReason: IRFinishReason;
}

export interface IRResponse {
  id: string;
  model: string;
  choices: IRChoice[];
  usage: IRUsage;
  finishReason: IRFinishReason;
  reasoning?: IRReasoning;
  outputItems?: IROutputItem[];
  metadata?: Record<string, unknown>;
}

/** Single chunk of an SSE stream from a provider. */
export interface IRStreamEvent {
  /** Incremental text delta on the assistant message. */
  textDelta?: string;
  /** Incremental tool argument delta. */
  toolUseDelta?: { id: string; name?: string; argumentsDelta?: string };
  /** Reasoning/thinking delta. */
  thinkingDelta?: { text?: string; signature?: string };
  /** Final output-item event (Responses-API semantics). */
  outputItemDelta?: { delta: Partial<IROutputItem>; item?: IROutputItem };
  /** Usage update — providers send this either mid-stream or at completion. */
  usageDelta?: Partial<IRUsage>;
  /** Terminal finish reason. */
  finishReason?: IRFinishReason;
  /** Optional provider message id for the response. */
  responseId?: string;
}

export function isText(c: IRContent): c is IRTextContent {
  return c.type === 'text';
}

export function isToolUse(c: IRContent): c is IRToolUse {
  return c.type === 'tool_use';
}

export function isToolResult(c: IRContent): c is IRToolResult {
  return c.type === 'tool_result';
}

export function isThinking(c: IRContent): c is IRThinking {
  return c.type === 'thinking';
}