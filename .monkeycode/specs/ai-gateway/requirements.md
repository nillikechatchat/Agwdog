# Requirements Document — AI Gateway

## Introduction

`ai-gateway` 是一个本地优先的 npm 包形态 AI API 网关，把多个上游大模型 API 聚合为一个统一入口。它对 OpenAI Chat Completions、Anthropic Messages、Google Gemini GenerateContent 三类主流协议以及豆包/文心等国产特色协议进行请求与响应互转，统一鉴权、虚拟模型路由、故障转移、用量统计与价格管理，并通过 HTTP 服务暴露给任何 OpenAI/Anthropic 兼容 SDK 直接调用。

包以单一 Node.js 进程运行，零外部依赖服务（可选 SQLite 持久化），`npx ai-gateway` 即可启动；提供 CLI、Web 管理后台与 REST API 三种管理面。

## Glossary

- **Gateway**：本文档中所述的 `ai-gateway` 本地服务进程。
- **Upstream Provider**：接入 Gateway 的上游模型服务方，例如 OpenAI、Anthropic、Google Gemini、字节豆包、百度文心、阿里通义、DeepSeek、月之暗面、智谱、本地 Ollama 等。
- **Provider Protocol**：上游 Provider 使用的原生 API 协议，包含 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent、Doubao Ark、Wenxin AccessToken、OpenAI-Compatible 六类。
- **Client Protocol**：调用方发送给 Gateway 的协议。Gateway 必须支持 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent 三种 Client Protocol 入口。
- **Virtual Model**：用户在 Gateway 管理后台创建、由若干真实 Upstream Model 组合而成的逻辑模型名，可指定路由策略。
- **Routing Strategy**：将请求分发到 Virtual Model 中某个 Upstream Model 的策略，包含 Round Robin、Weighted Random、Failover、Lowest Latency 四种。
- **Probe**：Gateway 对 Upstream Model 发起的可用性探测请求，记录延迟、HTTP 状态码与失败原因。
- **Virtual Key**：Gateway 颁发的、客户端在调用 Gateway 时使用的鉴权凭证。
- **SSE**：Server-Sent Events，本文档中专指 OpenAI/Anthropic/Gemini 三家流式响应协议。
- **Token Usage**：请求消耗的输入、输出、缓存 Token 数，由 Gateway 从上游响应中提取或估算。
- **Price Table**：以 USD / 1M tokens 为单位的输入/输出价格表，用于用量计费。
- **Admin Token**：用于访问 Gateway 管理后台与 REST API 的管理员令牌。

## Requirements

### Requirement 1 — 统一多协议入口

**User Story:** 作为 AI 应用开发者，我希望用 OpenAI/Anthropic/Gemini 三种 SDK 任意一种直接调用 Gateway，这样不必为每个上游 Provider 维护独立客户端。

#### Acceptance Criteria

1. WHEN 客户端以 OpenAI Chat Completions 协议调用 Gateway 的 `POST /v1/chat/completions`，THE Gateway SHALL 返回 OpenAI Chat Completions 协议语义一致的成功响应或错误响应。
2. WHEN 客户端以 Anthropic Messages 协议调用 Gateway 的 `POST /v1/messages`，THE Gateway SHALL 返回 Anthropic Messages 协议语义一致的成功响应或错误响应。
3. WHEN 客户端以 Gemini GenerateContent 协议调用 Gateway 的 `POST /v1beta/models/{model}:generateContent`，THE Gateway SHALL 返回 Gemini GenerateContent 协议语义一致的成功响应或错误响应。
4. WHEN 客户端发送 SSE 流式请求，THE Gateway SHALL 将上游响应原样或经转换后以 SSE 帧的形式转发给客户端，事件顺序与上游保持一致。
5. WHEN 客户端请求 `GET /v1/models`，THE Gateway SHALL 返回所有已启用 Virtual Model 与真实 Upstream Model 的列表，字段包含 id、object、created、owned_by、type。

### Requirement 2 — 上游 Provider 接入

**User Story:** 作为平台运维者，我希望把任意数量的 Upstream Provider 接入 Gateway，包括官方直连、OpenAI 兼容中转以及豆包/文心等私有协议厂商，这样所有模型都可在一个面板管理。

#### Acceptance Criteria

