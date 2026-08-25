# Requirements Document — AI Gateway

## Introduction

`ai-gateway` 是一个本地优先的 npm 包形态 AI API 网关，把多个上游大模型 API 聚合为一个统一入口。它对 OpenAI Chat Completions、Anthropic Messages、Google Gemini GenerateContent 三类主流协议以及豆包/文心等国产特色协议进行请求与响应互转，统一鉴权、虚拟模型路由、故障转移、用量统计与价格管理，并通过 HTTP 服务暴露给任何 OpenAI/Anthropic 兼容 SDK 直接调用。

包以单一 Node.js 进程运行，零外部依赖服务（可选 SQLite 持久化），`npx ai-gateway` 即可启动；提供 CLI、Web 管理后台与 REST API 三种管理面。

## Glossary

- **Gateway**：本文档中所述的 `ai-gateway` 本地服务进程。
- **Upstream Provider**：接入 Gateway 的上游模型服务方，例如 OpenAI、Anthropic、Google Gemini、字节豆包、百度文心、阿里通义、DeepSeek、月之暗面、智谱、本地 Ollama 等。
- **Provider Protocol**：上游 Provider 使用的原生 API 协议，包含 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent、Doubao Ark、Wenxin AccessToken、OpenAI-Compatible 六类。
- **Client Protocol**：调用方发送给 Gateway 的协议（即 Gateway 对外暴露的协议）。Gateway 必须支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini GenerateContent 四种 Client Protocol 出口。无论上游 Provider 是哪一种 API，调用方都通过这四种协议之一与 Gateway 通信。
- **Responses Item**：OpenAI Responses 协议中的结构化输出单元，包含 `message`、`function_call`、`function_call_output`、`reasoning`、`web_search_call` 等类型。
- **Virtual Model**：用户在 Gateway 管理后台创建、由若干真实 Upstream Model 组合而成的逻辑模型名，可指定路由策略。
- **Routing Strategy**：将请求分发到 Virtual Model 中某个 Upstream Model 的策略，包含 Round Robin、Weighted Random、Failover、Lowest Latency 四种。
- **Probe**：Gateway 对 Upstream Model 发起的可用性探测请求，记录延迟、HTTP 状态码与失败原因。
- **Virtual Key**：Gateway 颁发的、客户端在调用 Gateway 时使用的鉴权凭证。
- **SSE**：Server-Sent Events，本文档中专指 OpenAI/Anthropic/Gemini 三家流式响应协议。
- **Token Usage**：请求消耗的输入、输出、缓存 Token 数，由 Gateway 从上游响应中提取或估算。
- **Price Table**：以 USD / 1M tokens 为单位的输入/输出价格表，用于用量计费。
- **Admin Token**：用于访问 Gateway 管理后台与 REST API 的管理员令牌。
- **Exact Cache**：以请求指纹（model + messages + 关键参数的规范化哈希）为键的响应缓存，命中时零上游成本。
- **Fallback Chain**：Virtual Model 上配置的降级链，当全部成员不可用时依次尝试更便宜/更保守的备选 Virtual Model。
- **Budget**：Virtual Key 上的金额预算约束，含日预算、月预算与总额度，支持超额软告警与硬阻断两种模式。
- **TTFT**：Time To First Token，流式请求从发出到收到首个内容帧的毫秒数。
- **Retryable Error**：可安全重试的上游错误分类，包含 408、429、5xx 与网络层错误（连接重置、DNS 失败、TLS 握手超时）。

## Requirements

### Requirement 1 — 多 API 进、四协议出

**User Story:** 作为 AI 应用开发者，我希望用 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini GenerateContent 四种 SDK 任意一种直接调用 Gateway，不论底层接的是 6 种上游 API 中的哪一种，调用方都看到同一种 Client Protocol 响应，这样不必为每个上游 Provider 维护独立客户端。

#### Acceptance Criteria

1. WHEN 客户端以 OpenAI Chat Completions 协议调用 Gateway 的 `POST /v1/chat/completions`，THE Gateway SHALL 返回 OpenAI Chat Completions 协议语义一致的成功响应或错误响应。
2. WHEN 客户端以 OpenAI Responses 协议调用 Gateway 的 `POST /v1/responses`，THE Gateway SHALL 返回 OpenAI Responses 协议语义一致的成功响应或错误响应，包含 `id`、`object`、`output` 数组、`usage`、`status` 字段。
3. WHEN 客户端以 Anthropic Messages 协议调用 Gateway 的 `POST /v1/messages`，THE Gateway SHALL 返回 Anthropic Messages 协议语义一致的成功响应或错误响应。
4. WHEN 客户端以 Gemini GenerateContent 协议调用 Gateway 的 `POST /v1beta/models/{model}:generateContent`，THE Gateway SHALL 返回 Gemini GenerateContent 协议语义一致的成功响应或错误响应。
5. WHEN 客户端发送 SSE 流式请求，THE Gateway SHALL 将上游响应原样或经转换后以 SSE 帧的形式转发给客户端，事件顺序与上游保持一致。
6. WHEN 客户端请求 `GET /v1/models`，THE Gateway SHALL 返回所有已启用 Virtual Model 与真实 Upstream Model 的列表，字段包含 id、object、created、owned_by、type。
7. WHEN OpenAI Responses 客户端请求中携带 `previous_response_id` 字段，THE Gateway SHALL 在 IR 阶段以 `IR.continuation` 字段承载，并由 Provider Adapter 在转发至支持 Responses 的 Provider 时还原为 `previous_response_id`，转发至不支持的 Provider 时退化为完整 messages 数组并写入 `X-Gateway-Warnings`。

