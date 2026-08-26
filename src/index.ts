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
export type { NewCacheEntryInput, CacheLookupResult } from './storage/repos/cache.js';
export {
  ExactCache,
  type CachePolicy,
  type CacheWriteInput,
  type CacheLookupInput,
  type CacheHit,
  type CacheMiss,
  type CacheLookupOutcome,
} from './cache/exact.js';
export { writeCacheHit } from './cache/serialize.js';
