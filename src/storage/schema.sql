-- ai-gateway SQLite schema (v1)
-- One canonical schema; the migration system applies it as the initial version.
-- All identifiers follow snake_case per SQLite convention.

-- 1. providers — upstream provider definitions
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('OpenAI','OpenAI-Compatible','Anthropic','Gemini','Doubao','Wenxin')),
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_tag TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  input_price_per_mtokens_usd REAL,
  output_price_per_mtokens_usd REAL,
  cached_input_price_per_mtokens_usd REAL,
  extra_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. provider_models — concrete (provider, model) pairs
CREATE TABLE provider_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER,
  supports_stream INTEGER NOT NULL DEFAULT 1,
  supports_tools INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available','degraded','unavailable')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_probe_at INTEGER,
  unavailable_since INTEGER,
  latency_ms_p50 INTEGER,
  latency_ms_p95 INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, model_id)
);
CREATE INDEX idx_provider_models_provider ON provider_models(provider_id);

-- 3. virtual_models — logical model names exposed to clients
CREATE TABLE virtual_models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL CHECK (strategy IN ('RoundRobin','WeightedRandom','Failover','LowestLatency')),
  latency_window INTEGER DEFAULT 5,
  failure_threshold INTEGER DEFAULT 3,
  recovery_threshold INTEGER DEFAULT 2,
  max_retries INTEGER NOT NULL DEFAULT 2,
  fallback_chain_json TEXT,
  created_at INTEGER NOT NULL
);

-- 4. virtual_model_members — many-to-many VirtualModel ⨯ ProviderModel
CREATE TABLE virtual_model_members (
  virtual_model_id TEXT NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
  upstream_model_id TEXT NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (virtual_model_id, upstream_model_id)
);
CREATE INDEX idx_vmm_upstream ON virtual_model_members(upstream_model_id);

-- 5. keys — Virtual Key issued by the gateway
CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')) DEFAULT 'active',
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  allowed_models_json TEXT,
  response_cache_ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  budget_mode TEXT NOT NULL DEFAULT 'soft' CHECK (budget_mode IN ('soft','hard')),
  budget_daily_usd REAL,
  budget_monthly_usd REAL,
  budget_total_usd REAL,
  cache_enabled INTEGER NOT NULL DEFAULT 1,
  log_requests INTEGER NOT NULL DEFAULT 0,
  log_sample_rate REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_keys_status ON keys(status);

-- 6. budget_counters — accumulated spend per Key per period
CREATE TABLE budget_counters (
  key_id TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL CHECK (period_type IN ('day','month','total')),
  period_key TEXT NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  warned_at_80 INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, period_type, period_key)
);

-- 7. events — append-only event log for budget alerts, degradation, config changes
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('budget_warning','budget_exceeded','budget_reset','upstream_degraded','upstream_recovered','config_changed')),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_key_created ON events(key_id, created_at DESC);
CREATE INDEX idx_events_type_created ON events(type, created_at DESC);

-- 8. request_logs — full audit trail of request/response bodies (Key-level opt-in)
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  key_id TEXT,
  client_protocol TEXT NOT NULL,
  virtual_model_id TEXT,
  upstream_provider_id TEXT,
  upstream_model_id TEXT,
  request_body_redacted TEXT NOT NULL,
  response_body_redacted TEXT,
  routing_decision_json TEXT,
  timing_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_request_logs_request_id ON request_logs(request_id);
CREATE INDEX idx_request_logs_created ON request_logs(created_at DESC);

-- 9. cache_entries — Exact Cache entries (fingerprint → response)
CREATE TABLE cache_entries (
  fingerprint TEXT PRIMARY KEY,
  key_id TEXT,
  client_protocol TEXT NOT NULL,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cache_entries_expires ON cache_entries(expires_at);

-- 10. probe_results — history of availability probes
CREATE TABLE probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_model_id TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  success INTEGER NOT NULL,
  error_message TEXT,
  probed_at INTEGER NOT NULL
);
CREATE INDEX idx_probe_results_model_time ON probe_results(upstream_model_id, probed_at DESC);

-- 11. usage_records — per-request usage telemetry
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  key_id TEXT,
  virtual_model_id TEXT,
  upstream_provider_id TEXT,
  upstream_model_id TEXT,
  client_protocol TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('reported','estimated')),
  cache_hit TEXT NOT NULL DEFAULT 'none' CHECK (cache_hit IN ('none','exact','semantic')),
  ttft_ms INTEGER,
  tokens_per_second REAL,
  latency_ms INTEGER NOT NULL,
  status_code INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_created_at ON usage_records(created_at DESC);
CREATE INDEX idx_usage_key_created ON usage_records(key_id, created_at DESC);
CREATE INDEX idx_usage_upstream_created ON usage_records(upstream_model_id, created_at DESC);

-- 12. response_cache — Responses API continuation cache (previous_response_id)
CREATE TABLE response_cache (
  id TEXT PRIMARY KEY,
  key_id TEXT REFERENCES keys(id) ON DELETE CASCADE,
  client_protocol TEXT NOT NULL CHECK (client_protocol IN ('OpenAI-Chat','OpenAI-Responses','Anthropic-Messages','Gemini-GenerateContent')),
  virtual_model_id TEXT,
  upstream_provider_id TEXT,
  upstream_model_id TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_response_cache_expires ON response_cache(expires_at);
CREATE INDEX idx_response_cache_key_created ON response_cache(key_id, created_at DESC);

-- 13. schema_version — current migration version (single row)
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);