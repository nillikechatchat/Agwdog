# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-26

### Added

- **Core Gateway Server**
  - HTTP server based on Node.js `http` module with custom lightweight router
  - `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `POST /v1beta/models/:model:generateContent` client endpoints
  - `GET /v1/models` and `GET /v1beta/models` model listing
  - Streaming response forwarding (SSE) for all supported protocols
  - `startServer({ dispatch, db, port, host, admin, onListen, onStopped })` lifecycle API returning `ready: Promise<void>`

- **Six Provider Adapters** (Provider → Internal Representation)
  - `OpenAIAdapter` — official OpenAI Chat Completions
  - `OpenAICompatibleAdapter` — OpenAI-compatible proxies (Azure, DeepSeek, Groq, xAI, Ollama, etc.)
  - `AnthropicAdapter` — Anthropic Messages API
  - `GeminiAdapter` — Google Gemini GenerateContent API
  - `DoubaoAdapter` — ByteDance Ark platform
  - `WenxinAdapter` — Baidu ERNIE Bot

- **Four Client Serializers** (Internal Representation → Client Protocol)
  - `OpenAIChatSerializer` — OpenAI Chat Completions response format
  - `OpenAIResponsesSerializer` — OpenAI Responses API format (including `previous_response_id` continuation)
  - `AnthropicMessagesSerializer` — Anthropic Messages response format
  - `GeminiGenerateContentSerializer` — Gemini GenerateContent response format

- **IR (Intermediate Representation)**
  - Unified schema for messages, tools, tool_calls, usage, thinking, reasoning_effort, source_id, cache_control, continuation, provider_executed, stream, metadata
  - Canonical JSON serialization for consistent fingerprinting
  - SHA-256 fingerprint generation from model + messages + key parameters
  - Token estimation (character-count with mode-based tuning)

- **Virtual Model Routing**
  - Four strategies: `RoundRobin`, `WeightedRandom`, `Failover`, `LowestLatency`
  - `fallbackChain` configuration with `X-Gateway-Fallback-From` response header
  - `POST /admin/api/virtual-models/:id/dry-run` endpoint
  - Availability-aware selection (skips `unavailable` members)

- **Auth & Budget**
  - Bearer token authentication via `Authorization: Bearer <key>` header
  - SHA-256 hashed virtual key storage (plaintext returned only on creation)
  - AES-256-GCM API key encryption at rest
  - Per-key RPM / TPM rate limiting with `429 Too Many Requests` + `Retry-After`
  - `allowedModels` allowlist enforcement (returns `403 Forbidden`)
  - Daily / monthly / total USD budget tracking
  - 80% warning threshold events (`budget_warning`)
  - Hard mode (blocks with `402 Payment Required`) vs soft mode (allows with warnings)
  - `POST /admin/api/keys/:id/budget/reset` endpoint

- **Exact Response Cache**
  - SHA-256 fingerprint as cache key
  - Per-request TTL with `TTL_HIT` / `FRESH_HIT` distinction
  - Cache bypass via `X-Gateway-Cache: bypass` header
  - Automatic invalidation on virtual model / provider edits
  - `GET /admin/api/cache/stats` and `DELETE /admin/api/cache` endpoints

- **Semantic Cache**
  - 64-dimensional hash embedding (deterministic, no external service)
  - Cosine similarity threshold (default 0.92, configurable)
  - Cached response with fingerprint similarity metadata

- **Response Continuation Cache**
  - Tracks last N responses per message fingerprint prefix
  - For non-streaming replies with matching recent prefixes, appends cached trailing content
  - `continueWindow` size default 3, max 10

- **Prompt Cache Tracker**
  - Marks system messages with `cache_control: { type: 'ephemeral' }` where applicable
  - Anthropic prompt caching integration (writes `cache_control` to IR)

- **Prompt Templates**
  - Versioned templates with Mustache-style `{{variable}}` interpolation
  - JSON-value support for array/object placeholders
  - `TemplateRenderer.render(templateKey, context)` and `getVersion(templateKey, version)`
  - `POST /admin/api/prompts`, `GET /admin/api/prompts/:id`, `PUT /admin/api/prompts/:id`, `DELETE /admin/api/prompts/:id`

- **Guardrails**
  - PII detection (`email`, `phone`, `credit_card`, `ssn`)
  - Injection rule (`INJECT`, `leak_sys_prompt`, `ignore_instructions`, prompt prefix)
  - Token budget guard (`MAX_TOKENS`)
  - `Guardrails.guard({ prompt, system })` returning `{ clean: boolean, violations: GuardrailViolation[] }`
  - `GET /admin/api/guard/rules`, `GET /admin/api/guard/check` endpoints

- **MCP (Model Context Protocol) Client**
  - stdio transport with JSON-RPC 2.0 (no external dependencies)
  - `MCPClient.start(mcpConfig)` / `.stop()` / `.listTools()` / `.callTool(name, args)`
  - `MCPManager` registry for multiple MCP servers
  - `GET /admin/api/mcp/tools`, `POST /admin/api/mcp/call` endpoints

- **Observability**
  - `Registry` with `Counter`, `Gauge`, `Histogram` (custom, no dependencies)
  - Histogram default buckets: 0.005 / 0.01 / 0.025 / 0.05 / 0.1 / 0.25 / 0.5 / 1 / 2.5 / 5 / 10 seconds
  - Prometheus text exposition at `GET /metrics` and `GET /v1/metrics`
  - 11 metric families (request, cost, routed, cache, auth, upstream_retries, circuit_breaker, probe, guardrail, mcp, rate_limited)
  - OpenTelemetry-compatible tracer with `gen_ai.*` semantic conventions
  - 17 standard attributes (system, model, request.max_tokens, message, usage.*, response.stop_reason, etc.)
  - Trace ID propagated via `X-Gateway-Trace-ID` header

- **HTTP Provider Connector**
  - `HttpProviderConnector.request(options)` with JSON body and SSE streaming
  - Retry with exponential backoff + jitter (status codes 408, 425, 429, 5xx)
  - `Retry-After` header respect on 429
  - Up to 4 retries, base delay 1s, max delay 30s, jitter ±25%
  - Circuit breaker (closed / open / half-open states)
  - Per-provider `VendorRateLimiter` (token bucket, supports both global and per-model limits)
  - SSE frame parser with timeout

- **Web Admin Dashboard**
  - Single-file HTML SPA at `http://127.0.0.1:3000/admin` (no build step)
  - Dark theme, responsive layout, vanilla ES2022 JavaScript
  - Six tabs: Overview, Providers, Virtual Models, Keys, Usage, Settings
  - Real-time stats (uptime, request count, active keys, cache hit rate)
  - Provider availability matrix visualization
  - Key budget dashboard with progress bars
  - Usage time-series chart (Canvas 2D, no library)
  - Provider sync and virtual model dry-run integration
  - Admin token authentication (Bearer in header, stored in `sessionStorage`)