### Requirement 2 — 上游 Provider 接入

**User Story:** 作为平台运维者，我希望把任意数量的 Upstream Provider API 接入 Gateway，包括官方直连、OpenAI 兼容中转以及豆包/文心等国产特色 API，这样所有模型都可在一个面板管理。Gateway 内部将这些 API 归一化为统一的内部表示，再以 4 种 Client Protocol 出口（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini GenerateContent）对外暴露。

#### Acceptance Criteria

1. WHEN 管理员在 Web 后台或 `POST /admin/providers` 添加一个 Provider，THE Gateway SHALL 在数据层持久化该 Provider 的 id、name、protocol、baseUrl、apiKey 与模型列表，protocol 取值限于 OpenAI、OpenAI-Compatible、Anthropic、Gemini、Doubao、Wenxin 六种。
2. WHEN Provider 的 protocol 为 `OpenAI-Compatible` 或 `OpenAI`，THE Gateway SHALL 通过 `GET {baseUrl}/models` 自动拉取上游模型列表并写入 Provider 的 models 字段。
3. WHEN Provider 的 protocol 为 `Anthropic`，THE Gateway SHALL 通过调用 `POST {baseUrl}/v1/messages` 携带轻量提示词完成模型列表同步，结果以 (modelId, displayName) 形式持久化。
4. WHEN Provider 的 protocol 为 `Gemini`，THE Gateway SHALL 通过 `GET {baseUrl}/v1beta/models` 拉取上游模型列表并写入 Provider 的 models 字段。
5. WHEN Provider 的 protocol 为 `Doubao` 或 `Wenxin`，THE Gateway SHALL 使用 Provider 配置中显式声明的模型列表，不主动探测上游模型目录。
6. WHEN 管理员删除一个 Provider，THE Gateway SHALL 同时删除该 Provider 下所有关联的 Upstream Model、Probe 记录与路由引用。
7. WHEN Gateway 完成 Provider 接入，THE Gateway SHALL 在内部将该 Provider 的 API 描述注册为 `internal-protocol-neutral` 表示，所有 6 种 API 在转换层都被翻译为这一内部表示，再按 Client Protocol 序列化出口。

### Requirement 3 — 四协议请求与响应互转（含 Claude Code 兼容）

**User Story:** 作为调用者，我希望无论请求协议与上游协议是否一致，都能正确完成请求与响应互转，包括流式与工具调用，这样 Claude Code、Cline、Cursor、Codex 等工具都能直接对接 Gateway。

#### Acceptance Criteria

