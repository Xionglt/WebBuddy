# Next Stage Plan and Agent Prompt: AgentRuntime Skeleton v1

日期：2026-06-25

## 1. 阶段定位

阶段名称：

```text
AgentRuntime Skeleton v1 / Phase 4A
```

上一阶段已经完成：

```text
Plan1: run identity / trace / metrics / agent-state / benchmark-simple
Plan2: Tool Catalog / local adapter / MCP adapter / PageState / FormState / ObservationManager
Plan3: ContextManager / Prompt Sections / recentActions / prompt budget / trace artifact 解耦
```

当前代码状态：

- 当前主线包是 `packages/web-buddy`。
- `packages/claude-code` 是恢复版 Claude Code runtime，只作为可选 adapter / 对照，不作为自研 runtime 主线。
- `packages/web-buddy/src/runtime/local/agent-loop.ts` 已经接入 ContextManager / Prompt Sections。
- `runAgentLoop` 仍是当前 local runtime 的实际执行入口。
- `sdk/orchestrator.ts` 仍直接调用 `runAgentLoop`。
- `agent-loop.ts` 仍同时承担：
  - prompt/context 组装
  - LLM tool-call loop
  - tool execution
  - gate / safety 判断
  - trace 记录
  - observation refresh
  - stop condition

本阶段目标：

> 在不破坏现有行为的前提下，新增一个轻量 `AgentRuntime` facade，把当前 agent-loop 包装成可演进的 runtime 入口，并先抽出最小 StopCondition / PromptAssembler 边界。

一句话：

```text
不要重写 agent-loop。
先给 agent-loop 套一个稳定的 AgentRuntime 外壳。
让后续 PolicyEngine / ToolExecutionService / WorkflowEngine 有挂载点。
```

---

## 2. 为什么先做 Phase 4A，而不是完整 Phase 4

`PLAN/plan-all.md` 的 Phase 4 提到：

- AgentRuntime
- PromptAssembler
- LoopController
- StopConditionManager
- ToolExecutionService
- PolicyEngine

但当前不适合一次性全做。

原因：

1. `agent-loop.ts` 刚刚完成 ContextManager / Prompt Sections 接入，需要保持行为稳定。
2. Tool execution 现在仍由 `ToolRegistry` + `local-adapter` 负责，MCP server 仍由 `mcp-adapter` 负责。
3. 如果立刻引入 `ToolExecutionService`，会牵动 local/MCP 两条执行路径，风险超过当前阶段收益。
4. Policy / gate 逻辑目前内嵌在 loop 中，直接抽出容易破坏 final submit safety gate。
5. `orchestrator.ts` 仍是多 mode 入口，直接切 Runtime 可能扩大改动面。

所以本阶段改为更小的 Phase 4A：

```text
Phase 4A:
  AgentRuntime facade
  PromptAssembler boundary
  StopConditionManager boundary
  agent-loop compatibility preserved

Phase 4B:
  Context selection metrics
  freshness metadata
  minimal TaskState

Phase 4C:
  ToolExecutionService / PolicyEngine extraction
```

Phase 4A 的核心收益：

- `AgentRuntime.run()` 成为未来统一入口。
- `runAgentLoop` 继续可用，避免破坏 CLI / Web UI / benchmark。
- 先建立 Runtime 类型、事件、结果、stop condition 的稳定结构。
- 后续迁移工具执行、policy、workflow 时，不再从零开始拆 loop。

---

## 3. 本阶段严格边界

必须遵守：

1. 不重写 `runAgentLoop` 主循环。
2. 不改变 `runAgentLoop` 对外接口。
3. 不改变 `ToolRegistry` 对外接口。
4. 不重写 local adapter / MCP adapter。
5. 不引入完整 `ToolExecutionService`。
6. 不抽完整 `PolicyEngine`。
7. 不做 Skill / Memory / 多 Agent。
8. 不做真实网站适配。
9. 不改 `packages/claude-code` 内部逻辑。
10. 不破坏现有 CLI / Web UI / MCP 工具名。
11. Runtime / ContextManager 不读取 trace artifacts。
12. trace artifacts 仍只能作为 Web UI / benchmark / debug / replay 的旁路输出。

