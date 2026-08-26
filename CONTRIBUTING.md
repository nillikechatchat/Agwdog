# Contributing to ai-gateway

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone and install
git clone <repo-url>
cd ai-gateway
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Run with coverage
npm run test:coverage
```

## Architecture

```
Client Protocol (4 out)          Internal IR                Provider API (6 in)
─────────────────────           ─────────────              ─────────────────
OpenAI Chat Completions  ──►    ┌──────────────┐    ──►   OpenAI
OpenAI Responses     ──►    │  Gateway Core  │    ──►   Anthropic
Anthropic Messages   ──►    │  (IR Layer)    │    ──►   Gemini
Gemini GenerateContent ──►    └──────────────┘    ──►   Doubao
                                                 ──►   Wenxin
                                                 ──►   OpenAI-Compatible
```

### Key Components

- **`src/adapters/`** — 6 Provider Adapters (Provider → IR)
- **`src/clients/`** — 4 Client Serializers (IR → Client Protocol)
- **`src/router/`** — Virtual model routing with 4 strategies
- **`src/cache/`** — 4-layer cache orchestrator (exact → semantic → continuation)
- **`src/auth/`** — Bearer token auth + AES-256-GCM key encryption
- **`src/budget/`** — Per-key rate limiting and USD budget tracking
- **`src/observability/`** — Prometheus metrics + OpenTelemetry tracing
- **`src/server/`** — HTTP server with custom router (no Express/Fastify)

## Code Style

- TypeScript strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- ES modules (`"type": "module"` in package.json)
- No external dependencies for core (only `better-sqlite3` for persistence)
- Web admin: single-file HTML + vanilla ES2022 (no frameworks)

## Pull Request Process

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make changes and add tests
3. Run `npm test` and `npm run typecheck` — all must pass
4. Update README if adding new features
5. Submit PR with description of changes

## Testing

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E compatibility tests
npm run test:e2e

# With coverage report
npm run test:coverage
```

Coverage thresholds (enforced by vitest config):
- Lines: ≥ 80%
- Branches: ≥ 70%
- Protocol converters: ≥ 90%

## Adding a New Provider Adapter

1. Create `src/adapters/<provider>.ts`
2. Implement `ProviderAdapter` interface from `src/adapters/types.ts`
3. Register in `src/adapters/index.ts` factory
4. Add unit tests in `test/unit/adapters/<provider>.test.ts`
5. Update README Supported Providers table

## Adding a New Client Serializer

1. Create `src/clients/<protocol>.ts`
2. Implement `ClientSerializer` interface from `src/clients/types.ts`
3. Register in `src/clients/index.ts` factory
4. Add unit tests in `test/unit/clients/<protocol>.test.ts`
5. Update README Supported Client Protocols table

## License

MIT