1. WHEN Client Protocol 与 Provider Protocol 不一致，THE Gateway SHALL 在请求阶段将客户端协议转换为目标 Provider Protocol 的请求体，并将流式开关、tools、tool_choice、system/developer 消息、温度、top_p、max_tokens 等关键参数映射为 Provider 等价字段。
2. WHEN 上游以非流式响应返回，THE Gateway SHALL 将 Provider 响应转换为 Client Protocol 响应，并把 Token Usage、finish_reason、model 字段写入响应体。
3. WHEN 上游以 SSE 流式响应返回，THE Gateway SHALL 按 Provider 流式事件顺序逐帧转换为 Client Protocol 流式事件，并保持 tool_calls 增量、usage 增量、finish_reason 终止帧的语义一致。
4. WHEN Provider 原生不支持请求中的 tools 或 tool_choice，THE Gateway SHALL 在转换层忽略不支持字段并将忽略项记录在响应头 `X-Gateway-Warnings` 中，响应主体照常返回。
5. WHEN Provider 不支持 `response_format` 结构化输出，THE Gateway SHALL 在转换层退化为指令式 system 提示并附 `X-Gateway-Warnings`，响应主体照常返回。
6. WHEN 任意转换阶段发生不可恢复错误，THE Gateway SHALL 返回与 Client Protocol 一致的错误码与错误体，包含 type、code、message、param 字段。
7. WHEN 客户端以 Anthropic Messages 协议调用并携带 tools 字段，THE Gateway SHALL 在转发至非 Anthropic Provider 时将 Anthropic tool_use 块转换为 OpenAI function calling 或 Gemini functionDeclarations，并把 Provider 返回的工具调用反向转换为 Anthropic tool_use 流式事件。
8. WHEN Anthropic 客户端请求中携带 `thinking` 或 extended thinking 字段，THE Gateway SHALL 在 Provider 支持时映射为对应字段（OpenAI reasoning_effort、Gemini thinkingConfig）；不支持时忽略并写入 `X-Gateway-Warnings`。
9. WHEN 客户端以 Anthropic 协议调用并使用 `system` 数组形式（多段 system），THE Gateway SHALL 在转换阶段拼接为单一 system 文本字段并保留原始顺序与 cache_control 标记。
10. WHEN 客户端以 OpenAI Responses 协议调用，THE Gateway SHALL 将 `input` 字符串或数组项（`message`、`function_call`、`function_call_output`、`reasoning`）归一化为 IR.messages，再由 Provider Adapter 转换为目标 Provider 请求体。
11. WHEN 客户端以 OpenAI Responses 协议调用并请求 `web_search` 等内置工具，THE Gateway SHALL 在 IR 阶段标记 `IR.tools` 中对应工具的 `provider_executed` 标志，并在 Provider Adapter 中按 Provider 能力拆解：支持 Responses 的 Provider 原样转发；支持 Chat Completions 的 Provider 在 Adapter 中调用实际搜索并以 `IR.tool_result` 注入消息；不支持搜索的 Provider 返回 400 错误，错误码 `builtin_tool_not_supported`。
12. WHEN 上游以 OpenAI Responses 协议返回（Provider 为 OpenAI Responses 原生或兼容 Responses 的中转），THE Gateway SHALL 在 Responses Serializer 中按 Responses Item 类型逐项渲染 `output` 数组，并在流式响应中按 Responses event 类型（`response.created`、`response.output_text.delta`、`response.output_item.done`、`response.completed`）顺序转发。
13. WHEN 客户端以 OpenAI Responses 协议调用并携带 `previous_response_id`，THE Gateway SHALL 在 Provider 不支持 Responses 续传时退化为完整 messages 数组（从本地响应缓存或 Provider 历史接口拉取）并写入 `X-Gateway-Warnings`。

### Requirement 4 — Virtual Model 多服务商路由

**User Story:** 作为平台用户，我希望用一个 client model id（如 `gpt-4o` 或 `claude-sonnet`）对应多个上游服务商（OpenAI、Azure、任意 OpenAI 兼容中转、Anthropic 直连、文心、豆包）的同一模型，并按策略自动分发或故障切换，这样主服务商故障时业务不中断、不同地区/不同成本可走不同渠道。

#### Acceptance Criteria

1. WHEN 管理员创建一个 Virtual Model 并选择至少一个 `(providerId, providerModelId)` 组合作为成员，THE Gateway SHALL 持久化该 Virtual Model 的 id、name、strategy 与成员列表，name 作为客户端调用时的 model id。
2. WHEN 同一 Virtual Model 的成员来自多个 Provider 且这些 Provider 属于不同协议家族，THE Gateway SHALL 在 Adapter 层把请求归一为 IR 后再分发，确保不同协议成员对同一 Virtual Model 透明。
3. WHEN 客户端请求中的 model 字段命中某个 Virtual Model，THE Gateway SHALL 按该 Virtual Model 的 strategy 字段选择一个成员进行实际转发。
4. WHEN strategy 为 `RoundRobin`，THE Gateway SHALL 按请求到达顺序在成员间循环选择，并在同一 Virtual Model 实例内保持计数单调递增；不同 Provider 实例在轮询队列中按加入顺序排列。
5. WHEN strategy 为 `WeightedRandom`，THE Gateway SHALL 按成员 weight 字段计算累计权重并按均匀随机抽样选择成员，所有成员的 weight 之和必须大于零，否则返回 400 错误码 `invalid_weights`。
6. WHEN strategy 为 `Failover`，THE Gateway SHALL 按成员 priority 升序选择首个 available 成员；当首选成员在最近一次 Probe 中被标记为 unavailable，THE Gateway SHALL 跳过该成员选择次选。
7. WHEN strategy 为 `LowestLatency`，THE Gateway SHALL 选择最近 N 次 Probe 中平均延迟最低且状态为 available 的成员，N 默认取 5，可由 Virtual Model 的 latencyWindow 字段覆盖。
8. WHEN strategy 为 `Failover` 且所有成员均标记为 unavailable，THE Gateway SHALL 依次尝试该 Virtual Model 的 fallbackChain 中配置的备选 Virtual Model；当 fallbackChain 为空或全部失败，THE Gateway SHALL 返回 502 错误体，错误码为 `all_upstreams_unavailable`。
9. WHEN 管理员为 Virtual Model 配置 fallbackChain（如 `["gpt-4o", "gpt-4o-mini", "deepseek-chat"]`），THE Gateway SHALL 在主 Virtual Model 全部成员不可用时按链序尝试备选，并在响应头 `X-Gateway-Fallback-From` 中注明实际生效的前一级 model id。
10. WHEN 管理员调用 `GET /admin/api/virtual-models/:id/availability`，THE Gateway SHALL 返回该 Virtual Model 所有成员的 availability 状态、最近延迟、最近一次 Probe 时间与连续失败/成功计数。
11. WHEN 客户端请求中的 model 字段直接命中某个 UpstreamModel（未走 Virtual Model 包装），THE Gateway SHALL 直传该 UpstreamModel 并跳过 Virtual Model 路由逻辑，但 availability 与 Probe 仍生效。
12. WHEN 管理员调用 `POST /admin/api/virtual-models/:id/dry-run`，THE Gateway SHALL 根据当前可用性与策略返回该 Virtual Model 下一次请求将选择的成员 id（不实际发起调用）。
13. WHEN fallbackChain 触发时客户端请求为流式，THE Gateway SHALL 仅在未向客户端写出任何内容帧的前提下执行链式降级；已写出首帧后发生故障的请求按 Requirement 6 AC6 处理。

