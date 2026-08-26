# AI Gateway — 实施计划

> 依据：`.monkeycode/specs/ai-gateway/requirements.md`（14 需求、114 验收准则）、`.monkeycode/specs/ai-gateway/design.md`（10+ 组件、SQLite schema、4 路由策略、4 Client Protocol 出口、6 Provider Adapter、TTFT 指标、Exact Cache、Budget Tracker、OTel）。
> 测试框架：vitest（单元 + 集成 + e2e）。
> 约束：原生 Node `http` 手写路由、SQLite（better-sqlite3）、无前端构建步骤、TypeScript 严格模式。

---

- [ ] 1. 项目脚手架与基础工具
  - [x] 1.1 初始化 `package.json` 与 npm 包元数据
    - 名称 `ai-gateway`，`bin: { "ai-gateway": "./dist/cli/index.js" }`，`main: "./dist/index.js"`
    - 依赖：`better-sqlite3`（运行时）、`vitest`（dev）
    - `engines.node >= 20`，`type: "module"`（ESM）
    - `scripts`: `dev`（tsx watch）、`build`（tsc）、`test`（vitest run）、`lint`（待选）
  - [x] 1.2 TypeScript 配置 `tsconfig.json`
    - 严格模式、ES2022 target、NodeNext module resolution、path alias `@/*` → `src/*`
    - 输出到 `dist/`，包含 sourcemap
  - [x] 1.3 目录骨架 `src/` 与 `test/`
    - 创建 `src/{server,adapters,clients,ir,router,probe,budget,cache,observability,usage,admin,cli,storage,crypto,utils}/`
    - 创建 `test/{unit,integration,e2e}/`
    - 创建 `web/`（管理后台）
  - [x] 1.4 配置文件加载器 `src/config/loader.ts`
    - 读取 `gateway.config.json` + 环境变量覆盖；提供 `getConfig()` 单例
    - 校验 schema（protocol 取值、url 格式、价格非负）
    - 首次启动时生成随机 Admin Token 并打印到 stdout
  - [x] 1.5 加密工具 `src/crypto/aes.ts`
    - AES-256-GCM 加解密；`MASTER_KEY` 来源：环境变量 `GATEWAY_MASTER_KEY` 或 `dataDir/master.key`（首次随机生成、0o600）
  - [x] 1.6 Logger `src/utils/logger.ts`
    - 结构化 JSON 日志（stdout）；敏感字段（Authorization、Cookie、X-Api-Key、sk-/Bearer/AKIA/ghp_/PEM）自动替换为 `***`

---

- [x] 2. SQLite 存储层（Req 7/8/10/12/13/14）
  - [x] 2.1 数据库连接与迁移 `src/storage/db.ts`
    - `better-sqlite3` 单例 + `WAL` 模式 + `synchronous=NORMAL`
    - `migrate()` 执行 `schema.sql`，写入 `schema_version` 表
    - 迁移失败时打印明确错误并以非零退出码退出
  - [x] 2.2 schema.sql 初始化
    - 建表：`providers`、`provider_models`、`virtual_models`、`virtual_model_members`、`keys`、`budget_counters`、`events`、`request_logs`、`cache_entries`、`probe_results`、`usage_records`、`response_cache`、`schema_version`
    - 索引：usage 按 created_at/key/upstream；events 按 key/created；request_logs 按 request_id；cache_entries 按 expires_at；probe_results 按 model/probed_at；response_cache 按 expires_at
    - 字段与 `design.md` §SQLite Schema 完全一致（参考 Requirement 5/6/7/12/13 新增字段）
  - [x] 2.3 Repository 模式 `src/storage/repos/*.ts`
    - `providers.ts` — CRUD + `syncModels(providerId, modelList)`
    - `providerModels.ts` — 查询/更新 availability/consecutive_*/latency
    - `virtualModels.ts` — CRUD + members 增删 + `getMembersWithAvailability()`
    - `keys.ts` — CRUD + `findByHash(hash)`、`incrementBudget(keyId, period, amount)`
    - `budget.ts` — 周期内 spent 查询/upsert；80% 告警去重
    - `events.ts` — append + `queryByKey(keyId, range)`
    - `usage.ts` — append + `aggregate({ groupBy, range })`
    - `cache.ts` — exact cache get/put/delete + LRU 内存层（`Map` + 容量限制）
    - `probe.ts` — append + `recentN(modelId, n)`
    - `logs.ts` — append + 按 requestId 拉取
  - [x] 2.4 内存索引 `src/storage/indexes.ts`
    - 启动时从 SQLite 加载 `virtualModelIndex`、`upstreamModelIndex`、`availabilityCache` 到内存
    - Admin API 写入时同步更新内存与 SQLite