1. WHEN 管理员在 Web 后台或 `POST /admin/providers` 添加一个 Provider，THE Gateway SHALL 在数据层持久化该 Provider 的 id、name、protocol、baseUrl、apiKey 与模型列表。
2. WHEN Provider 的 protocol 为 `OpenAI-Compatible` 或 `OpenAI`，THE Gateway SHALL 通过 `GET {baseUrl}/models` 自动拉取上游模型列表并写入 Provider 的 models 字段。
3. WHEN Provider 的 protocol 为 `Anthropic`，THE Gateway SHALL 通过调用 `POST {baseUrl}/v1/messages` 携带轻量提示词完成模型列表同步，结果以 (modelId, displayName) 形式持久化。
4. WHEN Provider 的 protocol 为 `Gemini`，THE Gateway SHALL 通过 `GET {baseUrl}/v1beta/models` 拉取上游模型列表并写入 Provider 的 models 字段。
5. WHEN Provider 的 protocol 为 `Doubao` 或 `Wenxin`，THE Gateway SHALL 使用 Provider 配置中显式声明的模型列表，不主动探测上游模型目录。
6. WHEN 管理员删除一个 Provider，THE Gateway SHALL 同时删除该 Provider 下所有关联的 Upstream Model、Probe 记录与路由引用。

### Requirement 3 — 三协议请求与响应互转（含 Claude Code 兼容）

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

### Requirement 4 — Virtual Model 与路由策略

**User Story:** 作为平台用户，我希望把若干上游模型组合为一个 Virtual Model 并按策略自动路由，这样主模型故障时业务不中断、不同场景可走不同模型。

#### Acceptance Criteria

1. WHEN 管理员创建一个 Virtual Model 并选择至少一个 Upstream Model 作为成员，THE Gateway SHALL 持久化该 Virtual Model 及其 strategy 字段。
2. WHEN 客户端请求中的 model 字段命中某个 Virtual Model，THE Gateway SHALL 按该 Virtual Model 的 strategy 字段选择一个 Upstream Model 进行实际转发。
3. WHEN strategy 为 `Round Robin`，THE Gateway SHALL 按请求到达顺序在成员间循环选择，并在同一 Virtual Model 实例内保持计数单调递增。
4. WHEN strategy 为 `Weighted Random`，THE Gateway SHALL 按成员 weight 字段计算累计权重并按均匀随机抽样选择成员，所有成员的 weight 之和必须大于零，否则返回 400 错误。
5. WHEN strategy 为 `Failover`，THE Gateway SHALL 按成员 priority 升序选择首个可用成员；当首选成员在最近一次 Probe 中被标记为 unavailable，THE Gateway SHALL 跳过该成员选择次选。
6. WHEN strategy 为 `Lowest Latency`，THE Gateway SHALL 选择最近 N 次 Probe 中平均延迟最低且状态为 available 的成员，N 默认取 5，可由 Virtual Model 的 latencyWindow 字段覆盖。
7. WHEN strategy 为 `Failover` 且所有成员均标记为 unavailable，THE Gateway SHALL 返回 502 错误体，错误码为 `all_upstreams_unavailable`。

### Requirement 5 — 鉴权与 Virtual Key

**User Story:** 作为平台管理员，我希望为团队成员颁发 Virtual Key 并能随时吊销，这样不同应用与不同成员的用量可独立计量与限额。

#### Acceptance Criteria

1. WHEN 管理员调用 `POST /admin/keys` 创建 Virtual Key，THE Gateway SHALL 返回明文 Key 一次并仅持久化其 SHA-256 摘要。
2. WHEN 客户端调用 Gateway 时未携带 Authorization 头或 Key 无效，THE Gateway SHALL 返回 401 错误。
3. WHEN 管理员调用 `DELETE /admin/keys/:id` 吊销 Key，THE Gateway SHALL 将该 Key 标记为 revoked，后续使用该 Key 的请求返回 401 错误。
4. WHEN Key 上配置了 rpm 或 tpm 限额且当前窗口内累计超过限额，THE Gateway SHALL 返回 429 错误并附带 `Retry-After` 头。
5. WHEN Key 上配置了 allowedModels 白名单且请求的 model 不在白名单内，THE Gateway SHALL 返回 403 错误。

### Requirement 6 — Probe、可用性与故障转移

**User Story:** 作为平台运维者，我希望 Gateway 自动持续探测上游模型可用性并在故障时自动跳过，这样线上请求不会被不可用模型拖慢。