允许：

1. 新增 `AgentRuntime` facade。
2. 新增 Runtime 类型定义。
3. 新增轻量 `StopConditionManager`。
4. 将 agent-loop 内部的 prompt helper 轻量搬到 `PromptAssembler`，前提是行为保持一致。
5. `orchestrator.ts` 可以先不切换到 `AgentRuntime.run()`，只通过测试证明 runtime facade 可用。
6. 如改 `orchestrator.ts`，只能做最小可选接入，不改变现有 mode 行为。

禁止：

```text
AgentRuntime -> readFileSync(output/traces/.../page-state-latest.json)
AgentRuntime -> readFileSync(output/traces/.../form-state-latest.json)
ContextManager -> trace artifacts
ToolExecutionService full rewrite
PolicyEngine full extraction
WorkflowEngine
SkillRegistry
MemoryStore
真实招聘网站专项逻辑
```

---

## 4. 当前基础

必须先阅读：

- `packages/web-buddy/src/runtime/local/agent-loop.ts`
  - 当前实际 loop。
  - 已有 ContextManager / Prompt Sections 接入。
  - 当前 gate、tool execution、trace、stop condition 都在这里。
- `packages/web-buddy/src/context/context-manager.ts`
  - ContextSnapshot 构造。
  - ObservationProvider 内存态读取。
- `packages/web-buddy/src/context/prompt-sections.ts`
  - PromptSection 顺序和预算。
- `packages/web-buddy/src/runtime/local/tool-registry.ts`
  - 当前 local tool facade。
- `packages/web-buddy/src/tools/local-adapter.ts`
  - 当前工具执行 handler。
- `packages/web-buddy/src/sdk/orchestrator.ts`
  - 当前 CLI / Web UI 统一业务入口。
- `packages/web-buddy/scripts/agent-loop-test.mjs`
  - 当前 mock LLM loop 集成测试。
- `packages/web-buddy/scripts/context-manager-test.mjs`
  - ContextManager trace 解耦测试。
- `packages/web-buddy/scripts/prompt-sections-test.mjs`
  - prompt section 顺序和预算测试。
- `packages/web-buddy/scripts/benchmark-simple.mjs`
  - benchmark-simple baseline。

当前关键事实：

- `runAgentLoop` 已经能通过 mock LLM 走 demo form。
- `ContextManager` 不读 trace artifacts。
- `pageView` fallback 仍必须保留，因为模型操作 browser refs 仍依赖 `[e1]` 这类 ref。
- `browser_snapshot` / `browser_form_snapshot` 刷新 ObservationManager 内存态。
- trace artifacts 仍由 ObservationManager best-effort 写出，但不是 runtime state source。

---

## 5. 目标设计

### 5.1 目录结构

新增目录：

```text
packages/web-buddy/src/agent/
```

建议新增文件：

```text
packages/web-buddy/src/agent/types.ts
packages/web-buddy/src/agent/agent-runtime.ts
packages/web-buddy/src/agent/prompt-assembler.ts
packages/web-buddy/src/agent/stop-condition.ts
```

新增测试：

```text
packages/web-buddy/scripts/agent-runtime-test.mjs
```

新增 npm script：

```json
"test:agent-runtime": "npm run build && node ./scripts/agent-runtime-test.mjs"
```

### 5.2 AgentRuntime

第一版 `AgentRuntime` 是 facade，不是完整替代 loop。

目标接口示意：

```ts
export interface AgentRuntimeInput {
  goal: string
  resume: ResumeProfile
  llm: LlmGateway
  registry?: ToolRegistry
  ctx: ToolContext
  gate: HumanGate
  maxSteps?: number
  onEvent?: (event: AgentRuntimeEvent) => void
  extraContext?: string
  safetyMode?: 'guarded' | 'raw'
}

export interface AgentRuntimeResult {
  schemaVersion: 'agent-runtime-result/v1'
  steps: number
  toolCalls: number
  done: boolean
  blocked: boolean
  summary: string
  stopReason: AgentStopReason
}

export class AgentRuntime {
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>
}
```

第一版实现：

```text
AgentRuntime.run(input)
  -> normalize input defaults
  -> create ToolRegistry if absent
  -> call runAgentLoop(...)
  -> map AgentLoopResult to AgentRuntimeResult
```

