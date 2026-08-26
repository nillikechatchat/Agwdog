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