### Requirement 5 — 鉴权、Virtual Key 与预算管理

**User Story:** 作为平台管理员，我希望为团队成员颁发 Virtual Key 并能随时吊销，同时为每个 Key 设置金额预算（日/月/总额），这样不同应用与不同成员的用量可独立计量、限额与止损。

#### Acceptance Criteria

1. WHEN 管理员调用 `POST /admin/keys` 创建 Virtual Key，THE Gateway SHALL 返回明文 Key 一次并仅持久化其 SHA-256 摘要。
2. WHEN 客户端调用 Gateway 时未携带 Authorization 头或 Key 无效，THE Gateway SHALL 返回 401 错误。
3. WHEN 管理员调用 `DELETE /admin/keys/:id` 吊销 Key，THE Gateway SHALL 将该 Key 标记为 revoked，后续使用该 Key 的请求返回 401 错误。
4. WHEN Key 上配置了 rpm 或 tpm 限额且当前窗口内累计超过限额，THE Gateway SHALL 返回 429 错误并附带 `Retry-After` 头。
5. WHEN Key 上配置了 allowedModels 白名单且请求的 model 不在白名单内，THE Gateway SHALL 返回 403 错误。
6. WHEN 管理员为 Key 配置 `budgetDailyUsd`、`budgetMonthlyUsd` 或 `budgetTotalUsd` 中任意一项，THE Gateway SHALL 在每次请求计费后累加该 Key 的对应预算计数器。
7. WHEN Key 的任一预算计数器达到配置值的 80%，THE Gateway SHALL 生成一条 `budget_warning` 事件写入 events 表并可通过 `GET /admin/api/keys/:id/events` 查询；同一预算周期内同一阈值只告警一次。
8. WHEN Key 的 `budgetMode` 为 `hard` 且任一预算计数器达到配置值，THE Gateway SHALL 对后续请求返回 402 错误，错误码 `budget_exceeded`，错误体包含 `exceededBudget`、`spentUsd`、`budgetUsd` 字段。
9. WHEN Key 的 `budgetMode` 为 `soft` 且预算超额，THE Gateway SHALL 照常放行请求，仅持续记录 `budget_exceeded` 事件。
10. WHEN 管理员调用 `POST /admin/keys/:id/budget/reset`，THE Gateway SHALL 清零指定周期的预算计数器并记录操作审计事件。

### Requirement 6 — 模型可用性、Probe 与故障转移

**User Story:** 作为平台运维者，我希望 Gateway 自动持续探测每个 Upstream Model 的可用性，在故障时自动跳过，并将模型可用性状态暴露给客户端与管理后台，这样线上业务不会被不可用模型拖慢，客户端 SDK 也能据此提示用户。

#### Acceptance Criteria