注意：

- 不把 tool execution 搬进 AgentRuntime。
- 不让 AgentRuntime 自己调用 browser tools。
- 不让 AgentRuntime 自己读 trace artifacts。
- 不让 AgentRuntime 自己实现 LLM loop。

### 5.3 AgentRuntimeEvent

现有 `AgentEvent`：

```ts
{
  step: number
  level: 'think' | 'act' | 'observe' | 'gate' | 'warn' | 'error' | 'done'
  message: string
}
```

Runtime 事件第一版可以包一层：

```ts
export interface AgentRuntimeEvent {
  schemaVersion: 'agent-runtime-event/v1'
  phase: 'runtime' | 'loop'
  step: number
  level: AgentEvent['level']
  message: string
}
```

第一版只转发 loop event：

```text
runAgentLoop.onEvent(e)
  -> runtime onEvent({ phase: 'loop', ...e })
```

后续再增加：

- runtime_start
- runtime_stop
- context_build
- policy_gate
- tool_execute

### 5.4 StopConditionManager

第一版不接管 loop，只提供类型和结果映射。

建议：

```ts
export type AgentStopReason =
  | 'agent_done'
  | 'blocked'
  | 'step_budget'
  | 'llm_error'
  | 'no_tool_calls'
  | 'unknown'
```

```ts
export class StopConditionManager {
  fromLoopResult(result: AgentLoopResult): AgentStopReason
}
```

映射规则第一版：

```text
result.blocked === true -> blocked
result.done === true && /step budget/i not in summary -> agent_done
summary includes "Reached step budget" -> step_budget
summary includes "LLM error" -> llm_error
else -> unknown
```

注意：

- 不要改变 `runAgentLoop` 内部 stop 逻辑。
- 不要改变 `agent_done` 工具。
- 不要改变 step budget 行为。

### 5.5 PromptAssembler

当前 `agent-loop.ts` 里已有这些 helper：

- `safetyNotesFor`
- `buildLoopContext`
- `renderSystemContext`
- `renderUserContext`
- `renderInitialUserContext`

本阶段可以选择两种方式。

保守方式：

```text
暂时不搬 helper。
AgentRuntime 只包装 runAgentLoop。
PromptAssembler 文件先定义接口和轻量函数，测试只验证能用 ContextSnapshot 生成 system/user prompt。
```

稍进一步方式：

```text
把上述 helper 从 agent-loop 搬到 packages/web-buddy/src/agent/prompt-assembler.ts。
agent-loop 从 PromptAssembler import。
行为必须保持一致。
```

推荐采用稍进一步方式，但要严格控制改动：

```ts
export class PromptAssembler {
  async buildInitialMessages(input: PromptAssemblerInput): Promise<{
    system: string
    user: string
  }>

  async buildUpdatedContext(input: PromptAssemblerInput): Promise<string>
}
```

或更轻量：

```ts
export function safetyNotesFor(...)
export function renderSystemContext(...)
export function renderUserContext(...)
export function renderInitialUserContext(...)
```

第一版不要追求完美抽象。

目标只是：

- 减少 agent-loop 内 prompt helper 密度。
- 为未来 AgentRuntime 直接组 prompt 留接口。
- 保持 ContextManager / Prompt Sections 的使用方式稳定。

### 5.6 runAgentLoop 兼容关系

必须保持：

```ts
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult>
```

不允许：

```text
删除 runAgentLoop
修改 runAgentLoop 必填参数
让 orchestrator 必须改成 AgentRuntime 才能跑
```

允许：

```text
AgentRuntime.run 内部调用 runAgentLoop
runAgentLoop 内部 import PromptAssembler helper
orchestrator 后续可逐步切换
```

推荐本阶段不要改 `sdk/orchestrator.ts`，除非测试需要。

---

## 6. 实施步骤

### 6.1 新增 Agent 类型

新增：

```text
packages/web-buddy/src/agent/types.ts
```

包含：

- `AgentRuntimeInput`
- `AgentRuntimeResult`
- `AgentRuntimeEvent`
- `AgentStopReason`
- `RuntimeStep` 或 `AgentRuntimeStep`