#### Acceptance Criteria

1. WHEN 管理员在配置中设置 `probeIntervalMinutes` 大于 0，THE Gateway SHALL 按该间隔对所有启用 Upstream Model 执行 Probe，并在数据层记录每次 Probe 的 latency、statusCode、success、errorMessage、probedAt。
2. WHEN Probe 连续失败次数达到 `failureThreshold`（默认 3），THE Gateway SHALL 将该 Upstream Model 标记为 unavailable 并停止将其纳入路由选择。
3. WHEN Probe 在 unavailable 状态下连续成功次数达到 `recoveryThreshold`（默认 2），THE Gateway SHALL 将该 Upstream Model 重新标记为 available 并恢复路由资格。
4. WHEN 真实请求收到 Provider 返回的 5xx 或网络超时错误，THE Gateway SHALL 将该 Upstream Model 的连续失败计数加一并按 Requirement 6.2 的规则触发降级。
5. WHEN 真实请求收到 Provider 返回的 4xx 错误（除 408 与 429），THE Gateway SHALL 不修改 Upstream Model 的可用性状态，原样回传错误体给客户端。
6. WHEN 客户端请求是流式且中途 Provider 连接断开，THE Gateway SHALL 在 SSE 流尾追加一条 Client Protocol 的 error 事件，type 字段为对应 Provider 错误类型，并在 `data: [DONE]` 之前发送。

### Requirement 7 — 用量统计与价格管理

**User Story:** 作为财务与产品负责人，我希望按 Key / Virtual Model / Upstream Model / 日期四个维度查看 Token 与费用消耗，这样能准确分摊成本与优化调用。

#### Acceptance Criteria

1. WHEN 任意请求成功完成（流式请求以 `[DONE]` 为完成标志），THE Gateway SHALL 将本次请求的 promptTokens、completionTokens、cachedTokens、totalTokens、costUSD、keyId、virtualModelId、upstreamProviderId、upstreamModelId、latencyMs、statusCode、probedAt 写入数据层 usage 表。
2. WHEN 请求中 Provider 未在响应体内返回 usage 字段，THE Gateway SHALL 按本地估算规则（字符数 / 4 向下取整）补齐 promptTokens 与 completionTokens 并将 source 字段标记为 `estimated`。
3. WHEN 管理员调用 `GET /admin/usage?groupBy=day&range=7d`，THE Gateway SHALL 返回按日期聚合的 promptTokens、completionTokens、costUSD、requestCount 列表。
4. WHEN 管理员调用 `GET /admin/usage?groupBy=model&range=30d`，THE Gateway SHALL 返回按 upstreamModelId 聚合的 costUSD 与 token 列表，按 costUSD 降序排列。
5. WHEN 管理员调用 `GET /admin/usage?groupBy=key&range=today`，THE Gateway SHALL 返回按 keyId 聚合的 costUSD、requestCount、rpm、tpm 列表。
6. WHEN 管理员在 Provider 配置中设置了 inputPricePerMTokensUSD 与 outputPricePerMTokensUSD，THE Gateway SHALL 按 USD / 1M tokens 计价并将每条 usage 记录的 costUSD 字段写入。
7. WHEN 管理员在 Provider 配置中设置了 cachedInputPricePerMTokensUSD，THE Gateway SHALL 将 cachedTokens 按该价格计入 costUSD。

### Requirement 8 — 管理面与可观测性

**User Story:** 作为平台管理员，我希望通过 Web 管理后台完成所有配置，并通过管理 API 集成到自有运维系统。

#### Acceptance Criteria

1. WHEN 管理员启动 Gateway 后访问 `http://{host}:{port}/admin`，THE Gateway SHALL 返回 Web 管理后台的 SPA 入口。
2. WHEN 管理员使用正确的 Admin Token 访问 `GET /admin/api/*`，THE Gateway SHALL 通过鉴权并返回 JSON 响应；当 Token 缺失或错误，THE Gateway SHALL 返回 401。
3. WHEN Gateway 启动成功，THE Gateway SHALL 输出一行结构化启动日志，包含 version、listenHost、listenPort、adminEnabled、dataDir、uptimeMs。
4. WHEN 任意请求完成，THE Gateway SHALL 追加一条结构化访问日志，包含 requestId、keyId、virtualModelId、upstreamModelId、latencyMs、statusCode、promptTokens、completionTokens。
5. WHEN 管理后台展示用量图表，THE Gateway SHALL 提供 `GET /admin/api/usage/timeseries?bucket=hour&range=24h` 接口，返回以 bucketStart 为键的聚合序列。