---

- [x] 3. 内部表示 IR（Req 1/2/3，design §4.4）
  - [x] 3.1 IR 类型定义 `src/ir/types.ts`
    - `IRMessage` / `IRContent` 联合（text/image/audio/tool_use/tool_result/thinking）
    - `IRTool` 含 `providerExecuted` 与 `builtinKind`（web_search/code_interpreter/file_search）
    - `IRRequest` 含 `reasoning: IRReasoning` 与 `continuation: { previousResponseId? }`
    - `IRResponse` 含 `outputItems: IROutputItem[]` 联合（text/function_call/function_call_output/reasoning/web_search）
    - `IRUsage`、`IRFinishReason`、`IRChoice`
  - [x] 3.2 IR 规范化工具 `src/ir/normalize.ts`
    - `normalizeMessages()` — 合并连续同 role 消息、规范化空白
    - `fingerprint(request)` — model + 稳定序列化（键排序） + temperature + top_p + max_tokens + tools + tool_choice + response_format + seed → SHA-256
  - [x] 3.3 IR 单测 `test/unit/ir/`
    - 指纹抗碰撞：改任一关键字段必须 miss；相同输入两次必同指纹
    - 输出项类型覆盖 5 种（text/function_call/function_call_output/reasoning/web_search）

---

- [ ] 4. HTTP Server 与路由分发（Req 1、8，design §1）
  - [ ] 4.1 路由器 `src/server/router.ts`
    - 原生 `http` 模块；URL pattern 匹配 `/v1/chat/completions`、`/v1/responses`、`/v1/responses/:id`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1beta/models/:model\\:action`、`/v1/models`、`/v1beta/models`、`/admin`、`/admin/api/*`、`/metrics`、`/healthz`
    - 流式响应：`Content-Type: text/event-stream` + `Cache-Control: no-cache` + chunked
  - [ ] 4.2 请求解析与限流中间件 `src/server/middleware/parse.ts`
    - JSON body 解析（1MB 上限，可配置）
    - 解析请求体后挂 `req.gateway = { key, routedProviderId, ... }`
  - [ ] 4.3 优雅关停 `src/server/lifecycle.ts`
    - SIGTERM/SIGINT 钩子：拒绝新连接、等待 30s 进行中请求、关闭 SQLite、退出码 0
  - [ ] 4.4 单测 `test/unit/server/`
    - 路由匹配覆盖所有 Client Protocol 路径
    - 流式响应 chunk 顺序与连接断开时 error + [DONE]

---

- [ ] 5. 鉴权、预算与 Virtual Key（Req 5，design §2）
  - [ ] 5.1 Auth Middleware `src/server/middleware/auth.ts`
    - 解析 `Authorization: Bearer <key>`，SHA-256 → 查表
    - 校验 status=active、allowedModels 白名单
    - 返回 401（无效）/ 403（白名单外）
  - [ ] 5.2 RPM/TPM 限速 `src/ratelimit/sliding-window.ts`
    - 60 秒滚动窗口，每 Key 计数；超额 429 + `Retry-After`
  - [ ] 5.3 Budget Tracker `src/budget/tracker.ts`
    - `increment(keyId, amount)` — 累加 day/month/total 三计数器
    - 80% 阈值去重告警（同周期同阈值只写一次 events）
    - `hard` 模式超额返回 402 `budget_exceeded`，错误体含 `exceededBudget/spentUsd/budgetUsd`
    - 日/月切换自动清零（按 UTC 边界）
  - [ ] 5.4 单测 `test/unit/auth/`、`test/unit/budget/`
    - Key 校验、吊销、白名单
    - RPM/TPM 边界
    - 预算 80% 告警去重、hard/soft 模式、日/月切换清零

---

- [ ] 6. Exact Cache（Req 13，design §6b）
  - [ ] 6.1 Cache Manager `src/cache/manager.ts`
    - 内存 LRU（`cacheMaxEntries` 默认 1000）+ 可选 SQLite `cache_entries` 持久化
    - `lookup(fingerprint)` / `store(fingerprint, response, ttl)`
    - 流式 bypass（`stream: true` 直接返回 `bypass`）
  - [ ] 6.2 集成到请求生命周期
    - 在 Auth → Budget 之后、Router 之前执行
    - 命中时附加 `X-Gateway-Cache: hit` 头并直接走 Client Serializer 返回
    - 命中 usage 仍写入（costUSD=0、cacheHit='exact'）
  - [ ] 6.3 单测 `test/unit/cache/`
    - 指纹抗碰撞、流式 bypass、LRU 淘汰、TTL 过期、工具差异不误命中

---

- [ ] 7. Router（4 路由策略 + Fallback 链，Req 4）
  - [ ] 7.1 Router `src/router/index.ts`
    - 解析 `req.body.model` → 匹配 `virtualModelIndex`；未命中走 `upstreamModelIndex` 直传
    - 跳过 `availabilityCache.status === 'unavailable'`
  - [ ] 7.2 4 策略实现 `src/router/strategies/`
    - `roundRobin.ts` — 进程内原子计数
    - `weightedRandom.ts` — `crypto.randomInt` + 累计权重；weights 全 0 → 400 `invalid_weights`
    - `failover.ts` — priority 升序，跳过 unavailable
    - `lowestLatency.ts` — 滑动窗口（默认 5）平均延迟最低
  - [ ] 7.3 Fallback Chain
    - `Virtual Model.fallbackChain` 为 VirtualModel 名数组
    - 全员 unavailable 时按链序尝试；响应头 `X-Gateway-Fallback-From: <prevModelId>`
    - 流式首帧已发送则禁止降级
  - [ ] 7.4 Dry-run `src/router/dry-run.ts`
    - `POST /admin/api/virtual-models/:id/dry-run` 返回将命中的 member id，不实际发请求
  - [ ] 7.5 单测 `test/unit/router/`
    - 4 策略 + unavailable 跳过 + 跨协议成员 + fallback chain + dry-run 等价

---

- [ ] 8. Provider Adapters（6 类入口归一，Req 2，design §4.1）
  - [ ] 8.1 OpenAI Adapter `src/adapters/openai.ts`
    - `encodeRequest(IR, ctx) → OpenAI body`
    - `decodeResponse(OpenAI JSON | SSE) → IR`
    - 支持 `tools`、`tool_choice`、`response_format`、`stream`、`temperature/top_p/max_tokens/stop`
  - [ ] 8.2 OpenAI-Compatible Adapter `src/adapters/openai-compatible.ts`
    - 复用 OpenAI Adapter，差异化鉴权头与 baseUrl
  - [ ] 8.3 Anthropic Adapter `src/adapters/anthropic.ts`
    - system 数组拼接；tool_use 块 ↔ IR.tool_calls；thinking 字段 ↔ IR.thinking；cache_control 透传
    - 流式：`content_block_start/delta/stop`、`input_json_delta`、`message_delta`、`message_stop`
  - [ ] 8.4 Gemini Adapter `src/adapters/gemini.ts`
    - contents 角色归一；functionCall ↔ IR.tool_calls；thoughts ↔ IR.thinking
    - 流式：`candidates[].content.parts[]` 增量
  - [ ] 8.5 Doubao Adapter `src/adapters/doubao.ts`
    - 继承 OpenAI-Compatible；默认 baseUrl `https://ark.cn-beijing.volces.com/api/v3`
    - 模型列表配置在 Provider 上，不自动探测
  - [ ] 8.6 Wenxin Adapter `src/adapters/wenxin.ts`
    - OAuth2 client_credentials 获取 access_token，缓存 1h
    - baseUrl `/v2/chat/completions`，message role=system 拼接
  - [ ] 8.7 Protocol Bus `src/protocol-bus.ts`
    - 选择 `(clientProtocol, providerProtocol)` → Adapter × Serializer
    - 不支持组合返回 `unsupported_capability` 错误
  - [ ] 8.8 集成测试 `test/integration/adapters/`
    - 每个 Adapter 与 OpenAI/Responses/Anthropic/Gemini mock Provider 跑完整来回（含流式）

---

- [ ] 9. Client Serializers（4 出口序列化，Req 1/3，design §4.2）
  - [ ] 9.1 OpenAI Chat Serializer `src/clients/openai-chat-client.ts`
    - IR → OpenAI Chat Completions（直传）
  - [ ] 9.2 OpenAI Responses Serializer `src/clients/openai-responses-client.ts`
    - IR.messages → input items（message / function_call / function_call_output / reasoning）
    - 流式 event 顺序：`response.created` → `response.in_progress` → `response.output_text.delta` → `response.output_item.added/done` → `response.completed`
    - 同一 `response.id` 跨流稳定；`previous_response_id` 透传；响应写入 `response_cache`
    - 内置工具（web_search/code_interpreter/file_search）：按 Provider 能力三档降级（直转/Adapter 模拟/400 `builtin_tool_not_supported`）
  - [ ] 9.3 Anthropic Serializer `src/clients/anthropic-client.ts`
    - IR.tool_calls → tool_use blocks；IR.thinking → thinking blocks；cache_control 还原
    - 流式：content_block_start/delta/stop、input_json_delta、message_delta、message_stop
  - [ ] 9.4 Gemini Serializer `src/clients/gemini-client.ts`
    - IR.tool_calls → functionCall；contents 角色反推；IR.thinking → thoughts
  - [ ] 9.5 集成测试 `test/integration/serializers/`
    - 4 个 Serializer 与 6 类 Provider Adapter 组合的 24 组 fixture
    - 流式 chunk 顺序、`response.id` 稳定性、`previous_response_id` 退化

---

- [ ] 10. Probe Worker（Req 6，design §5）
  - [ ] 10.1 三态状态机 `src/probe/state-machine.ts`
    - `available` / `degraded` / `unavailable`
    - `available` → `degraded`：最近 `latencyWindow` 次 Probe 成功率 < 80%
    - `available/degraded` → `unavailable`：连续失败 ≥ `failureThreshold`
    - `unavailable` → `available`：连续成功 ≥ `recoveryThreshold`
  - [ ] 10.2 Probe Worker `src/probe/worker.ts`
    - `setInterval` 按 `probeIntervalMinutes`（0 关闭）
    - 每个 enabled UpstreamModel 发最小化请求（`max_tokens: 1`）
    - 写 `probe_results` + 更新 `availabilityCache`
    - 真实请求 5xx/超时触发 `recordFailure()`
  - [ ] 10.3 单测 `test/unit/probe/`
    - 状态机迁移规则、degraded 阈值、recovery、失败累计

---

- [ ] 11. Retry Policy + 上游调用（Req 6/10，design §6c）
  - [ ] 11.1 Retryable 分类 `src/upstream/errors.ts`
    - HTTP 408/429/5xx + 网络层（ECONNRESET、ETIMEDOUT、ENOTFOUND、TLS）→ retryable
    - 4xx 非 408/429 → 不重试，原样回传
  - [ ] 11.2 Retry Policy `src/upstream/retry.ts`
    - 指数退避：`baseMs * 2^(n-1) + random(0, jitterMs)`；maxRetries 默认 2
    - `Retry-After` 头覆盖：`max(retryAfter*1000, delay(n))`
    - 重试预算：滑动 60s 窗口内 `retries/total > retryBudgetRatio(0.2)` → 暂停重试
  - [ ] 11.3 Upstream Client `src/upstream/client.ts`
    - `https.request` 封装：connectTimeoutMs=5000、requestTimeoutMs=60000
    - 上游错误转 Client Protocol 错误体
    - 流式中断：SSE 流尾追加 error 事件 + `data: [DONE]`
  - [ ] 11.4 单测 `test/unit/upstream/`
    - Retryable 分类、指数退避计算、Retry-After 覆盖、重试预算熔断
    - 流式中断时 error 事件在 [DONE] 之前

---

- [ ] 12. 用量统计、预算集成、Prometheus & OTLP（Req 7/8，design §6、§6d）
  - [ ] 12.1 Usage Recorder `src/usage/recorder.ts`
    - 字段：`ttftMs`、`tokensPerSecond`、`cacheHit`、`source`（reported/estimated）
    - 流式首帧打点 ttftMs，结束时计算 tps
    - costUSD 公式：(prompt - cached) * input + cached * cachedInput + completion * output
  - [ ] 12.2 Prometheus Metrics `src/observability/metrics.ts`
    - `gateway_requests_total{key,model,provider,status}` Counter
    - `gateway_tokens_total{key,model,type}` Counter
    - `gateway_cost_usd_total{key,model}` Counter
    - `gateway_request_duration_ms_bucket` Histogram（le: 50/100/250/500/1000/2500/5000/10000）
    - `gateway_ttft_ms_bucket` Histogram（le: 100/250/500/1000/2000/5000）
    - `gateway_cache_hits_total{type}` Counter
    - `gateway_upstream_available{provider,model}` Gauge
    - `gateway_budget_usage_ratio{key}` Gauge
    - `GET /metrics` 端点（受 Admin Token 保护），文本格式输出
  - [ ] 12.3 OTel Exporter `src/observability/otel.ts`
    - 配置 `otelExporterOtlpEndpoint` 时启用 OTLP/gRPC 导出
    - 遵循 `gen_ai.*` 语义约定：`gen_ai.system`/`gen_ai.request.model`/`gen_ai.response.model`/`gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens`/`gen_ai.operation.name`
    - 流式 Span 事件：`ttft`、`stream_completed`
  - [ ] 12.4 Request Logs `src/observability/request-logs.ts`
    - Key 级 `logRequests` + 采样率 `logSampleRate`
    - 落库前正则替换 sk-/Bearer/AKIA/ghp_/PEM 为 `***`
    - 流式响应聚合完整文本
  - [ ] 12.5 单测 `test/unit/observability/`
    - 8 个指标族 histogram 边界
    - 指标增量与 usage 表对账（Correctness Property 18）
    - 脱敏正则覆盖 5 类凭据

---

- [ ] 13. Admin REST API（Req 8，design §7）
  - [ ] 13.1 Admin 路由表
    - `/admin/api/providers` CRUD + `/sync-models`
    - `/admin/api/virtual-models` CRUD + `/availability` + `/dry-run`
    - `/admin/api/keys` CRUD + `/budget` + `/budget/reset` + `/events`
    - `/admin/api/usage` + `/usage/timeseries`
    - `/admin/api/stats/{totals,distribution,latency,error-rate,top-models,heatmap,routing-distribution,provider-availability-matrix,availability}`
    - `/admin/api/cache` DELETE + `/cache/stats`
    - `/admin/api/logs?requestId=`
    - `/admin/api/test` — 真实请求连通性测试
    - `/admin/api/probe-results?modelId=`
  - [ ] 13.2 CLI `src/cli/index.ts`
    - `npx ai-gateway` 启动
    - `--config <path>`、`--import <path>`、`--export <path>`、`--version`、 `--reset-keys`
  - [ ] 13.3 单测 `test/unit/admin/`
    - 各端点鉴权、参数校验、聚合查询

---

- [ ] 14. Web 管理后台与仪表盘（Req 8，design §9/§10）
  - [ ] 14.1 SPA 入口 `web/index.html`
    - 单文件 HTML + 原生 ES2022 JS（无 React/Vue、无构建步骤）
    - Admin Token 弹窗输入 + `sessionStorage` 存储
    - 7 个 Tab：Overview / Providers / Virtual Models / Keys / Usage / Probes / Settings
  - [ ] 14.2 Overview 仪表盘（design §10）
    - KPI 卡片条（总请求/Tokens/费用/活跃 Key/P95）
    - 模型可用性卡片条（全部/Available/Degraded/Unavailable）
    - 时序面积图（Requests × Tokens，24h）
    - 错误率折线（24h）
    - Provider 占比环形图
    - Top 模型柱状（by cost）
    - P50/P95/P99 延迟柱
    - Key 用量 Top10 横向柱
    - VirtualModel 路由命中分布堆叠柱
    - Provider 实例可用性矩阵（行=Provider，列=UpstreamModel）
    - 30 天流量热力图（hour × weekday）
    - 自实现 SVG 图表（`src/web/charts/*.js`），零外部依赖
  - [ ] 14.3 数字滚动动画（200ms ease-out）
  - [ ] 14.4 6 色调色板按 Provider id 哈希分配

---

- [ ] 15. 端到端兼容测试（Req 11，design §Test Strategy）
  - [ ] 15.1 Claude Code 兼容（`@anthropic-ai/sdk`）
    - Anthropic 入口 → OpenAI Provider；tool_use 双向正确
  - [ ] 15.2 Cursor / Cline 兼容（`openai` SDK Chat Completions）
    - OpenAI Chat 入口 → Anthropic Provider，stream chunk 格式正确
    - OpenAI Chat 入口 → Gemini Provider，function_call 完整来回
  - [ ] 15.3 Codex CLI 兼容（`openai` SDK `client.responses.create`）
    - OpenAI Responses 入口 → Anthropic Provider，output items 还原为 Responses 规范
  - [ ] 15.4 `npm pack` + `npm install -g` smoke test
    - `ai-gateway --version` 退出码 0
    - 启动后端口监听、SIGTERM 优雅关闭

---

- [ ] 16. 检查点 — 全量测试通过
  - [ ] 16.1 运行 `npm test`（vitest run）覆盖率门槛
    - 行覆盖率 ≥ 80%、分支 ≥ 70%、协议转换器单独 ≥ 90%
  - [ ] 16.2 运行 `npm run build`（tsc）零错误零警告
  - [ ] 16.3 端到端 smoke：启动 mock providers → 6 类 Provider Adapter × 4 Client Serializer 跨协议互通 → 写 usage + budget + metrics

---

- [ ] 17. README 与发布元数据
  - [ ] 17.1 README.md（覆盖现有 2 行）
    - 快速开始（`npx ai-gateway`）、Web 后台、CLI 用法、环境变量、架构图（Mermaid）
  - [ ] 17.2 LICENSE（MIT）
  - [ ] 17.3 CHANGELOG.md v0.1.0 初始发布说明
  - [ ] 17.4 `npm pack` dry-run 检查产物清单

---

## Roadmap（二期，不在本期实现 — 见 Requirement 14）

- 语义缓存（embedding 相似度命中，cacheHit 枚举 `semantic` 接口位已预留）
- Guardrails 插件框架（内容安全过滤、PII 脱敏）
- MCP（Model Context Protocol）支持
- Prompt 管理与版本化
- 多实例集群模式（Postgres 或 SQLite WAL 共享）
- A/B 实验语义（cookie/header sticky + 统计面板）