建议 `AgentRuntimeInput` 尽量复用现有类型：

- `ResumeProfile`
- `LlmGateway`
- `HumanGate`
- `ToolRegistry`
- `ToolContext`

避免重复定义工具、LLM、gate 类型。

### 6.2 新增 StopConditionManager

新增：

```text
packages/web-buddy/src/agent/stop-condition.ts
```

第一版只做映射。

必须有测试覆盖：

- loop result blocked -> `blocked`
- summary includes step budget -> `step_budget`
- summary includes LLM error -> `llm_error`
- normal done -> `agent_done`

### 6.3 新增 PromptAssembler

新增：

```text
packages/web-buddy/src/agent/prompt-assembler.ts
```

建议迁移或封装：

- safety notes 生成。
- ContextSnapshot -> system context。
- ContextSnapshot -> user context。
- first pageView fallback 拼接。
- updated context 拼接。

注意：

- PromptAssembler 仍使用 `ContextManager` / `Prompt Sections`。
- PromptAssembler 不读取 trace artifacts。
- PromptAssembler 不调用 browser tools。
- PromptAssembler 不管理 messages 历史。

如果迁移 helper，需要更新：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
```

让 agent-loop 使用 PromptAssembler helper，而不是在文件内保留重复逻辑。

### 6.4 新增 AgentRuntime

新增：

```text
packages/web-buddy/src/agent/agent-runtime.ts
```

第一版：

```text
class AgentRuntime
  constructor(options?)
  run(input)
    registry = input.registry ?? new ToolRegistry()
    result = await runAgentLoop(...)
    stopReason = stopConditionManager.fromLoopResult(result)
    return runtime result
```

可选 constructor：

```ts
export interface AgentRuntimeOptions {
  stopConditions?: StopConditionManager
}
```

不要在 constructor 里引入复杂 dependency container。

### 6.5 新增测试脚本

新增：

```text
packages/web-buddy/scripts/agent-runtime-test.mjs
```

测试建议不要打开真实网站。

可以复用 `agent-loop-test.mjs` 的 mock LLM / demo-form 路径，或更轻量地 mock `runAgentLoop` 不容易，因为 ESM import 不好 monkey patch。

推荐：

- 使用 `runJobApplicationAgent` 路径太重，不适合 runtime facade 单测。
- 直接使用 `AgentRuntime` + demo form + mock LLM 更好。
- 可以参考 `agent-loop-test.mjs`：
  - 配置 headless。
  - 打开 demo form 的逻辑如果只在 orchestrator 内，可考虑抽一个很小 local HTML data URL helper 到测试里。
  - 使用 `browserOpen` 打开 data URL。
  - 用 `AgentRuntime.run` 调现有 loop。

测试必须断言：

- `AgentRuntime.run()` 返回 `schemaVersion: agent-runtime-result/v1`。
- `steps > 0`。
- `toolCalls > 0`。
- `done === true`。
- `blocked === false`。
- `stopReason === 'agent_done'`。
- mock LLM 的工具调用能通过 runtime facade 跑到 `agent_done`。

### 6.6 更新 package.json

新增：

```json
"test:agent-runtime": "npm run build && node ./scripts/agent-runtime-test.mjs"
```

不要删除或重命名现有 scripts。

### 6.7 可选 README 更新

如果改动完成后有余力，可以在：

```text
packages/web-buddy/src/runtime/local/README.md
```

补一句：

```text
AgentRuntime Skeleton v1 now wraps runAgentLoop as a compatibility facade.
```

但本阶段不是文档阶段，文档更新可选。

---

## 7. 验收标准

本阶段完成标准：

1. 新增 `AgentRuntime` facade。
2. 新增 Runtime 类型定义。
3. 新增 `StopConditionManager`。
4. 新增或迁移 `PromptAssembler`，不破坏现有 prompt 行为。
5. `runAgentLoop` 对外接口不变。
6. `ToolRegistry` 对外接口不变。
7. CLI / Web UI / MCP 工具名不变。
8. 不引入完整 `ToolExecutionService`。
9. 不引入完整 `PolicyEngine`。
10. 不做 Skill / Memory / 多 Agent。
11. Runtime / ContextManager / PromptAssembler 不读取 trace artifacts。
12. 新增 `test:agent-runtime` 通过。
13. 现有关键测试通过。

必须运行：

```bash
cd packages/web-buddy
npm run build
npm run test:context
npm run test:prompt-sections
npm run test:agent-runtime
npm run test:agent-loop
npm run benchmark:simple
```

建议运行：

```bash
npm run test:tool-catalog
npm run test:observation
```

必须检查：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local
```