- **CLI Entry Point**
  - `npx ai-gateway --version` prints `0.1.0`
  - `npx ai-gateway --help` prints usage and config schema
  - `npx ai-gateway --config=<path>` loads config from alternate path
  - `src/cli/index.ts` — thin entry point wiring server, database, and admin

- **Admin REST API**
  - 9 endpoint groups: stats, providers, virtual-models, keys, usage, cache, logs, guard, mcp
  - All endpoints use Admin Token Bearer authentication (except `/admin` HTML entry)
  - `GET /admin/api/stats` — aggregate counters (requests, cost, keys, tokens, etc.)
  - Provider CRUD + `POST /admin/api/providers/sync-models`
  - Virtual model CRUD + `GET /admin/api/virtual-models/:id/availability`
  - Key CRUD (create returns plaintext key once) + budget management
  - Usage aggregation by key / model / date range
  - Cache stats + clear endpoint

- **Database Schema** (16 tables, 14 indexes)
  - `upstream_models`, `providers`, `virtual_models`, `virtual_key`, `events`, `usage`, `api_keys`, `api_key_budget`, `key_budget_period`, `exact_cache`, `semantic_cache`, `cache_fingerprints`, `cache_hit_log`, `response_continuation_cache`, `prompt_templates`, `guard_rules`, `guard_violations`, `mcp_sessions`, `mcp_tool_calls`

- **Tests**
  - 465 passing unit + integration + e2e tests across 50 test files
  - Coverage: 86% lines / 77% branches / 88% statements
  - `test/e2e/compat.test.ts` — 9 end-to-end round-trip tests for Claude Code, Cursor/Cline, Codex CLI compatibility
  - Protocol conversion matrix coverage (6 providers × 4 clients)
  - Router strategy tests (RoundRobin, WeightedRandom, Failover, LowestLatency)
  - Auth pipeline tests (missing key, revoked key, wrong hash, rate limit, budget exceeded)
  - Cache pipeline tests (exact miss/hit, semantic miss/hit, prompt marking, continuation)
  - Guardrails tests (PII detection, injection blocking, token budget)
  - MCP client tests (stdio JSON-RPC 2.0 session, tool listing, tool calling)
  - Admin API tests (stats, providers CRUD, virtual models, keys CRUD, usage aggregation)

### Changed

- Migrated from placeholder README to comprehensive documentation
- Restructured storage layer to use explicit `index.ts` exports instead of circular imports
- Renamed IR fields for clarity: `finish_reason` → `finishReason`, `provider_executed` → `providerExecuted`
- `ProviderAdapter` constructor now accepts protocol string instead of inferring from class name
- Split `guardrails/index.ts` to resolve circular import (moved guard type + functions to `guard.ts`)
- Added `exactOptionalPropertyTypes: true` compliance across codebase (conditional property spread)

### Removed

- Placeholder `README.md` content (Agwdog watchdog text)
- Unused `.gitkeep` files (cleaned up empty directories in src/test, test/{unit,integration,e2e} structure)

[Unreleased]: ### Added ### Changed ### Removed
