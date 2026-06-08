# 网页操作智能体第一周开发计划

> 状态：DRAFT v0.1  
> 日期：2026-06-03  
> 适用范围：三人从 0 开始开发类似 OpenClaw / Claude Claw 的网页操作智能体  
> 目标：第一周跑通最小端到端闭环，而不是堆功能

---

## 1. 第一周总目标

第一周的核心目标只有一个：

> **三个人对齐接口、边界、调用链，并用 mock 跑通一个最小 Agent 闭环。**

到周末，系统至少应该能跑通下面这条链路：

```text
用户输入 URL + 自然语言任务
  -> B: AgentEngine.run()
  -> B: 构造上下文
  -> A: MockLLMGateway 返回 tool_call
  -> B: 校验 tool_call + PolicyGate
  -> C: MockToolExecutor 执行工具
  -> B: 接收 ToolResult 并写 trace
  -> A: MockLLMGateway 返回 final_answer
  -> B: 输出最终 AgentEvent
```

第一周不要求真的完成任意网页操作，但必须证明：

- 三个模块可以通过接口集成。
- Agent loop 可以完成 `observe -> think -> act -> observe -> final`。
- 工具调用、工具结果、失败、事件流可以标准化表达。
- 后续 A/C 换成真实模型和真实 Playwright 时，B 不需要大改。

---

## 2. 第一周最重要的对齐事项

### 2.1 三人必须先冻结 contracts

建议第一天就建立共享接口目录：

```text
packages/contracts/
  message.ts
  agent.ts
  llm.ts
  tool.ts
  policy.ts
  trace.ts
```

原则：

- A、B、C 都只能 import `contracts` 中的类型。
- 不允许 A import C 的实现。
- 不允许 C import A 的实现。
- B 负责集成，但也只能依赖 A/C 的接口。
- 接口签名变更必须三个人一起确认。

### 2.2 第一周必须定下的核心类型

第一周至少要定下这些类型：

```text
Message
AgentTask
AgentEvent
AgentDecision
LLMStreamEvent
ToolDefinition
ToolExecuteRequest
ToolResult
PolicyVerdict
TraceEvent
```

### 2.3 第一周必须对齐的行为语义

必须明确：

- LLM 如何表达“我要调用工具”。
- LLM 如何表达“任务完成”。
- Tool 成功和失败分别怎么返回。
- ToolResult 是否包含 `observation`、`data`、`error`、`artifacts`。
- B 遇到工具失败时是否继续下一轮。
- 最大步数是多少。
- 哪些动作需要确认。
- AgentEvent 如何给 CLI/UI 消费。

---

## 3. 三人职责边界

```text
A: LLM Gateway
  负责模型调用、streaming、结构化输出、mock LLM

B: Agent Core
  负责任务循环、上下文、状态机、PolicyGate、Trace、集成

C: Tool System
  负责工具注册、工具执行、mock browser tool、后续 Playwright
```

最重要的边界：

- A 不操作浏览器。
- C 不做任务规划。
- B 不写 Playwright 细节。
- B 是集成中心，但不是所有代码都写在 B。

---

## 4. A 同学第一周任务：LLM Gateway

### 4.1 第一周目标

A 的目标不是一口气支持所有模型，而是提供一个稳定的模型接口，让 B 可以先用 mock 跑通。

### 4.2 必做任务

1. 定义 `LLMGateway` 接口。
2. 定义 `CompleteRequest`、`StructuredRequest`、`LLMStreamEvent`。
3. 实现 `MockLLMGateway`。
4. Mock 能按脚本返回：
   - 第一次返回 `tool_call`。
   - 第二次返回 `final_answer`。
5. 如果时间允许，接一个真实 OpenAI-compatible 模型。
6. 支持基础 schema 校验或至少保留 `generateObject<T>()` 接口。

### 4.3 建议接口

```ts
export interface LLMGateway {
  complete(req: CompleteRequest): AsyncIterable<LLMStreamEvent>
  generateObject<T>(req: StructuredRequest<T>): Promise<T>
}
```

### 4.4 第一周交付物

```text
packages/llm-gateway/
  src/
    gateway.ts
    mock-gateway.ts
    openai-compatible-gateway.ts   # 可选
```

验收标准：

- B 可以注入 `MockLLMGateway`。
- B 可以拿到结构化 `AgentDecision`。
- mock 能稳定驱动一轮 tool call 和 final answer。

### 4.5 第一周不要做

不要做：

