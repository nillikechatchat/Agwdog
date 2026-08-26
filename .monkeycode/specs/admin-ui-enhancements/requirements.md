# Requirements Document — Admin UI Enhancements

## Introduction

为 AI Gateway 管理后台添加三个增强功能：Provider 编辑能力、图表可视化、移动端响应式布局。所有功能在单文件 HTML + 原生 JS 实现，无外部依赖。

## Glossary

- **Provider**: 上游模型服务方（OpenAI、Anthropic 等）
- **Dashboard**: 系统概览面板，显示请求统计和成本数据
- **Chart**: 可视化图表，使用 Canvas API 绘制
- **Responsive**: 根据屏幕宽度自动调整布局的样式设计

## Requirements

### Requirement 1 — Provider 编辑功能

**User Story:** 作为平台运维者，我希望能够编辑已有 Provider 的配置（名称、协议、Base URL、API Key、价格），这样可以在不删除重建的情况下更新 Provider 设置。

#### Acceptance Criteria

1. WHEN 用户点击 Provider 卡片的 "Edit" 按钮，THE UI SHALL 打开包含当前 Provider 所有字段的可编辑表单模态框
2. WHEN 用户修改名称、协议或 Base URL 并提交，THE API SHALL 发送 PATCH 请求到 `/admin/api/providers/{id}`，THE Server SHALL 更新数据库记录
3. IF 用户修改 API Key，THE Server SHALL 使用 AES-256-GCM 重新加密并存储，原始密钥不应出现在任何响应中
4. IF 用户清空 API Key 字段，THE Server SHALL 保留现有加密密钥不变
5. WHEN 保存成功，THE UI SHALL 显示成功 Toast 提示并刷新 Provider 列表
6. IF API 返回错误，THE UI SHALL 显示错误 Toast 提示并不关闭模态框

### Requirement 2 — 图表可视化

**User Story:** 作为平台运维者，我希望在 Dashboard 看到请求量和成本的趋势图表，这样能够快速识别流量模式和成本变化。

#### Acceptance Criteria

1. WHEN Dashboard 加载统计数据，THE UI SHALL 渲染一个柱状图显示最近 7 天的请求量趋势
2. WHEN 图表数据可用，THE UI SHALL 使用 Canvas API 绘制，不引入外部图表库
3. WHILE 图表渲染，THE UI SHALL 显示 X 轴日期标签和 Y 轴数值刻度
4. WHEN 鼠标悬停在柱状图上，THE UI SHALL 显示工具提示包含日期和具体数值
5. IF 数据为空，THE UI SHALL 显示占位文本 "No data available"
6. WHEN 窗口大小改变，THE Chart SHALL 自适应重新绘制

### Requirement 3 — 移动端响应式布局

**User Story:** 作为移动设备用户，我希望在手机上也能方便地访问管理后台，侧边栏能够折叠并通过汉堡菜单展开。

#### Acceptance Criteria

1. WHEN 屏幕宽度小于 768px，THE Sidebar SHALL 隐藏并显示汉堡菜单按钮
2. WHEN 用户点击汉堡菜单，THE Sidebar SHALL 滑出覆盖主要内容区域
3. WHEN 用户点击导航项，THE Sidebar SHALL 自动收起
4. WHEN 用户点击遮罩层，THE Sidebar SHALL 关闭
5. WHILE Sidebar 展开，THE Main content  SHALL 添加适当内边距避免被遮挡
6. WHEN 屏幕宽度恢复到 768px 以上，THE Sidebar SHALL 始终可见，汉堡菜单隐藏

## Non-Functional Requirements

- 所有功能在单一 HTML 文件内实现，无构建步骤
- 保持现有深色主题设计风格一致
- 图表使用纯 Canvas API，不引入第三方库
- 响应式断点：768px（tablet/mobile 分界）