### Requirement 9 — 部署与生命周期

**User Story:** 作为开发者，我希望以最少步骤安装、启动、停止、升级 Gateway，并且所有配置可通过文件或环境变量注入。

#### Acceptance Criteria

1. WHEN 用户执行 `npx ai-gateway`，THE Gateway SHALL 启动 HTTP 服务并监听 `PORT` 环境变量（默认 3000）上的全部端口。
2. WHEN 用户执行 `npx ai-gateway --config <path>`，THE Gateway SHALL 读取该路径下的 JSON 配置文件并以文件配置覆盖默认配置。
3. WHEN 用户执行 `npx ai-gateway --import <path>`，THE Gateway SHALL 从该 JSON 文件导入 Provider / Virtual Model / Key 配置而不启动服务。
4. WHEN 用户向运行中进程发送 `SIGTERM`，THE Gateway SHALL 等待所有进行中流式请求结束（最长 30 秒）后安全关闭并释放监听端口。
5. WHEN 进程启动时检测到数据目录中已存在旧 schema 的 SQLite 数据库，THE Gateway SHALL 执行 schema 迁移并在迁移失败时拒绝启动并打印明确错误信息。

### Requirement 10 — 安全与隔离

**User Story:** 作为企业安全负责人，我希望所有上游 API Key 不落明文、所有外部调用有超时与重试上限、所有错误不泄露上游凭据。

#### Acceptance Criteria

1. WHEN 上游 API Key 写入数据层时，THE Gateway SHALL 使用 AES-256-GCM 加密存储，密钥来源于 `GATEWAY_MASTER_KEY` 环境变量或首次启动时随机生成的本地密钥。
2. WHEN 任何错误响应体构造时，THE Gateway SHALL 仅暴露 Provider 返回的错误 message 与 code 字段，不包含 Authorization、X-Api-Key、Bearer 等鉴权字段。
3. WHEN Gateway 发起上游请求，THE Gateway SHALL 设置 connectTimeoutMs（默认 5000）、requestTimeoutMs（默认 60000）、maxRetries（默认 1，由 Retry-After 触发）三项硬性约束。
4. WHEN 客户端请求中包含敏感字段（Authorization、Cookie、X-Api-Key），THE Gateway SHALL 在日志输出前将其替换为 `***`。
5. WHEN 管理员启用 `adminEnabled=false`，THE Gateway SHALL 完全禁用 Web 管理后台与管理 REST API，但不影响 `POST /v1/chat/completions` 等客户端协议入口。

### Requirement 11 — Claude Code / Cursor / Cline 兼容矩阵

**User Story:** 作为使用 Claude Code、Cursor、Cline、Cherry Studio 等 IDE 工具的开发者，我希望将这些工具的 API Base URL 改为指向 Gateway 即可工作，不必修改工具源码。

#### Acceptance Criteria

1. WHEN Claude Code 以 Anthropic Messages 协议向 Gateway 发送包含 Read/Bash/Edit 等内置工具的请求，THE Gateway SHALL 完整保留 tool schema 与 tool_use_id，并在流式响应中按 Anthropic input_json_delta 顺序回写工具输入。
2. WHEN 客户端请求体中包含 Anthropic 特有的 `metadata.user_id` 或 `anthropic-beta` 头，THE Gateway SHALL 将其作为透传头转发至 Anthropic Provider，并在非 Anthropic Provider 上忽略并写入 `X-Gateway-Warnings`。
3. WHEN 客户端使用 Cursor 的 OpenAI 兼容协议调用并要求 `stream: true`，THE Gateway SHALL 保持 SSE 帧格式与 OpenAI chat.completions 一致，确保 Cursor 解析器能识别 `delta.content` 与 `finish_reason`。
4. WHEN 客户端使用 Cline 调用并请求 tools，THE Gateway SHALL 保证 tool_calls 数组在每个流式 chunk 中按 OpenAI 规范使用 tool_calls.index 增量索引。
5. WHEN 任意 IDE 工具发起 max_tokens 超过 Provider 上限的请求，THE Gateway SHALL 在 Provider 返回 400 时将错误体按 Client Protocol 重新构造并保留原始 message。