- 多模型路由。
- 成本优化。
- 复杂 fallback。
- 完整 session 持久化。
- 复杂 streaming parser。
- 多供应商能力表。

---

## 5. B 同学第一周任务：Agent Core

### 5.1 第一周目标

B 的目标是跑通最小主循环。B 是第一周最关键的集成点。

第一周 B 要证明：

```text
AgentEngine.run(task)
  -> 调 A
  -> 拿到 AgentDecision
  -> 过 PolicyGate
  -> 调 C
  -> 写 Trace
  -> 再调 A
  -> 输出 final_answer
```

### 5.2 必做任务

1. 定义 `AgentEngine` 接口。
2. 定义 `AgentTask`、`AgentEvent`、`AgentDecision`。
3. 实现 `AgentLoop` 最小版。
4. 实现 `TaskState`。
5. 实现 `ContextBuilder` 最小版。
6. 实现 `PolicyGate` 最小版。
7. 实现 `TraceWriter` 内存版。
8. 写一个集成测试或 CLI demo，把 A/C mock 串起来。

### 5.3 建议接口

```ts
export interface AgentEngine {
  run(task: AgentTask, options?: RunOptions): AsyncIterable<AgentEvent>
  abort(taskId: string): Promise<void>
  getTask(taskId: string): Promise<TaskSnapshot | null>
}
```

### 5.4 最小循环

```text
start task
  -> build context
  -> llm.generateObject()
  -> validate decision
  -> policyGate.evaluate()
  -> toolExecutor.execute()
  -> traceWriter.write()
  -> update state
  -> next llm.generateObject()
  -> final answer
```

### 5.5 建议目录

```text
packages/agent-core/
  src/
    engine.ts
    loop/
      agent-loop.ts
      state-machine.ts
    context/
      context-builder.ts
      prompt-builder.ts
    policy/
      policy-gate.ts
      risk-classifier.ts
    trace/
      trace-writer.ts
      trace-types.ts
    test/
      mock-integration.test.ts
```

### 5.6 第一周交付物

验收标准：

- `AgentEngine.run()` 可以被调用。
- 可以流式 yield `AgentEvent`。
- 可以注入 A 的 `MockLLMGateway`。
- 可以注入 C 的 `MockToolExecutor`。
- 可以跑通至少一个完整任务。
- 每一步有 trace。
- 最大步数生效。
- PolicyGate 至少能阻断明显高风险动作。

### 5.7 第一周不要做

不要做：

- 多 agent。
- 长期记忆。
- 复杂上下文压缩。
- ToolSearch。
- MCP。
- 完整权限系统。
- 复杂 UI。
- Playwright 细节。

---

## 6. C 同学第一周任务：Tool System

### 6.1 第一周目标

C 的目标是提供一个稳定的工具执行接口，并先用 mock browser tool 支撑 B 跑通闭环。

如果时间允许，再接 Playwright 的最小 `open` 和 `snapshot`。

### 6.2 必做任务

1. 定义 `ToolExecutor` 接口。
2. 定义 `ToolDefinition`、`ToolExecuteRequest`、`ToolResult`。
3. 实现 `ToolRegistry`。
4. 实现 `MockToolExecutor`。
5. Mock browser tools：
   - `browser.open`
   - `browser.snapshot`
   - `browser.click`
   - `browser.type`
   - `browser.wait`
6. 工具结果必须结构化返回。
7. 工具失败必须结构化返回，不允许直接 throw 到 B 无法理解。

### 6.3 建议接口

```ts
export interface ToolExecutor {
  execute(req: ToolExecuteRequest): Promise<ToolResult>
  listTools(): ToolSummary[]
  getToolSchema(name: string): ToolDefinition
}
```

### 6.4 ToolResult 必须包含

```ts
export interface ToolResult {
  ok: boolean
  observation: string
  data?: unknown
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
  artifacts?: ArtifactRef[]
}
```

### 6.5 建议目录

```text
packages/tool-system/
  src/
    executor.ts
    registry.ts
    mock-executor.ts
    tools/
      browser-open.ts
      browser-snapshot.ts
      browser-click.ts
      browser-type.ts
      browser-wait.ts
```

### 6.6 第一周交付物

验收标准：

- B 可以调用 `execute()`。
- `listTools()` 能返回工具摘要。
- `getToolSchema()` 能返回 JSON Schema。
- mock browser tool 能返回页面 observation。
- 工具失败有标准错误码。

### 6.7 第一周不要做

不要做：

- 完整 MCP。
- 大量内置工具。
- 复杂浏览器 profile。
- 文件上传。
- 任意 JS evaluate。
- 下载安全全套。
- 多浏览器后端。