期望：

- `src/agent` 和 `src/context` 不读取 trace artifacts。
- 如果 `runtime/local` 出现 trace 相关字符串，只能是 trace record / diagnostics，不是 read artifact。

---

## 8. 风险与控制

| 风险 | 后果 | 控制 |
| --- | --- | --- |
| Phase 4A 变成完整 Runtime 重构 | 行为回归，测试难定位 | AgentRuntime 第一版只 wrap runAgentLoop |
| 提前引入 ToolExecutionService | local/MCP 执行路径被迫重写 | 本阶段禁止完整 ToolExecutionService |
| 提前抽 PolicyEngine | final submit gate 可能退化 | 本阶段不改 gate 语义 |
| PromptAssembler 迁移破坏 prompt | mock LLM / benchmark 退化 | 迁移后跑 agent-loop 和 benchmark-simple |
| Runtime 读 trace artifacts | stale state 进入主流程 | 明确禁止，rg 检查 |
| orchestrator 切换过大 | CLI / Web UI 行为变化 | 本阶段优先不改 orchestrator |

---

## 9. 本阶段不做

明确不做：

- 完整 ToolExecutionService。
- 完整 PolicyEngine。
- WorkflowEngine。
- Skill System。
- Memory System。
- 多 Agent。
- 真实网站适配。
- MCP server contract 改名。
- Claude Code runtime 内部修改。
- 长期任务状态持久化。
- trace artifacts 作为 runtime state source。

---

## 10. 下一阶段预期

如果 Phase 4A 完成，可以进入 Phase 4B：

```text
Context Selection Metrics / Freshness Metadata / Minimal TaskState
```

Phase 4B 建议内容：

- `contextBuilds`
- `contextChars`
- `contextTruncations`
- `promptSectionChars`
- `pageStateAgeMs`
- `formStateAgeMs`
- `recentActionsIncluded`
- ContextSnapshot freshness metadata。
- 最小 TaskState：
  - schemaVersion
  - goal
  - phase
  - knownBlockers
  - completionCriteria
  - updatedAt

Phase 4C 再考虑：

- ToolExecutionService。
- PolicyEngine extraction。
- LoopController deeper extraction。

---

## 11. 给 Codex 的执行 Prompt

