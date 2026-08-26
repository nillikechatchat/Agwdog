# ai-gateway

[![npm version](https://img.shields.io/npm/v/ai-gateway.svg)](https://www.npmjs.com/package/ai-gateway)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Local-first AI API gateway in a single npm package. Six provider APIs in, four client protocols out — with exact + semantic caching, per-key budgets, fallback chains, Prometheus metrics and OpenTelemetry tracing, a Web admin dashboard and a CLI.

```
        Provider endpoints (6 protocols)                Client endpoints (4 protocols)
  ┌─────────────────────────────┐              ┌──────────────────────────────┐
  │ OpenAI │ OpenAI-Compatible │                │ OpenAI Chat Completions    │
  │ Anthropic                    │  →  Gateway  │  OpenAI Responses          │
  │ Gemini                         │            │  Anthropic Messages        │
  │ Doubao                         │            │  Gemini GenerateContent    │
  │ Wenxin                         │            │                            │
  └─────────────────────────────┘              └──────────────────────────────┘
```

Zero external services. One Node process. `better-sqlite3` for persistence. Runs on Linux / macOS / Windows.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [gateway.config.json](#gatewayconfigjson)
  - [Environment Variables](#environment-variables)
- [Commands](#commands)
- [Routes](#routes)
  - [Client Endpoints](#client-endpoints)
  - [Admin Endpoints](#admin-endpoints)
  - [Observability](#observability)
- [Virtual Key Auth](#virtual-key-auth)
- [Budgeting](#budgeting)
- [Model Routing](#model-routing)
  - [Strategies](#strategies)
  - [Availability States](#availability-states)
  - [Probe](#probe)
  - [Fallback Chain](#fallback-chain)
- [Caching](#caching)
- [Observability](#observability-1)
  - [Prometheus Metrics](#prometheus-metrics)
  - [OpenTelemetry Tracing](#opentelemetry-tracing)
- [Web Admin](#web-admin)
- [Supported Providers](#supported-providers)
- [Supported Client Protocols](#supported-client-protocols)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [License](#license)

## Installation

```bash
# Install globally
npm install -g ai-gateway

# Or run without installing
npx ai-gateway
```

**Prerequisites**

- Node.js >= 20
- `better-sqlite3` native build tools (Node-gyp, Python 3, C++ compiler) — on Linux: `sudo apt-get install -y build-essential python3`

## Quick Start

Create a config file:

```bash
# Copy the default config
cp node_modules/ai-gateway/examples/gateway.config.json.example ./gateway.config.json

# Edit to add your providers and virtual models
vi gateway.config.json
```

Start the gateway:

```bash
npx ai-gateway

# or with a custom config path
npx ai-gateway --config /path/to/gateway.config.json

# or set environment variables (takes precedence over config file)
GATEWAY_PORT=8080 GATEWAY_ADMIN_TOKEN=secret123 npx ai-gateway
```

Then point your existing OpenAI-compatible SDK at it:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-gw-xxxxx',  // Virtual Key from admin panel
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',         // Virtual Model name
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

Access the Web admin at `http://127.0.0.1:3000/admin`.

## Configuration

### gateway.config.json

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "dataDir": "./data",
  "adminToken": "your-admin-token-here",
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "protocol": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o", "gpt-4o-mini", "o1"]
    },
    {
      "id": "anthropic",
      "name": "Anthropic",
      "protocol": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "models": ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"]
    },
    {
      "id": "gemini",
      "name": "Google Gemini",
      "protocol": "Gemini",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "apiKey": "AIzaSy...",
      "models": ["gemini-2.0-flash", "gemini-2.0-flash-thinking-exp"]
    }
  ],
  "virtualModels": [
    {
      "id": "gpt-4o",
      "name": "gpt-4o",
      "strategy": "RoundRobin",
      "members": [
        { "providerId": "openai", "providerModelId": "gpt-4o", "weight": 1, "priority": 1 }
      ]
    },
    {
      "id": "claude-sonnet",
      "name": "claude-sonnet-4-20250514",
      "strategy": "Failover",
      "fallbackChain": ["gpt-4o"],
      "members": [
        { "providerId": "anthropic", "providerModelId": "claude-sonnet-4-20250514", "weight": 1, "priority": 1 }
      ]
    }
  ]
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `3000` | HTTP listen port |
| `GATEWAY_HOST` | `127.0.0.1` | HTTP listen host |
| `GATEWAY_ADMIN_TOKEN` | — | Bearer token for `/admin/*` endpoints |
| `GATEWAY_DATA_DIR` | `./data` | SQLite database directory |
| `GATEWAY_MASTER_KEY` | auto-generated | AES-256 key for encrypting stored API keys |

## Commands

```bash
# Print version
npx ai-gateway --version

# Show help
npx ai-gateway --help

# Start server (default: reads ./gateway.config.json)
npx ai-gateway

# Start with custom config
npx ai-gateway --config=/path/to/config.json
```

## Routes

### Client Endpoints

| Method | Path | Protocol | Description |
|--------|------|----------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat | Chat completions |
| `POST` | `/v1/responses` | OpenAI Responses | Responses API |
| `POST` | `/v1/messages` | Anthropic | Messages API |
| `POST` | `/v1beta/models/:model:generateContent` | Gemini | Generate content |
| `GET` | `/v1/models` | — | List available models |

### Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/admin` | — | Web admin SPA (single HTML file) |
| `GET` | `/admin/api/stats` | Admin Token | Overall gateway stats |
| `GET` | `/admin/api/providers` | Admin Token | List providers |
| `POST` | `/admin/api/providers` | Admin Token | Create provider |
| `DELETE` | `/admin/api/providers/:id` | Admin Token | Delete provider |
| `POST` | `/admin/api/providers/sync-models` | Admin Token | Sync upstream models |
| `GET` | `/admin/api/virtual-models` | Admin Token | List virtual models |
| `POST` | `/admin/api/virtual-models` | Admin Token | Create virtual model |
| `GET` | `/admin/api/virtual-models/:id/availability` | Admin Token | Provider availability status |
| `POST` | `/admin/api/virtual-models/:id/dry-run` | Admin Token | Dry-run routing without real call |
| `GET` | `/admin/api/keys` | Admin Token | List virtual keys |
| `POST` | `/admin/api/keys` | Admin Token | Create key (returns plaintext key once) |
| `DELETE` | `/admin/api/keys/:id` | Admin Token | Revoke key |
| `GET` | `/admin/api/keys/:id/events` | Admin Token | Key budget events |
| `POST` | `/admin/api/keys/:id/budget/reset` | Admin Token | Reset budget counters |
| `GET` | `/admin/api/usage` | Admin Token | Usage aggregation |
| `GET` | `/admin/api/cache/stats` | Admin Token | Cache statistics |
| `DELETE` | `/admin/api/cache` | Admin Token | Clear all caches |
| `DELETE` | `/admin/api/logs` | Admin Token | Clear event logs |

### Observability

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/metrics` | Admin Token | Prometheus metrics (text/plain) |
| `GET` | `/v1/metrics` | — | Public Prometheus endpoint |
| `GET` | `/healthz` | — | Liveness probe |

## Virtual Key Auth

Clients authenticate via `Authorization: Bearer <key>`.

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gw-xxxxx" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}'
```

Key features:
- SHA-256 hashed storage (plaintext returned only on creation)
- Per-key RPM/TPM rate limits with 429 + Retry-After
- `allowedModels` allowlist enforcement (403 Forbidden)
- Hard/soft budget modes (see [Budgeting](#budgeting))

## Budgeting

Assign USD budgets to virtual keys with daily, monthly, or total caps:

```json
{
  "budgetDailyUsd": 5.00,
  "budgetMonthlyUsd": 100.00,
  "budgetTotalUsd": 500.00,
  "budgetMode": "hard"
}
```

- `hard`: blocks requests when budget is exhausted (HTTP 402)
- `soft`: allows requests but logs warnings
- 80% threshold triggers a warning event (logged once per cycle)

## Model Routing

Create **Virtual Models** that wrap one or more **Upstream Models** with a routing strategy:

```json
{
  "virtualModels": [
    {
      "id": "gpt-4o",
      "strategy": "RoundRobin",
      "members": [
        { "providerId": "openai", "providerModelId": "gpt-4o", "weight": 1, "priority": 1 },
        { "providerId": "azure", "providerModelId": "gpt-4o", "weight": 1, "priority": 2 }
      ],
      "fallbackChain": ["gpt-4o-mini"]
    }
  ]
}
```

### Strategies

| Strategy | Behavior |
|----------|----------|
| `RoundRobin` | Cycles through members in order |
| `WeightedRandom` | Picks randomly based on member weights |
| `Failover` | Selects highest-priority available member |
| `LowestLatency` | Selects member with lowest recent average probe latency |

### Availability States

Each Upstream Model is tracked in one of three states:

- `available` — healthy, accepting traffic
- `degraded` — slow or error-prone, still accepted but may be deprioritized
- `unavailable` — failing probes, excluded from routing

### Probe

Gateway periodically pings each Upstream Model and records latency / HTTP status / failure reason. The probe worker runs as an internal timer (no cron daemon needed).

### Fallback Chain

When all members of a Virtual Model are unavailable, the gateway tries each entry in `fallbackChain` in order. The successful fallback is noted in the `X-Gateway-Fallback-From` response header.

## Caching

Two-tier caching to reduce cost and latency:

- **Exact Cache** — SHA-256 fingerprint of model + messages + key params. Cache HIT skips upstream entirely.
- **Semantic Cache** — 64-dim embedding hash + cosine similarity (threshold 0.92). Catches near-duplicate queries when exact match fails.

Both are persisted in SQLite.

## Observability

### Prometheus Metrics

Endpoint: `GET /metrics` (or `GET /v1/metrics` for public access)

Metrics groups:

| Group | Count | Example |
|-------|-------|---------|
| Request | 4 | `gateway_request_total{protocol,model,code}` |
| Cost | 4 | `gateway_cost_usd_total{key_id,model}` |
| Routing | 3 | `gateway_routed_total{virtual_model,strategy}` |
| Cache | 4 | `gateway_cache_hits_total{layer}` |
| Auth | 3 | `gateway_auth_failures_total{reason}` |
| Retry | 2 | `gateway_upstream_retries_total{provider}` |
| Circuit Breaker | 2 | `gateway_circuit_breaker_state{provider,model}` |
| Probe | 4 | `gateway_probe_latency_seconds{model}` |
| Guardrails | 2 | `gateway_guardrail_triggered_total{rule}` |
| MCP | 2 | `gateway_mcp_call_total{method}` |
| Rate Limit | 2 | `gateway_rate_limited_total{key_id,limit_type}` |

### OpenTelemetry Tracing

Tags follow the OTel semantic conventions for `gen_ai.*` (17 attributes including model, input messages, token usage, provider, and response object).

Trace context is injected into upstream HTTP requests and proxied back as `X-Gateway-Trace-ID`.

## Web Admin

Navigate to `http://127.0.0.1:3000/admin` for a single-page dashboard (dark theme, no build step).

Tabs:
- **Overview** — uptime, request count, active virtual keys, cache hit rate, provider availability matrix
- **Providers** — list, create, delete, sync upstream models
- **Virtual Models** — create/edit routing strategy, members, fallback chain
- **Keys** — issue API keys, set budgets, view spend
- **Usage** — token spend, per-key/cost breakdowns, time-series chart
- **Settings** — admin token, data dir, port, master key rotation

## Supported Providers

| Provider | Protocol | Notes |
|----------|----------|-------|
| OpenAI | OpenAI | Official API |
| Azure OpenAI | OpenAI-Compatible | Any Azure deployment URL |
| Anthropic | Anthropic | Official API |
| Google Gemini | Gemini | Official API |
| Doubao (豆包) | OpenAI-Compatible | ByteDance Ark platform |
| Wenxin (文心一言) | OpenAI-Compatible | Baidu ERNIE Bot |
| DeepSeek | OpenAI-Compatible | https://api.deepseek.com |
| Ollama | OpenAI-Compatible | Local `http://localhost:11434/v1` |
| Groq | OpenAI-Compatible | https://api.groq.com/openai |
| xAI | OpenAI-Compatible | https://api.x.ai/v1 |

## Supported Client Protocols

| Protocol | Endpoint | Compatible With |
|----------|----------|-----------------|
| OpenAI Chat Completions | `POST /v1/chat/completions` | Claude Code, Cursor, Cline, Codex CLI, OpenAI SDK |
| OpenAI Responses | `POST /v1/responses` | Codex CLI, OpenAI Responses SDK |
| Anthropic Messages | `POST /v1/messages` | Claude Desktop, Anthropic SDK |
| Gemini GenerateContent | `POST /v1beta/models/:model:generateContent` | Gemini CLI, Google SDK |

### Tool Calling Compatibility

| Client | Client Protocol | Outbound Provider | Status |
|--------|----------------|-------------------|--------|
| Claude Code | OpenAI Chat | Anthropic / OpenAI | Supported |
| Cursor / Cline | OpenAI Chat | Anthropic / Gemini | Supported |
| Codex CLI | OpenAI Responses | OpenAI Chat (fallback) | Supported |

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Type check only
npm run typecheck

# E2E compat tests only
npm run test:e2e

# Individual files
npx vitest run test/unit/adapters/anthropic.test.ts
```

Test coverage (as of v0.1.0):
- Lines: 86%
- Branches: 77%
- Statements: 88%

## Roadmap

### v0.2.0 (Phase 12+)
- [ ] Semantic cache provider abstraction (replace built-in hash)
- [ ] Prompt template manager
- [ ] Advanced guardrails (prompt injection detection, PII scrubbing)
- [ ] MCP tool execution via provider
- [ ] A/B experiment routing

### v0.3.0 (Future)
- [ ] Cluster mode (Raft consensus)
- [ ] Multi-region failover
- [ ] Provider pricing editor UI

## License

MIT