1. WHEN 管理员在配置中设置 `probeIntervalMinutes` 大于 0，THE Gateway SHALL 按该间隔对所有启用的 `(providerId, providerModelId)` 组合执行 Probe，并在数据层记录每次 Probe 的 latency、statusCode、success、errorMessage、probedAt。
2. WHEN Probe 连续失败次数达到 `failureThreshold`（默认 3），THE Gateway SHALL 将该 Upstream Model 标记为 `unavailable` 并停止将其纳入任何 Virtual Model 的路由选择。
3. WHEN Probe 在 unavailable 状态下连续成功次数达到 `recoveryThreshold`（默认 2），THE Gateway SHALL 将该 Upstream Model 重新标记为 `available` 并恢复路由资格。
4. WHEN 真实请求收到 Provider 返回的 5xx 或网络超时错误，THE Gateway SHALL 将该 Upstream Model 的连续失败计数加一并按 AC2 的规则触发降级。
5. WHEN 真实请求收到 Provider 返回的 4xx 错误（除 408 与 429），THE Gateway SHALL 不修改 Upstream Model 的可用性状态，原样回传错误体给客户端。
6. WHEN 客户端请求是流式且中途 Provider 连接断开，THE Gateway SHALL 在 SSE 流尾追加一条 Client Protocol 的 error 事件，type 字段为对应 Provider 错误类型，并在 `data: [DONE]` 之前发送。
7. WHEN 客户端调用 `GET /v1/models`，THE Gateway SHALL 在返回的每个 model 对象的 `metadata.availability` 字段中暴露 `available` / `degraded` / `unavailable` 三态，`degraded` 表示最近 N 次 Probe 中成功率 < 80%；`unavailable` 表示已触发降级；`available` 表示正常。
8. WHEN 客户端调用 `GET /v1/models`，THE Gateway SHALL 在每个 model 对象的 `metadata` 中暴露 `endpoints` 数组，每个元素为 `{ providerId, providerModelId, availability, latencyMsP50, latencyMsP95 }`，使调用方一眼看出该 model id 背后绑定了哪些服务商实例及其各自的可用性。
9. WHEN Virtual Model 切换 provider 实例（RoundRobin/WeightedRandom/Failover/LowestLatency），THE Gateway SHALL 在响应头 `X-Gateway-Routed-Provider` 与 `X-Gateway-Routed-Model` 中返回实际命中的 `(providerId, providerModelId)`，便于客户端诊断路由结果。
10. WHEN 管理员调用 `GET /admin/api/availability`，THE Gateway SHALL 返回所有 Upstream Model 的当前 availability、连续失败/成功计数、最近 10 次 Probe 历史与最近一次真实请求失败原因。
11. WHEN Upstream Model 处于 `unavailable` 状态且 Probe 仍未恢复，THE Gateway SHALL 在 `GET /v1/models` 中将该 model id 标记为 `available=false` 并在 OpenAI Responses 协议的 `output` 中通过 `metadata.unavailable_since` 暴露降级开始时间。

### Requirement 7 — 用量统计与价格管理

**User Story:** 作为财务与产品负责人，我希望按 Key / Virtual Model / Upstream Model / 日期四个维度查看 Token 与费用消耗，这样能准确分摊成本与优化调用。

#### Acceptance Criteria

1. WHEN 任意请求成功完成（流式请求以 `[DONE]` 为完成标志），THE Gateway SHALL 将本次请求的 promptTokens、completionTokens、cachedTokens、totalTokens、costUSD、keyId、virtualModelId、upstreamProviderId、upstreamModelId、latencyMs、statusCode、probedAt 写入数据层 usage 表。
2. WHEN 请求为流式，THE Gateway SHALL 额外记录 ttftMs（发出上游请求到收到首个内容帧的毫秒数）与 tokensPerSecond（completionTokens / (latencyMs - ttftMs) * 1000），用于流式体验与吞吐质量分析。
3. WHEN 请求命中 Exact Cache（见 Requirement 13），THE Gateway SHALL 将该请求的 cacheHit 字段记为 `exact`，costUSD 记为 0，并在 usage 表保留一条记录以反映零成本命中。
4. WHEN 请求中 Provider 未在响应体内返回 usage 字段，THE Gateway SHALL 按本地估算规则（字符数 / 4 向下取整）补齐 promptTokens 与 completionTokens 并将 source 字段标记为 `estimated`。
5. WHEN 管理员调用 `GET /admin/usage?groupBy=day&range=7d`，THE Gateway SHALL 返回按日期聚合的 promptTokens、completionTokens、costUSD、requestCount 列表。
6. WHEN 管理员调用 `GET /admin/usage?groupBy=model&range=30d`，THE Gateway SHALL 返回按 upstreamModelId 聚合的 costUSD 与 token 列表，按 costUSD 降序排列。
7. WHEN 管理员调用 `GET /admin/usage?groupBy=key&range=today`，THE Gateway SHALL 返回按 keyId 聚合的 costUSD、requestCount、rpm、tpm 列表。
8. WHEN 管理员在 Provider 配置中设置了 inputPricePerMTokensUSD 与 outputPricePerMTokensUSD，THE Gateway SHALL 按 USD / 1M tokens 计价并将每条 usage 记录的 costUSD 字段写入。
9. WHEN 管理员在 Provider 配置中设置了 cachedInputPricePerMTokensUSD，THE Gateway SHALL 将 cachedTokens 按该价格计入 costUSD。

### Requirement 8 — 管理面与可观测性