---

## 7. 每日节奏建议

### Day 1：接口冻结日

目标：

- 三个人一起定 contracts。
- 确定 monorepo/package 结构。
- 确定命名规范。
- 确定最小 demo 场景。

当天必须产出：

```text
packages/contracts/
  message.ts
  agent.ts
  llm.ts
  tool.ts
  policy.ts
  trace.ts
```

当天不要写太多实现，重点是把接口定清楚。

### Day 2：Mock 实现日

A：

- 写 `MockLLMGateway`。

B：

- 写 `AgentEngine` 骨架。
- 写 `AgentLoop` 第一版。

C：

- 写 `MockToolExecutor`。
- 写工具注册表。

当天目标：

- 三个人各自模块可以编译。
- B 可以 import contracts。

### Day 3：端到端闭环日

B 主导集成：

```text
Mock LLM -> AgentLoop -> Mock Tool -> AgentLoop -> Mock LLM -> Final
```

当天必须产出：

- 一个测试或 CLI demo。
- 一份 sample trace。
- 一次完整运行记录。

### Day 4：替换真实能力日

A：

- 尝试接一个真实模型。

C：

- 尝试接 Playwright `browser.open` 和 `browser.snapshot`。

B：

- 不改 loop，只替换依赖实现。
- 修接口不顺的地方。

当天目标：

- 至少一个真实能力进入链路。

### Day 5：安全与可观测日

B/C：

- 加最小 PolicyGate。
- 加风险等级。
- 加最大步数。
- 加最大耗时。
- 加 trace 输出。

A：

- 加模型输出 schema 校验。

当天目标：

- demo 不只是能跑，还能看见每一步。
- 遇到高风险动作可以暂停或阻断。

---

## 8. 第一周 Demo 标准

建议第一周 demo 使用固定脚本，不追求真实网页泛化。

输入：

```json
{
  "startUrl": "https://example.com",
  "instruction": "搜索 pricing 并总结结果",
  "constraints": {
    "mode": "read_only",
    "maxSteps": 5
  }
}
```

期望事件流：

```text
task_started
decision: browser.open
tool_call: browser.open
tool_result: opened page
decision: browser.snapshot
tool_call: browser.snapshot
tool_result: page contains search box
decision: browser.type
tool_call: browser.type
tool_result: typed pricing
decision: final_answer
final_answer
```

验收标准：

- demo 可以一条命令跑起来。
- 输出事件顺序清楚。
- trace 可读。
- 任意一步失败时，有标准错误。

---

## 9. 第一周统一原则

### 9.1 先做通，再做聪明

第一周不要追求 agent 很智能。

先追求：

- 接口通。
- loop 通。
- mock 通。
- trace 通。
- 错误通。

### 9.2 接口比实现重要

第一周最容易出问题的不是某个函数不会写，而是三个人对数据结构理解不一样。

所以：

- Day 1 必须花足够时间定 contracts。
- 每个字段都要说清楚含义。
- 不确定的字段先 optional，但不要模糊。

### 9.3 B 是集成中心

B 要负责发现 A/C 接口不顺的地方，但不要越界写 A/C 的实现。

B 第一周最重要的产物不是复杂算法，而是：

```text
AgentLoop + Trace + PolicyGate + Mock Integration
```

### 9.4 安全从第一天就有壳子

即使第一版 PolicyGate 只有简单规则，也必须存在。

例如：

```text
submit / payment / delete / upload / email -> confirmation_required
unknown domain -> block
step > maxSteps -> fail
```

后续规则可以逐渐丰富。

---

## 10. 第一周完成定义

第一周结束时，如果满足下面条件，就算成功：

- `contracts` 已冻结第一版。
- A 有可用 `MockLLMGateway`。
- B 有可用 `AgentEngine.run()`。
- C 有可用 `MockToolExecutor`。
- 三者能跑通一个 mock 任务。
- AgentEvent 能被打印或消费。
- Trace 能看到每一步。
- ToolResult 成功/失败结构统一。
- PolicyGate 能处理至少 3 类风险动作。
- 第二周可以开始替换真实模型和真实浏览器。

如果没满足，第二周不要急着扩功能，先补齐闭环。

---

## 11. 一句话总结

第一周不是证明“我们能做一个很聪明的网页 Agent”，而是证明：

> **A、B、C 三个模块边界清楚，接口稳定，mock 端到端闭环能跑，后续真实模型和真实浏览器可以逐步替换进去。**

