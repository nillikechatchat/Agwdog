/**
 * Gateway configuration types.
 *
 * Covers the schema described in `.monkeycode/specs/ai-gateway/design.md`
 * (sections "配置示例" and "SQLite Schema").
 */

export type Protocol =
  | 'OpenAI'
  | 'OpenAI-Compatible'
  | 'Anthropic'
  | 'Gemini'
  | 'Doubao'
  | 'Wenxin';

export type ClientProtocol = 'OpenAI-Chat' | 'OpenAI-Responses' | 'Anthropic-Messages' | 'Gemini-GenerateContent';

export type RoutingStrategy = 'RoundRobin' | 'WeightedRandom' | 'Failover' | 'LowestLatency';

export type BudgetMode = 'soft' | 'hard';

export interface ProviderConfig {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  inputPricePerMTokensUsd?: number;
  outputPricePerMTokensUsd?: number;
  cachedInputPricePerMTokensUsd?: number;
  /**
   * Static model declarations (used by Doubao and Wenxin which expose no
   * auto-discoverable model listing).
   */
  models?: { modelId: string; displayName?: string }[];
  extra?: Record<string, unknown>;
}

export interface VirtualModelMemberConfig {
  upstreamModelRef: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface VirtualModelConfig {
  name: string;
  strategy: RoutingStrategy;
  latencyWindow?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  maxRetries?: number;
  fallbackChain?: string[];
  members: VirtualModelMemberConfig[];
}

export interface KeyConfig {
  name: string;
  rpmLimit?: number;
  tpmLimit?: number;
  allowedModels?: string[];
  responseCacheTtlSeconds?: number;
  budgetMode?: BudgetMode;
  budgetDailyUsd?: number;
  budgetMonthlyUsd?: number;
  budgetTotalUsd?: number;
  cacheEnabled?: boolean;
  logRequests?: boolean;
  logSampleRate?: number;
}

export interface GatewayConfigFile {
  port?: number;
  adminToken?: string;
  adminEnabled?: boolean;
  dataDir?: string;
  probeIntervalMinutes?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  retryBudgetRatio?: number;
  cacheEnabled?: boolean;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  otelExporterOtlpEndpoint?: string;
  providers?: ProviderConfig[];
  virtualModels?: VirtualModelConfig[];
  keys?: KeyConfig[];
}

export interface ResolvedConfig {
  port: number;
  adminToken: string;
  adminEnabled: boolean;
  dataDir: string;
  probeIntervalMinutes: number;
  failureThreshold: number;
  recoveryThreshold: number;
  retryBudgetRatio: number;
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  otelExporterOtlpEndpoint: string | null;
  providers: ProviderConfig[];
  virtualModels: VirtualModelConfig[];
  keys: KeyConfig[];
}

export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = './data';
export const DEFAULT_PROBE_INTERVAL_MINUTES = 15;
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_RECOVERY_THRESHOLD = 2;
export const DEFAULT_RETRY_BUDGET_RATIO = 0.2;
export const DEFAULT_CACHE_TTL_SECONDS = 300;
export const DEFAULT_CACHE_MAX_ENTRIES = 1000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;