**User Story:** 作为平台管理员，我希望通过 Web 管理后台完成所有配置，通过 Prometheus 抓取网关指标，通过 OpenTelemetry 把调用链路接入现有可观测体系，并能审计完整请求响应。

#### Acceptance Criteria

1. WHEN 管理员启动 Gateway 后访问 `http://{host}:{port}/admin`，THE Gateway SHALL 返回 Web 管理后台的 SPA 入口。
2. WHEN 管理员使用正确的 Admin Token 访问 `GET /admin/api/*`，THE Gateway SHALL 通过鉴权并返回 JSON 响应；当 Token 缺失或错误，THE Gateway SHALL 返回 401。
3. WHEN Gateway 启动成功，THE Gateway SHALL 输出一行结构化启动日志，包含 version、listenHost、listenPort、adminEnabled、dataDir、uptimeMs。
4. WHEN 任意请求完成，THE Gateway SHALL 追加一条结构化访问日志，包含 requestId、keyId、virtualModelId、upstreamModelId、latencyMs、ttftMs、statusCode、promptTokens、completionTokens、cacheHit。
5. WHEN 管理后台展示用量图表，THE Gateway SHALL 提供 `GET /admin/api/usage/timeseries?bucket=hour&range=24h` 接口，返回以 bucketStart 为键的聚合序列。
6. WHEN 抓取器访问 `GET /metrics`（受与 Admin Token 相同的鉴权保护），THE Gateway SHALL 以 Prometheus 文本格式暴露以下指标族：`gateway_requests_total{key,model,provider,status}`、`gateway_tokens_total{key,model,type}`、`gateway_cost_usd_total{key,model}`、`gateway_request_duration_ms_bucket`、`gateway_ttft_ms_bucket`、`gateway_cache_hits_total{type}`、`gateway_upstream_available{provider,model}`、`gateway_budget_usage_ratio{key}`。
7. WHEN 管理员配置 `otelExporterOtlpEndpoint`，THE Gateway SHALL 以 OTLP/gRPC 按 OpenTelemetry GenAI 语义约定（`gen_ai.*` 属性族）导出每个请求的 Span，属性包含 gen_ai.system、gen_ai.request.model、gen_ai.response.model、gen_ai.usage.input_tokens、gen_ai.usage.output_tokens、gen_ai.operation.name，并在流式请求中记录 TTFT 与总时延两个时间点事件。
8. WHEN 管理员为 Key 开启 `logRequests`（默认关闭），THE Gateway SHALL 将该 Key 请求的请求体与响应体（脱敏后）写入 request_logs 表，采样率由 Key 的 `logSampleRate`（0-1，默认 1）控制；流式响应记录聚合后的完整文本。
9. WHEN 请求响应日志开启且请求中包含 Authorization、Cookie、X-Api-Key 头或 API Key 形态的字符串，THE Gateway SHALL 在落库前按正则模式（sk-、Bearer、AKIA、ghp_ 等前缀）替换为 `***`。
10. WHEN 管理员调用 `GET /admin/api/logs?requestId=...`，THE Gateway SHALL 返回该请求的完整审计记录，包含请求体、响应体、路由决策（命中的 provider/model/strategy）、Probe 快照与耗时分解（connect/ttfb/ttft/total）。

### Requirement 9 — 部署与生命周期

**User Story:** 作为开发者，我希望以最少步骤安装、启动、停止、升级 Gateway，并且所有配置可通过文件或环境变量注入。

#### Acceptance Criteria

1. WHEN 用户执行 `npx ai-gateway`，THE Gateway SHALL 启动 HTTP 服务并监听 `PORT` 环境变量（默认 3000）上的全部端口。
2. WHEN 用户执行 `npx ai-gateway --config <path>`，THE Gateway SHALL 读取该路径下的 JSON 配置文件并以文件配置覆盖默认配置。
3. WHEN 用户执行 `npx ai-gateway --import <path>`，THE Gateway SHALL 从该 JSON 文件导入 Provider / Virtual Model / Key 配置而不启动服务；导入的 Virtual Model 支持 `members` 字段引用多个不同 Provider 的同一逻辑 model id，以满足"一个 model id 负载多个服务商"的部署形态。
4. WHEN 用户向运行中进程发送 `SIGTERM`，THE Gateway SHALL 等待所有进行中流式请求结束（最长 30 秒）后安全关闭并释放监听端口。
5. WHEN 进程启动时检测到数据目录中已存在旧 schema 的 SQLite 数据库，THE Gateway SHALL 执行 schema 迁移并在迁移失败时拒绝启动并打印明确错误信息。

### Requirement 10 — 安全与隔离

**User Story:** 作为企业安全负责人，我希望所有上游 API Key 不落明文、所有外部调用有超时与重试上限、所有错误不泄露上游凭据。

#### Acceptance Criteria

