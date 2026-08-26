/**
 * Row types — one interface per SQLite table, matching `schema.sql` exactly.
 *
 * All fields use snake_case to match SQL column names; ORM code is responsible
 * for translating to/from camelCase if a different surface is desired.
 *
 * Timestamps are stored as Unix milliseconds (INTEGER).
 */

export type Availability = 'available' | 'degraded' | 'unavailable';
export type Protocol = 'OpenAI' | 'OpenAI-Compatible' | 'Anthropic' | 'Gemini' | 'Doubao' | 'Wenxin';
export type RoutingStrategy = 'RoundRobin' | 'WeightedRandom' | 'Failover' | 'LowestLatency';
export type KeyStatus = 'active' | 'revoked';
export type BudgetMode = 'soft' | 'hard';
export type UsageSource = 'reported' | 'estimated';
export type CacheHit = 'none' | 'exact' | 'semantic';
export type ClientProtocol = 'OpenAI-Chat' | 'OpenAI-Responses' | 'Anthropic-Messages' | 'Gemini-GenerateContent';
export type BudgetPeriod = 'day' | 'month' | 'total';
export type EventType =
  | 'budget_warning'
  | 'budget_exceeded'
  | 'budget_reset'
  | 'upstream_degraded'
  | 'upstream_recovered'
  | 'config_changed';

export interface ProviderRow {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_tag: string;
  enabled: number;
  input_price_per_mtokens_usd: number | null;
  output_price_per_mtokens_usd: number | null;
  cached_input_price_per_mtokens_usd: number | null;
  extra_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  supports_stream: number;
  supports_tools: number;
  supports_vision: number;
  enabled: number;
  availability: Availability;
  consecutive_failures: number;
  consecutive_successes: number;
  last_probe_at: number | null;
  unavailable_since: number | null;
  latency_ms_p50: number | null;
  latency_ms_p95: number | null;
  created_at: number;
}

export interface VirtualModelRow {
  id: string;
  name: string;
  strategy: RoutingStrategy;
  latency_window: number | null;
  failure_threshold: number | null;
  recovery_threshold: number | null;
  max_retries: number;
  fallback_chain_json: string | null;
  created_at: number;
}

export interface VirtualModelMemberRow {
  virtual_model_id: string;
  upstream_model_id: string;
  weight: number;
  priority: number;
  enabled: number;
  joined_at: number;
}

export interface KeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  status: KeyStatus;
  rpm_limit: number | null;
  tpm_limit: number | null;
  allowed_models_json: string | null;
  response_cache_ttl_seconds: number;
  budget_mode: BudgetMode;
  budget_daily_usd: number | null;
  budget_monthly_usd: number | null;
  budget_total_usd: number | null;
  cache_enabled: number;
  log_requests: number;
  log_sample_rate: number;
  created_at: number;
  revoked_at: number | null;
}

export interface BudgetCounterRow {
  key_id: string;
  period_type: BudgetPeriod;
  period_key: string;
  spent_usd: number;
  warned_at_80: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  key_id: string | null;
  type: EventType;
  payload_json: string;
  created_at: number;
}

export interface RequestLogRow {
  id: number;
  request_id: string;
  key_id: string | null;
  client_protocol: ClientProtocol;
  virtual_model_id: string | null;
  upstream_provider_id: string | null;
  upstream_model_id: string | null;
  request_body_redacted: string;
  response_body_redacted: string | null;
  routing_decision_json: string | null;
  timing_json: string | null;
  created_at: number;
}

export interface CacheEntryRow {
  fingerprint: string;
  key_id: string | null;
  client_protocol: ClientProtocol;
  model: string;
  response_json: string;
  hit_count: number;
  last_hit_at: number | null;
  expires_at: number;
  created_at: number;
}

export interface ProbeResultRow {
  id: number;
  upstream_model_id: string;
  latency_ms: number | null;
  status_code: number | null;
  success: number;
  error_message: string | null;
  probed_at: number;
}

export interface UsageRecordRow {
  id: number;
  request_id: string;
  key_id: string | null;
  virtual_model_id: string | null;
  upstream_provider_id: string | null;
  upstream_model_id: string | null;
  client_protocol: ClientProtocol;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  source: UsageSource;
  cache_hit: CacheHit;
  ttft_ms: number | null;
  tokens_per_second: number | null;
  latency_ms: number;
  status_code: number;
  error_code: string | null;
  created_at: number;
}

export interface ResponseCacheRow {
  id: string;
  key_id: string | null;
  client_protocol: ClientProtocol;
  virtual_model_id: string | null;
  upstream_provider_id: string | null;
  upstream_model_id: string | null;
  request_json: string;
  response_json: string;
  ttl_seconds: number;
  created_at: number;
  expires_at: number;
}