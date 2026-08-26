# ai-gateway Architecture

## Overview

ai-gateway is a local-first AI API gateway that normalizes 6 provider protocols into a unified internal representation (IR), then serializes to 4 client protocols. All state is persisted in SQLite — no external services required.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           REQUEST FLOW (Inbound)                           │
│                                                                             │
│  Client Request                                                             │
│       │                                                                     │
│       ▼                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                 │
│  │   Auth       │───►│  Budget      │───►│  Cache       │                 │
│  │  (Bearer)    │    │ (RPM/TPM/    │    │  (Exact/     │                 │
│  │              │    │  USD)        │    │   Semantic)  │                 │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                 │
│                                                 │                           │
│                                                 ▼                           │
│                                          ┌──────────────┐                 │
│                                          │   Router     │                 │
│                                          │ (4 strategies│                 │
│                                          │  + fallback) │                 │
│                                          └──────┬───────┘                 │
│                                                 │                           │
│                                                 ▼                           │
│                                          ┌──────────────┐                 │
│                                          │  Guardrails  │                 │
│                                          │ (PII/Inject) │                 │
│                                          └──────┬───────┘                 │
│                                                 │                           │
│                                                 ▼                           │
│                                          ┌──────────────┐                 │
│                                          │ Provider     │                 │
│                                          │ Adapter      │                 │
│                                          │ (→ IR)       │                 │
│                                          └──────┬───────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                              ┌─────────────────┐
                              │   Internal IR   │
                              │ (canonical JSON)│
                              └────────┬────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RESPONSE FLOW (Outbound)                            │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                 │
│  │  IR → Client │───►│  Cache       │───►│  Stream/     │                 │
│  │ Serializer   │    │  Store       │    │  Buffer      │                 │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                 │
│                                                 │                           │
│                                                 ▼                           │
│                                          ┌──────────────┐                 │
│                                          │  Metrics &   │                 │
│                                          │  Tracing     │                 │
│                                          └──────────────┘                 │
│                                                 │                           │
│                                                 ▼                           │
│                                          Client Response                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. HTTP Server (`src/server/http.ts`)

- Node.js native `http` module (no Express/Fastify)
- Custom lightweight router with middleware pipeline
- SSE streaming support for all protocols
- `startServer()` returns `{ ready: Promise<void>, stop(): void }`

### 2. Auth Pipeline (`src/auth/`)

```
Request → extractBearerToken() → hashKey(inputKey) → findKey() → checkStatus()
                                              → checkRateLimit() → checkBudget()
                                              → checkAllowedModels()
```

- SHA-256 hashed key storage
- AES-256-GCM encrypted API keys at rest
- Per-key RPM (requests per minute) and TPM (tokens per minute) limits
- Hard mode (402) vs soft mode (warn) budget enforcement

### 3. Router (`src/router/`)

Four strategies for virtual model → upstream model selection:

| Strategy | Selection Logic |
|----------|----------------|
| `RoundRobin` | Cycle through enabled members by counter |
| `WeightedRandom` | Random pick weighted by member weight |
| `Failover` | First available by priority order |
| `LowestLatency` | Member with lowest recent probe average |

Fallback chain: when all members unavailable, try entries in `fallbackChain` array. Response includes `X-Gateway-Fallback-From` header.

### 4. Cache Layer (`src/cache/`)

Four-layer cascade:

```
Lookup:
  1. Exact Cache → fingerprint match? Return cached response
  2. Semantic Cache → cosine similarity > threshold? Return with metadata
  3. Response Continuation → matching prefix? Append cached tail
  4. Miss → call upstream, store in all layers

Store:
  After successful upstream call:
  1. Write to exact cache (by fingerprint)
  2. Write embedding to semantic cache
  3. Update prompt cache tracker
  4. Update response continuation window
```

### 5. Provider Adapters (`src/adapters/`)

Each adapter implements `ProviderAdapter`:

```typescript
interface ProviderAdapter {
  readonly protocol: ProviderProtocol;
  buildRequestBody(ir: IRRequest): RequestEnvelope;
  parseResponse(body: unknown, headers: Headers, status: number): IRResponse;
  parseStreamEvents(stream: AsyncIterable<string>): AsyncGenerator<IRStreamEvent>;
}
```

Adapter responsibilities:
- Serialize IR → provider-specific JSON body
- Deserialize provider response → IR
- Handle provider-specific streaming formats (SSE, chunked, etc.)

### 6. Client Serializers (`src/clients/`)

Reverse of adapters: IR → client protocol format.

```typescript
interface ClientSerializer {
  readonly protocol: ClientProtocol;
  buildExpectedRequestBodyShape(): ExpectedRequestShape;
  parseRequestBody(body: unknown): IRRequest;
  serializeResponse(ir: IRResponse, meta: ResponseMeta): unknown;
  serializeStreamEvent(event: IRStreamEvent): ClientSseEvent;
}
```

### 7. HTTP Connector (`src/connector/`)

Outbound HTTP with resilience patterns:

- **Retry**: Exponential backoff + jitter for 408/425/429/5xx
- **Circuit Breaker**: closed → open → half-open state machine
- **Token Bucket**: Per-provider rate limiting
- **SSE Decoder**: Frame parser for streaming responses

### 8. Observability (`src/observability/`)

**Prometheus Metrics** (11 families, ~35 individual metrics):
- `gateway_request_total{protocol, model, code}` — request counter
- `gateway_cost_usd_total{key_id, model}` — cumulative cost
- `gateway_cache_hits_total{layer}` — cache hit by layer
- `gateway_probe_latency_seconds{model}` — probe latency histogram
- ... and more

**OpenTelemetry Tracing**:
- 17 semantic attributes per span (`gen_ai.*` convention)
- Trace ID propagated via `X-Gateway-Trace-ID` header
- Lazy tracer registration to avoid registry conflicts

### 9. Database (`src/storage/`)

SQLite schema with 13 core tables:

| Table | Purpose |
|-------|---------|
| `providers` | Provider config (encrypted API key) |
| `provider_models` | Upstream model mapping |
| `virtual_models` | Virtual model definition |
| `virtual_model_members` | Member-to-provider mapping |
| `api_keys` | Virtual keys (SHA-256 hash) |
| `api_key_budget` | Per-key budget state |
| `usage` | Token usage records |
| `exact_cache` | Cached responses by fingerprint |
| `semantic_cache` | Embedding hashes for semantic search |
| `response_continuation_cache` | Prefix-based continuation |
| `cache_hit_log` | Cache hit audit trail |
| `events` | System events (budget warnings, etc.) |
| `request_logs` | Full request/response logs |

Indexes: 14 indexes optimizing lookups by key_hash, fingerprint, date, etc.

## Module Dependencies

```
server
  ├── auth (keys, budget)
  ├── router (strategies, indexes)
  ├── cache (orchestrator, exact, semantic)
  ├── adapters (6 providers)
  ├── clients (4 serializers)
  ├── connector (HTTP, circuit breaker, retry)
  ├── observability (metrics, tracing)
  ├── guardrails (PII, injection)
  ├── mcp (tool protocol)
  └── storage (SQLite, repos, indexes)
```

No circular dependencies. All modules import from lower layers only.