1. WHEN 上游 API Key 写入数据层时，THE Gateway SHALL 使用 AES-256-GCM 加密存储，密钥来源于 `GATEWAY_MASTER_KEY` 环境变量或首次启动时随机生成的本地密钥。
2. WHEN 任何错误响应体构造时，THE Gateway SHALL 仅暴露 Provider 返回的错误 message 与 code 字段，不包含 Authorization、X-Api-Key、Bearer 等鉴权字段。
3. WHEN Gateway 发起上游请求，THE Gateway SHALL 设置 connectTimeoutMs（默认 5000）、requestTimeoutMs（默认 60000）两项硬性约束。
4. WHEN 上游返回 Retryable Error（408、429、5xx 或网络层错误），THE Gateway SHALL 按指数退避策略重试：第 n 次重试延迟 `baseMs * 2^(n-1) + jitter`（baseMs 默认 500，jitter 为 0-500 均匀随机），最大重试次数由 Virtual Model 的 `maxRetries`（默认 2）控制。
5. WHEN 上游 429 响应携带 `Retry-After` 头，THE Gateway SHALL 以该头的秒数覆盖指数退避计算值。
6. WHEN 单位时间内的重试请求数占比超过 `retryBudgetRatio`（默认 0.2，即重试占总请求 20%），THE Gateway SHALL 暂停重试并直接透传错误，防止重试风暴放大上游压力。
7. WHEN 客户端请求中包含敏感字段（Authorization、Cookie、X-Api-Key），THE Gateway SHALL 在日志输出前将其替换为 `***`。
8. WHEN 管理员启用 `adminEnabled=false`，THE Gateway SHALL 完全禁用 Web 管理后台与管理 REST API，但不影响 `POST /v1/chat/completions` 等 Client Protocol 出口。

### Requirement 11 — Claude Code / Cursor / Cline / Codex CLI 兼容矩阵

**User Story:** 作为使用 Claude Code、Cursor、Cline、Cherry Studio、Codex CLI、OpenAI Agent SDK 等 IDE 工具的开发者，我希望将这些工具的 API Base URL 改为指向 Gateway 即可工作，不必修改工具源码。

#### Acceptance Criteria

1. WHEN Claude Code 以 Anthropic Messages 协议向 Gateway 发送包含 Read/Bash/Edit 等内置工具的请求，THE Gateway SHALL 完整保留 tool schema 与 tool_use_id，并在流式响应中按 Anthropic input_json_delta 顺序回写工具输入。
2. WHEN 客户端请求体中包含 Anthropic 特有的 `metadata.user_id` 或 `anthropic-beta` 头，THE Gateway SHALL 将其作为透传头转发至 Anthropic Provider，并在非 Anthropic Provider 上忽略并写入 `X-Gateway-Warnings`。
3. WHEN 客户端使用 Cursor 的 OpenAI 兼容协议调用并要求 `stream: true`，THE Gateway SHALL 保持 SSE 帧格式与 OpenAI chat.completions 一致，确保 Cursor 解析器能识别 `delta.content` 与 `finish_reason`。
4. WHEN 客户端使用 Cline 调用并请求 tools，THE Gateway SHALL 保证 tool_calls 数组在每个流式 chunk 中按 OpenAI 规范使用 tool_calls.index 增量索引。
5. WHEN 任意 IDE 工具发起 max_tokens 超过 Provider 上限的请求，THE Gateway SHALL 在 Provider 返回 400 时将错误体按 Client Protocol 重新构造并保留原始 message。
6. WHEN Codex CLI 或 OpenAI Agent SDK 以 Responses 协议调用 Gateway 并使用 `web_search` 内置工具，THE Gateway SHALL 保证 `output` 数组中包含对应 `web_search_call` 项并保留其 `status`、`results` 字段。

### Requirement 12 — OpenAI Responses 状态管理与内置工具

**User Story:** 作为使用 Codex CLI 或 OpenAI Agent SDK 的开发者，我希望 Gateway 在 OpenAI Responses 协议下支持 `previous_response_id` 续传、reasoning 内省以及 web_search / file_search / code_interpreter 等内置工具，使多轮代理任务可在多 Provider 间无缝切换。

#### Acceptance Criteria

