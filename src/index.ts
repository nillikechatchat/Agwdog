/**
 * ai-gateway — local-first AI API gateway.
 *
 * 6 provider APIs in, 4 client protocols out.
 * Multi-provider load balancing, fallback chains, exact cache,
 * budgets, Prometheus metrics, OpenTelemetry, and a web admin SPA.
 */

export const VERSION = '0.1.0';

export type { GatewayConfigFile as GatewayConfig } from './config/types.js';
export { loadConfig, ConfigError } from './config/loader.js';
export type {
  GatewayConfigFile,
  ResolvedConfig,
  Protocol,
  ProviderConfig,
  VirtualModelConfig,
  KeyConfig,
  RoutingStrategy,
  BudgetMode,
} from './config/types.js';

export { encrypt, decrypt, loadMasterKey, roundTrip, CryptoError } from './crypto/aes.js';
export { createLogger, log, redact } from './utils/logger.js';
export type { Logger, LogLevel } from './utils/logger.js';

export type {
  IRRequest,
  IRResponse,
  IRMessage,
  IRContent,
  IRTextContent,
  IRImageContent,
  IRAudioContent,
  IRToolUse,
  IRToolResult,
  IRThinking,
  IRTool,
  IRToolParameter,
  IRToolChoice,
  IRReasoning,
  IRResponseFormat,
  IRContinuation,
  IRUsage,
  IRFinishReason,
  IRChoice,
  IRStreamEvent,
  IROutputItem,
  IRTextOutputItem,
  IRFunctionCallItem,
  IRFunctionCallOutputItem,
  IRReasoningItem,
  IRWebSearchItem,
  IRRole,
  ImageDetail,
} from './ir/types.js';
export {
  canonicalJSON,
  emptyIRRequest,
  estimateTokens,
  fingerprint,
  normalizeMessage,
  normalizeMessages,
  textMsg,
  toolResultMsg,
  type FingerprintInput,
} from './ir/normalize.js';

export {
  startServer,
  startSseResponse,
  BodyTooLargeError,
  InvalidJsonError,
  type DispatchFn,
  type DispatchInput,
  type GatewayContext,
  type ServerOptions,
} from './server/http.js';
export {
  match,
  resolveRoute,
  ROUTE_TABLE,
  type HttpMethod,
  type Route,
  type RouteMatch,
} from './server/router.js';
export {
  createInflightTracker,
  installShutdown,
  type InflightTracker,
  type ShutdownHandle,
  type LifecycleOptions,
} from './server/lifecycle.js';

export {
  generateVirtualKey,
  hashKey,
  extractBearerToken,
  authenticate,
  parseAllowedModels,
  isModelAllowed,
  type AuthSuccess,
  type AuthFailure,
} from './auth/keys.js';
export {
  RateLimiter,
  type RateLimitConfig,
  type RateLimitDecision,
} from './auth/rate-limit.js';
export {
  BudgetTracker,
  dayKey,
  monthKey,
  type PeriodState,
  type BudgetSnapshot,
  type BudgetCheckResult,
} from './budget/tracker.js';
export {
  authenticateRequest,
  type AuthContext,
  type AuthRejection,
  type AuthRequestInput,
  type AuthRequestDeps,
} from './auth/pipeline.js';

export { CacheRepo } from './storage/repos/cache.js';
export type { NewCacheEntryInput, CacheLookupResult as CacheRepoLookupResult } from './storage/repos/cache.js';
export { writeCacheHit } from './cache/serialize.js';

export {
  route,
  tryOne,
  RoutingError,
  type RoutingDecision,
  type RouteRequestInput,
  type RouterDeps,
} from './router/strategies.js';
export { dryRunRoute, type DryRunResult } from './router/dry-run.js';

export {
  createAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  AnthropicAdapter,
  GeminiAdapter,
  DoubaoAdapter,
  WenxinAdapter,
  AdapterError,
  type AdapterFactoryOptions,
  type OpenAICompatibleOptions,
  type ProviderAdapter,
  type ProviderRequestEnvelope,
} from './adapters/index.js';

export {
  createClientSerializer,
  OpenAIChatSerializer,
  OpenAIResponsesSerializer,
  AnthropicMessagesSerializer,
  GeminiSerializer,
  SerializerError,
  type ClientSerializer,
  type ClientProtocol,
  type ClientSseEvent,
  type StreamState,
  type ResponseMeta,
  type ExpectedRequestShape,
} from './clients/index.js';

export {
  HttpProviderConnector,
  CircuitBreaker,
  TokenBucket,
  VendorRateLimiter,
  SSEDecoder,
  CircuitOpenError,
  UpstreamHttpError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VENDOR_BUCKET,
  DEFAULT_CIRCUIT_CONFIG,
  DEFAULT_RETRY_CONFIG,
  isRetryableStatus,
  computeBackoff,
  parseRetryAfter,
  sleep,
  type ProviderConnector,
  type CallOutcome,
  type ConnectorCallOptions,
  type StreamChunk,
  type CircuitState,
  type CircuitBreakerConfig,
  type TokenBucketConfig,
  type RetryConfig,
  type HttpConnectorDeps,
  type SSEEvent,
} from './connector/index.js';

export {
  SemanticCache,
  PromptCacheTracker,
  ResponseContinuationCache,
  CacheOrchestrator,
  setEmbeddingProvider,
  getEmbeddingProvider,
  embed,
  cosineSimilarity,
  normalize,
  serializeEmbedding,
  deserializeEmbedding,
  DEFAULT_SEMANTIC_OPTIONS,
  DEFAULT_CACHE_CONFIG,
  cacheKeyFor,
  type CacheConfig,
  type CacheLookupResult,
  type CacheOrchestratorDeps,
  type OrchestratorLookupInput,
  type CachePolicy,
  type CacheWriteInput,
  type CacheLookupInput as CacheLookupInputExact,
  type CacheHit,
  type CacheMiss,
  type CacheLookupOutcome,
  type SemanticCacheOptions,
  type ResponseCacheEntry,
  type EmbeddingProvider,
  type PromptCacheMarker,
} from './cache/index.js';

export {
  PromptTemplateRepo,
  TemplateRenderer,
  TemplateError,
  extractVariables,
  type PromptTemplate,
  type PromptVariableSpec,
  type RenderContext,
} from './prompts/index.js';

export {
  Guardrails,
  GuardrailViolation,
  DEFAULT_GUARDRAILS,
  type GuardrailConfig,
  type GuardrailDecision,
} from './guardrails/index.js';

export {
  MCPClient,
  MCPManager,
  MCPError,
  mcpToolId,
  newRequestId,
  type MCPServerSpec,
  type MCPTool,
  type MCPResource,
  type MCPCallResult,
} from './mcp/index.js';

export {
  Registry,
  Counter,
  Gauge,
  Histogram,
  DEFAULT_BUCKETS,
  Tracer,
  GEN_AI_ATTRIBUTES,
  DEFAULT_TRACER_CONFIG,
  registerGatewayMetrics,
  renderPrometheus,
  instrumentRequest,
  writePrometheusResponse,
  makeMetricsHandler,
  type HistogramOptions,
  type LabelValues,
  type MetricMeta,
  type MetricFamily,
  type Sample,
  type Span,
  type SpanStatus,
  type TracerConfig,
  type GatewayMetrics,
  type MetricsMiddlewareOptions,
} from './observability/index.js';
