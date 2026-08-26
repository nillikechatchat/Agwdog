# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Discovered while deploying web preview for the admin UI; user reported 404 errors on the preview page
- Category: Operations & Deployment
- Instructions:
  - Web 预览必须用 gateway 本身（`node dist/cli/index.js`，端口 3000）作为预览服务，UI 与 Admin API 同源。
  - 禁止用 `python3 -m http.server` 之类纯静态服务器预览本项目的 /admin 页面——静态服务器无法处理 /admin/api/* 请求（GET 404、POST 501），页面会大量报错。
  - 预览地址为 https://3000-07eda81e08ca1220.monkeycode-ai.online；后台终端 ID 见 background_terminal_list。

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Discovered while building the project across sessions
- Category: Build Methods
- Instructions:
  - 构建命令：`npm run build`（tsc -p tsconfig.build.json），零错误才算通过。
  - 测试命令：`npm test`（vitest run），当前基线 482 个测试、51 个文件全部通过。
  - TypeScript 开启 exactOptionalPropertyTypes + noUncheckedIndexedAccess：动态 JSON 对象属性访问必须用 `obj['key']` 形式（不能用点号），数组访问后需非空断言或可选链。

[User Instruction Summary]
- Date: 2026-08-26
- Context: 用户要求重构管理后台 UI 时提出
- Instructions:
  - 后台界面文案统一使用简体中文（导航、表单、表格、提示、确认框、空状态）。
  - UI 框架选用 Vue 3 本地 vendor 构建（web/vendor/vue.global.prod.js），保持项目"单文件 HTML、无构建步骤、离线可用"的约束；页面内通过 v-cloak 防闪、CDN 一律改本地引用。