1. WHEN 客户端调用 `POST /v1/responses` 且 Provider 为 OpenAI Responses 原生或兼容中转，THE Gateway SHALL 在转发请求时携带 `previous_response_id` 字段，由 Provider 负责状态管理。
2. WHEN Provider 不支持 `previous_response_id` 但支持 Chat Completions，THE Gateway SHALL 在 Adapter 中将历史 Responses（从本地 SQLite 响应缓存表读取）展开为完整 `messages` 数组，并写入 `X-Gateway-Warnings: previous_response_id_unsupported`。
3. WHEN 客户端在 Responses 请求中启用 `reasoning.effort` 或 `reasoning.summary` 字段，THE Gateway SHALL 在 IR 阶段归一化为 `IR.reasoning`，转发至 OpenAI/Anthropic/Gemini 时映射为对应 reasoning 字段；不支持时忽略并写入 `X-Gateway-Warnings`。
4. WHEN 客户端在 Responses 请求中启用 `web_search` 内置工具，THE Gateway SHALL 在 Provider Adapter 中按 Provider 能力选择路径：
   - Provider 原生支持 Responses：原样转发；
   - Provider 支持 Chat Completions + 搜索引擎 API：Adapter 调用搜索引擎并以 `IR.tool_result` 注入消息；
   - Provider 不支持搜索：返回 400，错误码 `builtin_tool_not_supported`。
5. WHEN 客户端在 Responses 请求中启用 `code_interpreter` 或 `file_search` 内置工具，THE Gateway SHALL 优先选择支持这些工具的 Provider；不支持时返回 400，错误码 `builtin_tool_not_supported`。
6. WHEN Responses 客户端请求流式响应，THE Gateway SHALL 按 Responses event 顺序转发：`response.created` → `response.in_progress` → `response.output_text.delta` → `response.output_item.added` → `response.output_item.done` → `response.completed`，保持 event 类型与 `response` 对象引用一致。
7. WHEN Gateway 完成一个 Responses 请求，THE Gateway SHALL 将响应主体（含 `output` 数组与 `id`）持久化到 `response_cache` 表，TTL 默认 24 小时，可由 Key 的 `responseCacheTtlSeconds` 字段覆盖。

### Requirement 13 — 响应缓存（Exact Cache）

**User Story:** 作为成本敏感的应用负责人，我希望完全相同的请求（同 model、同 messages、同关键参数）在短时间内重复到达时直接返回缓存响应，这样重复调用零上游成本、近零延迟。

#### Acceptance Criteria

1. WHEN 管理员在全局或 Key 级开启 `cacheEnabled`（默认开启）且请求为非流式，THE Gateway SHALL 以请求指纹（model + 规范化 messages + temperature + top_p + max_tokens + tools + tool_choice + response_format 的稳定序列化 SHA-256）为键查询缓存，命中且未过期时直接返回缓存响应并附加 `X-Gateway-Cache: hit` 头。
2. WHEN 缓存未命中且请求成功完成，THE Gateway SHALL 将响应写入缓存，TTL 由 `cacheTtlSeconds`（默认 300）控制，并附加 `X-Gateway-Cache: miss` 头。
3. WHEN 客户端请求中包含 `stream: true`，THE Gateway SHALL 跳过缓存写入与命中路径（流式响应可变性强，缓存语义复杂），头标记为 `X-Gateway-Cache: bypass`。
4. WHEN 客户端请求中包含随机性特征字段（temperature > 0 的采样场景除外）、`seed` 字段存在时，THE Gateway SHALL 将 seed 纳入指纹参与哈希。
5. WHEN 缓存命中，THE Gateway SHALL 照常记录一条 usage（costUSD=0、cacheHit='exact'），保证用量表完整反映所有请求。
6. WHEN 缓存条目数达到 `cacheMaxEntries`（默认 1000），THE Gateway SHALL 按 LRU 淘汰最久未命中条目。
7. WHEN 管理员调用 `DELETE /admin/api/cache`，THE Gateway SHALL 清空全部 Exact Cache 条目并返回清空数量。
8. WHEN 缓存命中且原始响应包含工具调用，THE Gateway SHALL 仅在请求指纹包含 tools 与 tool_choice 的完整序列化时允许命中，避免工具定义差异导致的错误复用。
### Requirement 14 — Roadmap（二期，本期不实现）

**User Story:** 作为产品负责人，我希望明确二期演进方向与全球标杆（Portkey、LiteLLM、Cloudflare、Vercel、Kong AI Gateway）的对齐路径，这样一期范围可控、二期有清晰路线。

#### Scope Boundaries（本期明确不做）

1. **Semantic Cache（语义缓存）**：基于 embedding 相似度（如 cosine > 0.95）命中缓存。二期实现，接口位已在一期 Exact Cache 的 `cacheHit` 枚举（exact/semantic）中预留。
2. **Guardrails 插件框架**：请求/响应内容安全过滤、PII 脱敏注入、主题拦截。二期以 middleware 插件形式实现。
3. **MCP（Model Context Protocol）支持**：Agent 工具访问控制层。二期评估。
4. **Prompt 管理与版本化**：Prompt 模板库、版本对比、灰度。二期评估。
5. **多实例集群模式**：一期为单进程 SQLite；二期评估 SQLite WAL 多读 + 配置导出同步或 Postgres 后端。
6. **A/B 实验语义**：一期 WeightedRandom 已具备流量切分能力；二期在其上叠加固定分桶（cookie/header sticky）与统计面板。
