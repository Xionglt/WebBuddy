# Web Agent Console 功能变更说明

记录时间：2026-06-18

关联提交：`2b2ce0e feat: add web agent trace console`

## 1. 目标

这次 diff 的目标是把原来的命令行 Claude Code runtime + Playwright MCP 流程，包装成一个更接近 Codex 体验的 Web Agent Console：

- 用户可以在浏览器中配置目标 URL、任务 prompt、简历文件、模型 endpoint、max turns 和 allowed domains。
- Web 页面可以启动、停止、继续 agent 运行，并实时展示任务进度。
- 每次运行都能落盘细粒度 trace，方便复盘 LLM 输出、工具调用、runtime 事件和运行结果。
- Alibaba 招聘投递流程可以通过 Web Console 触发，并支持登录/验证码等人工 handoff 后继续。

## 2. 新增能力

### 2.1 Agent Trace 模块

新增 `packages/playwright-mcp/src/agent-trace/` 模块，用于统一记录运行过程中的结构化 trace。

主要能力：

- 创建独立 trace session，并写入 `session.json`、`events.jsonl`、`spans.jsonl`。
- 记录 runtime event，例如 session start、runtime files、handoff、result。
- 记录 LLM stream-json 输出，包含 assistant message、tool_use、tool_result、result 等事件。
- 记录 MCP/browser 工具调用 span，包含工具名、输入输出摘要、状态、耗时。
- 预留 skill call / runtime event 等细粒度类型，后续可以继续扩展。
- 默认对 trace 中的敏感字段做摘要和部分脱敏，避免普通 UI 直接泄漏 key。

关键文件：

- `packages/playwright-mcp/src/agent-trace/index.ts`
- `packages/playwright-mcp/src/agent-trace/stream-json.ts`
- `packages/playwright-mcp/src/sdk/trace.ts`
- `packages/playwright-mcp/src/sdk/llm.ts`
- `packages/playwright-mcp/src/tools/index.ts`

### 2.2 Claude Runtime Web Runner

扩展 `scripts/claude-runtime-alibaba.mjs`，让 Web server 能用它启动 Claude Code recovered runtime，并通过 Playwright MCP 操作网页。

主要能力：

- 支持 `--preset generic|alibaba`，同一个 runner 可以跑通用网页任务或阿里招聘任务。
- 支持 `--resume <path>`，把用户提供的简历路径传入任务。
- 支持 `--allowed-domains`，约束目标域名和登录跳转域名。
- 支持 `--handoff-mode terminal|file` 和 `--continue-file`，让 Web UI 可以在登录/验证码阶段暂停，用户处理后继续。
- 支持 `--no-resume`，避免默认复用旧 runtime 会话造成上下文污染。
- 输出 stream-json，并接入 trace 模块落盘。

关键文件：

- `packages/playwright-mcp/scripts/claude-runtime-alibaba.mjs`
- `packages/playwright-mcp/src/core/agent-loop.ts`

### 2.3 Web Agent Console

新增 Web Console 页面和后端 API，用浏览器界面管理 agent run。

主要能力：

- 左侧配置区：
  - Preset：`Generic` / `Alibaba`
  - Target URL
  - Task prompt
  - Resume path / file upload
  - Model endpoint
  - Model name
  - Max turns
  - API key
  - Allowed domains
  - Headless 开关
- 中间 timeline：
  - 实时显示 assistant thinking、tool_use、tool_result、handoff、result、exit 等事件。
  - blocked 时显示 Continue After Handoff。
  - done / failed / blocked 状态跟随 runtime 更新。
- 右侧 inspector：
  - 显示 runDir、traceDir、spanCount。
  - 展示最近 trace spans，包括 span 类型、名称、状态、耗时。
- 支持浏览器上传简历文件到本地 runtime 可读路径。
- 支持启动 run、继续 handoff、停止 run、刷新 trace。

关键文件：

- `packages/playwright-mcp/src/web/public/index.html`
- `packages/playwright-mcp/src/web/server.ts`
- `packages/playwright-mcp/package.json`

### 2.4 Web Server API

新增和扩展了一组 Web API：

- `GET /api/config`：读取当前模型配置、resume 默认路径和 key 状态。
- `POST /api/config`：保存当前 Web server 内存中的模型配置；空 key 不覆盖已有 key。
- `POST /api/resume`：接收浏览器上传的简历文件，保存到本地 output 目录。
- `POST /api/runtime/run`：启动一次 runtime run。
- `GET /api/runtime/events?id=...`：SSE 订阅运行事件。
- `POST /api/runtime/continue?id=...`：handoff 后继续任务。
- `POST /api/runtime/stop?id=...`：停止任务。
- `GET /api/runtime/trace?id=...`：读取 trace session 和 span。
- `GET /api/runtime/runs`：列出当前 Web server 进程内的 run。

## 3. 使用方式

在 `packages/playwright-mcp` 下启动：

```bash
npm run build
PORT=5179 node ./dist/web/server.js
```

打开：

```text
http://localhost:5179/
```

Alibaba 真实测试流程：

1. 选择 `Alibaba` preset。
2. 填入或上传简历。
3. 配置 Anthropic-compatible endpoint，例如 BigModel 的 `https://open.bigmodel.cn/api/anthropic`。
4. 填入 model，例如 `glm-4.7`。
5. 设置 allowed domains，例如 `talent-holding.alibaba.com,mozi-login.alibaba-inc.com`。
6. 点击 `Run Agent`。
7. 如果遇到登录、注册、短信验证码或扫码，用户在浏览器中处理后点击 `Continue After Handoff`。
8. 在 timeline 和 trace 面板观察执行过程。

## 4. 已验证内容

本次提交前验证过：

- `packages/playwright-mcp` 下 `npm run build` 通过。
- Web server 可以在 `5179` 启动。
- Web UI 可以配置 BigModel Anthropic-compatible endpoint。
- Web UI 可以启动 Alibaba preset run。
- 登录/注册类人工步骤可以通过 handoff 暂停，再由用户点击 Continue 继续。
- 运行结束后 trace 能落盘到 `output/traces/...`，runtime 原始输出能落盘到 `output/claude-runtime/...`。

## 5. 真实体验暴露的边界

这次 diff 已经能跑通 Web Console + runtime + trace 的 MVP，但真实阿里投递体验暴露了几个下一阶段必须优先修的问题：

1. 用户提供新简历后，当前实现仍可能直接使用网站账号里的已有简历投递。
2. 缺少 runtime 级提交闸门，不能保证上传、解析、字段检查完成后才允许最终提交。
3. `form_snapshot` 会把 `投递简历` 误识别成 upload hint，需要区分上传入口和提交按钮。
4. 浏览器会话关闭后，agent 可能过于乐观地输出 `AGENT_STATUS=COMPLETED`。
5. Web Console 左侧配置栏在长 timeline / 结束态下可能从视野中消失。
6. 本地可能同时存在多个 Web server 实例，导致不同端口的状态混淆。

这些问题已记录在 `docs/web-agent-console-issues.md`，并按 S0-S3 做了优先级拆分。

## 6. 后续推荐顺序

优先做 S0：

1. 实现 `resume-first` 投递状态机。
2. 在 tool wrapper 层拦截最终投递类高风险按钮。
3. 增加 Web UI 的真实提交确认弹窗。
4. 完成态改为必须依赖页面证据。
5. 对 timeline / stdout / trace 摘要做默认脱敏。

随后做 S1：

1. 固定三栏布局，避免左侧配置栏消失。
2. 中文化 handoff 和 blocked 状态。
3. 增加运行历史恢复。
4. 增加 heartbeat 和 max turns 不足的一键继续。