```text
你现在在 /Users/sunqiankai/开源项目/multi-functional-agent。

当前阶段是 AgentRuntime Skeleton v1 / Phase 4A。

上一阶段已经完成：
- Tool Catalog
- local adapter / MCP adapter
- PageState / FormState
- ObservationManager
- observation trace artifacts
- metrics tool category
- benchmark-simple assertions
- ContextManager
- Prompt Sections
- prompt budget
- agent-loop recentActions
- ContextManager 不读取 trace artifacts

当前分支主线：
- packages/web-buddy 是自研 Web Agent 主线包。
- packages/claude-code 是恢复版 Claude Code runtime，只作为 adapter / 对照。
- 当前 local runtime 实际执行入口仍是 packages/web-buddy/src/runtime/local/agent-loop.ts 的 runAgentLoop。

本阶段目标：
新增一个轻量 AgentRuntime facade，让后续 runtime / workflow / policy / tool execution 能逐步挂载；第一版 AgentRuntime.run 内部仍调用现有 runAgentLoop，保持现有 CLI / Web UI / MCP 行为兼容。

严格遵守：
1. 不要重写 runAgentLoop 主循环。
2. 不要改变 runAgentLoop 对外接口。
3. 不要改变 ToolRegistry 对外接口。
4. 不要重写 local adapter / MCP adapter。
5. 不要引入完整 ToolExecutionService。
6. 不要抽完整 PolicyEngine。
7. 不要做 Skill / Memory / 多 Agent。
8. 不要做真实网站适配。
9. 不要改 packages/claude-code 内部逻辑。
10. 不要破坏现有 CLI / Web UI / MCP 工具名。
11. Runtime / ContextManager / PromptAssembler 不允许读取 trace artifacts。
12. trace artifacts 只能作为 Web UI / benchmark / debug / replay 的旁路输出。

你需要完成：

一、检查当前基础
- 阅读 packages/web-buddy/src/runtime/local/agent-loop.ts
- 阅读 packages/web-buddy/src/context/context-manager.ts
- 阅读 packages/web-buddy/src/context/prompt-sections.ts
- 阅读 packages/web-buddy/src/runtime/local/tool-registry.ts
- 阅读 packages/web-buddy/src/tools/local-adapter.ts
- 阅读 packages/web-buddy/src/sdk/orchestrator.ts
- 阅读 packages/web-buddy/scripts/agent-loop-test.mjs
- 阅读 packages/web-buddy/scripts/context-manager-test.mjs
- 阅读 packages/web-buddy/scripts/prompt-sections-test.mjs
- 阅读 packages/web-buddy/scripts/benchmark-simple.mjs

二、新增 AgentRuntime 模块
- 新增 packages/web-buddy/src/agent/types.ts
- 新增 packages/web-buddy/src/agent/stop-condition.ts
- 新增 packages/web-buddy/src/agent/prompt-assembler.ts
- 新增 packages/web-buddy/src/agent/agent-runtime.ts

三、AgentRuntime v1
- 定义 AgentRuntimeInput。
- 定义 AgentRuntimeResult。
- 定义 AgentRuntimeEvent。
- 定义 AgentStopReason。
- 实现 AgentRuntime.run(input)。
- AgentRuntime.run 第一版内部调用 runAgentLoop。
- registry 如果未传入，则默认 new ToolRegistry()。
- 将 AgentLoopResult 映射为 AgentRuntimeResult。
- 不自己执行 browser tools。
- 不自己读取 trace artifacts。

四、StopConditionManager v1
- 新增轻量 StopConditionManager。
- 从 AgentLoopResult 推断 stopReason。
- 至少支持：
  - agent_done
  - blocked
  - step_budget
  - llm_error
  - unknown
- 不改变 runAgentLoop 内部 stop 行为。

五、PromptAssembler v1
- 新增 PromptAssembler 或轻量 prompt helper。
- 可以把 agent-loop 中现有 prompt helper 迁移出来：
  - safetyNotesFor
  - buildLoopContext
  - renderSystemContext
  - renderUserContext
  - renderInitialUserContext
- 迁移后 agent-loop 使用 PromptAssembler/helper。
- 保持现有 prompt section 顺序和 pageView fallback。
- 不读取 trace artifacts。
- 不调用 browser tools。

六、测试
- 新增 packages/web-buddy/scripts/agent-runtime-test.mjs
- 更新 packages/web-buddy/package.json，新增：
  - test:agent-runtime
- 测试必须证明：
  - AgentRuntime.run 可以跑通 mock LLM 流程。
  - 返回 schemaVersion 为 agent-runtime-result/v1。
  - steps > 0。
  - toolCalls > 0。
  - done === true。
  - blocked === false。
  - stopReason === agent_done。
  - runAgentLoop 旧入口仍可用。
  - Runtime 不依赖 trace artifact 文件。

七、验证
在 packages/web-buddy 下运行：
- npm run build
- npm run test:context
- npm run test:prompt-sections
- npm run test:agent-runtime
- npm run test:agent-loop
- npm run benchmark:simple

建议额外运行：
- npm run test:tool-catalog
- npm run test:observation

同时运行检查：
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local

最终回复包含：
- 改了哪些模块。
- 新增了哪些文件。
- AgentRuntime 如何保持 runAgentLoop 兼容。
- StopConditionManager 如何映射 stopReason。
- PromptAssembler 是否迁移了 agent-loop helper。
- 如何保证 Runtime 没有读 trace artifacts。
- 运行了哪些命令。
- 哪些通过，哪些没跑或失败。
- 下一阶段是否可以进入 Context Selection Metrics / Freshness / TaskState。
```

