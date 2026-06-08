# Agent 底层引擎 — 三人任务拆分方案

> 基于 box-allinone/packages/cocode 架构分析，按最小耦合原则拆分为三个模块。

---

## 总体架构

```
A (LLM Gateway)  ←—interface—→  B (Agent Core)  ←—interface—→  C (Tool System)
```

- B 是中枢，同时依赖 A 和 C 的接口
- A 和 C 之间零依赖，可完全并行开发
- 第一步：三方坐下来定好 3 个 interface，写成 `.ts` 文件各自 import

---

## 人员 A：LLM 网关层（Adapter + Streaming + Session）

**职责**：把"调模型"做成黑盒，对上层只暴露 `complete(messages) → Stream<Chunk>`。

### 包含模块

| 模块 | 说明 |
|------|------|
| LLM Adapter 抽象 | `BaseAdapter` + 各厂商实现（OpenAI / Anthropic / Venus / Ollama 等） |
| Streaming 管线 | SSE 推送、flush 策略、TTFT 追踪、text_delta/tool_call 流式解析 |
| Model Config | 模型能力表、别名路由、远程 capabilities 拉取与定时刷新 |
| Session 持久化 | 消息历史 CRUD、SQLite 存储、会话管理 |

### 对外接口

```ts
interface LLMGateway {
  complete(req: {
    messages: Message[]
    model: string
    tools?: ToolDef[]
    stream: boolean
  }): AsyncIterable<StreamEvent>

  getSession(sessionId: string): Session | null
  saveMessage(sessionId: string, msg: Message): Promise<void>
}
```

### 参考代码（cocode 中的对应位置）

- `packages/cocode/src/adapters/base.ts` — Adapter 抽象基类
- `packages/cocode/src/adapters/venus.ts` — Venus 平台适配器（OpenAI 兼容）
- `packages/cocode/src/adapters/factory.ts` — 适配器工厂
- `packages/cocode/src/adapters/model-config-store.ts` — 远程模型能力拉取
- `packages/cocode/src/core/streaming/service.ts` — 流式处理
- `packages/cocode/src/core/streaming/handler.ts` — StreamHandler 增量解析

---

## 人员 B：Agent 核心引擎（Loop + Context + Registry）

**职责**：Agent 的"大脑"——循环调度、上下文管理、系统提示词拼装。只依赖 A 的接口调模型，调用 C 注册的工具。

### 包含模块

| 模块 | 说明 |
|------|------|
| Agent Loop | `process()` while 循环，think→act→observe，最大轮次控制，80% 轮次警告 |
| Context Builder | token 预算管理、历史压缩、progressive tool loading（按需加载工具 schema） |
| System Prompt 拼装 | capabilities 块、规则注入、skill/agent 列表渲染 |
| Agent Factory / Registry | 模式切换（craft/ask/plan）、自定义 agent 加载（JSON + markdown） |
| ConfigurableAgent | 统一可配置 agent 实现，不区分主/子 agent |

### 对外接口

```ts
interface AgentEngine {
  run(sessionId: string, userMessage: Message): AsyncIterable<AgentEvent>
  registerTool(tool: ToolDefinition): void
}
```

### 参考代码（cocode 中的对应位置）

- `packages/cocode/src/agent/base.ts` — BaseAgent 核心实现，`process()` 在约第 902 行
- `packages/cocode/src/agent/factory.ts` — AgentFactory
- `packages/cocode/src/agent/registry.ts` — AgentRegistry 三层加载
- `packages/cocode/src/agent/configurable-agent.ts` — ConfigurableAgent
- `packages/cocode/src/agent/definition.ts` — AgentDefinition 数据结构
- `packages/cocode/src/agent/craft.ts` / `ask.ts` — 模式子类

---

## 人员 C：工具系统（Execution + Hooks + MCP + Builtins）

**职责**：所有"动手"的事情——工具执行、安全钩子、MCP 集成、内置工具实现。

### 包含模块

| 模块 | 说明 |
|------|------|
| Tool Execution Service | 工具调度、并行执行、超时控制 |
| Hook Chain | 安全检查、泄露检测、代码文件保护、域名路由等（8 个 hook 的完整链路） |
| MCP Manager | `mcporter` 子进程管理、server 配置三层加载（builtin > user > project） |
| 内置工具 | web_search（5 级 fallback）、web_fetch（SSRF + Readability）、image（UI-TARS 坐标检测 + OCR）、file ops、execute_command 等 |

### 对外接口

```ts
interface ToolExecutor {
  execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
  listTools(): ToolSummary[]
  getToolSchema(name: string): ToolSchema
}
```

### 参考代码（cocode 中的对应位置）

- `packages/cocode/src/tools/execution-service.ts` — ToolExecutionService 调度与并行
- `packages/cocode/src/tools/tool-hooks.ts` — Hook 接口与 4 状态机制
- `packages/cocode/src/tools/mcp/manager.ts` — MCPManager（mcporter 子进程）
- `packages/cocode/src/tools/mcp/config.ts` — MCP 三层配置加载
- `packages/cocode/src/tools/builtin/web/web_search.ts` — 5 级搜索 fallback
- `packages/cocode/src/tools/builtin/web/web_fetch.ts` — SSRF 防护 + HTML 转 Markdown
- `packages/cocode/src/tools/builtin/media/image.ts` — UI-TARS 坐标检测 + OCR
- `packages/cocode/src/tools/tool-summary.ts` — 渐进式工具加载摘要

---

## 推荐开发节奏

### 第 1 周：接口定义 + 最小骨架

- 三人一起定义 3 个 interface 文件（`LLMGateway`、`ToolExecutor`、`AgentEngine`）
- A：最小 adapter，先只接 OpenAI，能返回文本即可
- C：最小 executor，先只支持 `read_file` 一个工具
- B：loop 骨架，用 mock 跑通 think→act→observe 单轮

### 第 2-3 周：各自丰满

- A：加 streaming、多模型适配（Anthropic / Venus）、session 持久化
- B：加 context 管理（token 预算 + 压缩）、system prompt 拼装、agent registry
- C：加 MCP 集成、hook chain、更多内置工具（web_search / web_fetch / image）

### 第 4 周：集成联调

- 端到端跑通完整循环：用户输入 → Agent 思考 → 调用工具 → 观察结果 → 继续思考
- 重点测试：流式输出、工具并行执行、上下文压缩、错误恢复

---

## 接口契约原则

1. **接口文件共享但不互相依赖实现**：A、B、C 各自只 import interface，不 import 对方的 .ts 实现文件
2. **签名先行，实现后置**：改签名必须三方同意，改实现各自自由
3. **Mock 驱动**：开发早期用 mock 实现对方接口，不阻塞自己的进度
4. **集成在 B**：最终由 B 负责把 A 和 C 的真实实现装配起来，跑通全链路
