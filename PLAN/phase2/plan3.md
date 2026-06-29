# Phase 2 Plan 3: ToolExecutionService v1 + ToolUseContext

> 目标：Phase 2B 已经让运行入口进入 `AgentKernel -> QueryLoop -> runAgentLoop`。
> Plan 3 要把“单个工具调用的执行生命周期”从 `runAgentLoop` 中抽出来，形成 `ToolExecutionService v1`。
> 本阶段仍不重写主循环，不引入 PermissionEngine / WorkflowEngine，不改变 prompt、tool schema、policy decision 语义。

## 1. 为什么第三步做 ToolExecutionService

当前 `runAgentLoop` 已经不是纯粹的 loop。它除了调模型和推进 messages，还直接负责工具执行周边的一批细节：

- 创建 `ToolExecutionBoundary`。
- 在 policy / gate 通过后调用工具。
- 判断工具结果是否失败。
- 记录工具 span。
- 记录工具 started / completed / failed 事件。
- 将 thrown error 转成 session error。
- 将工具 observation 继续塞回模型消息。

Phase 2B 已经把外层运行控制交给 Kernel，但工具执行仍然缺少统一生命周期。

第一性原理：

> 工具调用不是普通函数调用。它是 Agent 对外部世界的一次受控动作，必须有开始、运行、完成、失败、取消、超时和可审计结果。

Plan 3 的目的不是让 Agent 变聪明，而是让每一次工具调用都变成可观察、可中断、可归一化、可测试的执行单元。

## 2. 当前状态

已有文件：

```text
packages/web-buddy/src/tools/tool-execution.ts
packages/web-buddy/src/runtime/local/tool-registry.ts
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/kernel/query-loop.ts
packages/web-buddy/src/kernel/run-controller.ts
```

当前执行链路：

```text
runAgentLoop
  -> registry.toOpenAITools()
  -> llm.chatWithTools()
  -> for each tool call
      -> registry.get()
      -> registry.resolveRisk()
      -> decideToolPolicy()
      -> HumanGate if needed
      -> ToolExecutionBoundary.execute()
          -> ToolRegistry.run()
              -> LocalToolDef.run()
      -> compactToolResult()
      -> transitionWorkflowState()
      -> messages.push(tool message)
```

当前 `ToolExecutionBoundary` 很薄，这是好事：

```text
ToolExecutionBoundary
  - delegates to ToolRegistry.run()
  - does not own policy
  - does not own retry
  - does not own queueing
  - does not own browser calls
```

Plan 3 要把它升级为真正的执行服务，但只升级执行层，不顺手改 policy / workflow / prompt。

## 3. 本阶段目标

完成后应该具备：

1. 新增 `ToolExecutionService`，统一执行单个 tool call。
2. 新增 `ToolUseContext`，给执行层传入 run / turn / tool call 上下文。
3. 新增 `ToolExecutionState`，表达 queued / running / succeeded / failed / cancelled / timed_out / blocked。
4. 新增 `NormalizedToolResult`，把工具结果、失败、异常、abort、timeout 归一化。
5. `runAgentLoop` 中的实际工具执行调用改为通过 `ToolExecutionService`。
6. 现有 `ToolExecutionBoundary` 保持兼容 facade，旧测试和旧 import 不断。
7. `AgentRuntimeResult`、`AgentLoopResult`、session transcript 结构保持兼容。
8. 现有 prompt、tool schema、policy decision、HumanGate、workflow transition 语义不变。

## 4. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不让 `QueryLoop` 直接调度 tool calls。
- 不引入 PermissionEngine。
- 不引入 WorkflowEngine。
- 不引入 retry policy。
- 不做并发工具执行。
- 不做 streaming tool output。
- 不做 tool result token budget。
- 不做 stale ref 自动刷新。
- 不改变 `registry.toOpenAITools()` 产出的 tool schema。
- 不改变 `decideToolPolicy()` 的输入、输出和含义。
- 不改变 HumanGate 的确认时机和 final submit 语义。
- 不改变模型看到的正常工具 observation。

## 5. 边界定义

## 5.1 从 runAgentLoop 迁出的逻辑

Plan 3 只迁出“policy 已允许之后，单个工具调用如何执行”的逻辑。

迁出内容：

1. 工具执行入口
   - 从 `ToolExecutionBoundary.execute()` 迁到 `ToolExecutionService.execute()`。
   - `ToolExecutionBoundary` 保留为兼容 facade。

2. 执行状态管理
   - queued。
   - running。
   - succeeded。
   - failed。
   - cancelled。
   - timed_out。
   - blocked 作为状态类型保留，但 v1 不由 service 产生 policy block。

3. 执行时间记录
   - `queuedAt`。
   - `startedAt`。
   - `completedAt`。
   - `durationMs`。
   - `attempts`，v1 固定为 `1`。

4. abort 检查的执行层兜底
   - service 开始前检查 `ToolUseContext.abortSignal`。
   - runAgentLoop 仍保留现有工具执行前 abort 检查，用于保持 session `aborted` 终态兼容。

5. timeout 包装和归一化
   - service 可接收 `timeoutMs`。
   - timeout 统一变成 `NormalizedToolError`。
   - v1 不做 retry。

6. error normalization
   - `FAILED (...)` observation。
   - unknown tool。
   - registry / tool thrown exception。
   - abort。
   - timeout。
   - invalid tool result。

7. 工具 trace span
   - service 可以负责 start/end tool span。
   - `runAgentLoop` 继续决定 policy metadata 传什么。

8. execution-level events
   - service 通过 callback 报告 state change。
   - `runAgentLoop` 继续负责把这些状态写入现有 session transcript / events 形状。

## 5.2 暂时保留在 runAgentLoop 的逻辑

这些逻辑本阶段不迁出：

1. 模型调用
   - messages 构造。
   - `llm.chatWithTools()`。
   - assistant message 写入 transcript。
   - tool call message append。

2. tool schema
   - `registry.toOpenAITools()` 仍由 loop 使用。
   - 不改变 catalog / local adapter schema。

3. risk 和 policy
   - `registry.get()` 获取 category。
   - `registry.resolveRisk()`。
   - `decideToolPolicy()`。
   - `createPolicyAuditEvent()`。
   - policy transcript / event 写入。

4. HumanGate
   - `gate.confirm()`。
   - gate requested / resolved event。
   - final submit gate 特殊处理。
   - gate reject 后是否继续或停止。

5. workflow
   - `transitionWorkflowState()`。
   - `recordWorkflowSnapshot()`。
   - login / captcha handoff。
   - workflow blocker 写入 recent actions。

6. session transcript 兼容层
   - `tool_call` transcript。
   - `tool_result` transcript。
   - `error` transcript。
   - `final_result` transcript。

7. 模型可见 observation 处理
   - `messages.push(toolMessage(...))`。
   - observation slice 长度。
   - page-changing action 后刷新 snapshot 并拼接 `[updated page]`。

8. agent_done 语义
   - `result.done`。
   - `result.data.blocked`。
   - summary 取值。

9. turn 结束判断
   - step budget。
   - done / blocked。
   - context refresh。

## 5.3 v1 兼容边界

必须保持：

- `runAgentLoop(input)` 继续可直接调用。
- `AgentRuntime.run()` 继续返回 `schemaVersion: 'agent-runtime-result/v1'`。
- `AgentRuntimeResult.runtime` 继续是 `'local-agent-loop'`。
- session `transcript.jsonl` 继续包含既有 entry types。
- session `events.jsonl` 可以增加执行状态 detail，但不得删除既有事件。
- trace 仍是旁路审计，不成为 runtime state。
- 模型看到的成功 observation 和已有 `FAILED (...)` observation 不被改写。

允许的 additive change：

- `tool_result.result` 中可出现更稳定的 compacted fields。
- `tool_result.error` 可更准确。
- session event `data` 可增加 `executionState` / `error` / `durationMs`。
- `KernelEventType` 如需扩展，只能 additive；v1 优先复用现有 `tool_call_created`、`tool_started`、`tool_completed`、`tool_failed`。

## 6. 目标文件结构

新增文件：

```text
packages/web-buddy/src/tools/
  tool-contract.ts
  tool-result.ts
  tool-errors.ts
  tool-progress.ts
  tool-execution-service.ts

packages/web-buddy/scripts/
  tool-execution-service-test.mjs
```

修改文件：

```text
packages/web-buddy/src/tools/tool-execution.ts
packages/web-buddy/src/tools/index.ts                 # 如果存在或后续需要统一 export
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/kernel/kernel-events.ts        # 仅当需要 additive event type
packages/web-buddy/package.json
```

不应修改：

```text
packages/web-buddy/src/agent/prompt-assembler.ts
packages/web-buddy/src/policy/agent-policy.ts
packages/web-buddy/src/workflow/workflow-transition.ts
packages/web-buddy/src/tools/catalog.ts
packages/web-buddy/src/tools/local-adapter.ts         # 除非只是补类型 export
```

## 7. 接口草案

## 7.1 ToolCall

放在 `tools/tool-contract.ts`。

```ts
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
```

说明：

- 对齐当前 `completion.toolCalls` 的最小形状。
- 不引入 OpenAI SDK 类型依赖。
- 不改变 LLM gateway 返回结构。

## 7.2 ToolExecutionMetadata

放在 `tools/tool-contract.ts`。

```ts
export interface ToolExecutionMetadata {
  step?: number
  riskLevel?: string
  category?: string
  argBrief?: string
  policyAction?: string
  policyCode?: string
  policyRuleId?: string
  policyGateKind?: string
}
```

说明：

- v1 只透传现有 policy / risk metadata。
- service 不解释 policy 语义。
- service 不决定 allow / gate / block。

## 7.3 ToolUseContext

放在 `tools/tool-contract.ts`。

```ts
import type { KernelEvent } from '../kernel/kernel-events.js'
import type { LocalToolContext } from './local-adapter.js'
import type { ToolExecutionState } from './tool-progress.js'

export interface ToolUseContext {
  schemaVersion: 'tool-use-context/v1'
  runId: string
  sessionId: string
  turnId: string
  step: number
  toolCallId: string
  local: LocalToolContext
  abortSignal?: AbortSignal
  timeoutMs?: number
  metadata?: ToolExecutionMetadata
  emit?: (event: KernelEvent) => void
  onStateChange?: (state: ToolExecutionState) => void
  now?: () => Date
}
```

明确不放进 `ToolUseContext`：

- `requestPermission()`。
- `gate.confirm()`。
- `SessionRecorder`。
- `WorkflowState` mutator。
- prompt / messages。
- retry policy。

原因：

- PermissionEngine 是后续阶段。
- WorkflowEngine 是后续阶段。
- v1 的职责是工具生命周期，不是任务决策。

## 7.4 ToolExecutionState

放在 `tools/tool-progress.ts`。

```ts
import type { NormalizedToolError } from './tool-errors.js'
import type { ToolExecutionMetadata } from './tool-contract.js'

export type ToolExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked'

export interface ToolExecutionState {
  version: 1
  toolCallId: string
  name: string
  turnId: string
  step: number
  status: ToolExecutionStatus
  attempts: number
  queuedAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  timeoutMs?: number
  abortReason?: string
  error?: NormalizedToolError
  metadata?: ToolExecutionMetadata
}
```

v1 语义：

- `queued`: service 已接收 call，但还没调用 registry。
- `running`: registry 已开始执行。
- `succeeded`: 工具返回成功 observation。
- `failed`: 工具返回失败 observation、unknown tool、异常或 invalid result。
- `cancelled`: abort 在执行前或执行等待期间被观察到。
- `timed_out`: service timeout 先于工具结果发生。
- `blocked`: 类型保留给 policy/gate 展示，本阶段不由 service 产生。

## 7.5 NormalizedToolError

放在 `tools/tool-errors.ts`。

```ts
export type NormalizedToolErrorKind =
  | 'aborted'
  | 'timeout'
  | 'tool_failed_observation'
  | 'unknown_tool'
  | 'registry_exception'
  | 'invalid_result'

export interface NormalizedToolError {
  schemaVersion: 'normalized-tool-error/v1'
  kind: NormalizedToolErrorKind
  code: string
  message: string
  retryable: boolean
  fatal: boolean
  cause?: unknown
}
```

v1 默认：

- `aborted`: `retryable=false`，`fatal=false`。
- `timeout`: `retryable=false`，`fatal=false`。
- `tool_failed_observation`: `retryable=false`，`fatal=false`。
- `unknown_tool`: `retryable=false`，`fatal=false`。
- `registry_exception`: `retryable=false`，`fatal=true`。
- `invalid_result`: `retryable=false`，`fatal=true`。

说明：

- v1 不做自动 retry，所以所有 `retryable` 默认 false。
- 先保留字段，是为了后续 retry policy 可以不改 result schema。

## 7.6 NormalizedToolResult

放在 `tools/tool-result.ts`。

```ts
import type { RiskLevel } from '../sdk/trace.js'
import type { LocalToolRunResult } from './local-adapter.js'
import type { ToolExecutionState, ToolExecutionStatus } from './tool-progress.js'
import type { NormalizedToolError } from './tool-errors.js'

export type ToolTerminalStatus = Exclude<ToolExecutionStatus, 'queued' | 'running'>

export interface NormalizedToolResult {
  schemaVersion: 'normalized-tool-result/v1'
  toolCallId: string
  name: string
  args: Record<string, unknown>
  ok: boolean
  status: ToolTerminalStatus
  observation: string
  data?: unknown
  risk?: RiskLevel
  pageChanged: boolean
  done: boolean
  rawResult?: LocalToolRunResult
  error?: NormalizedToolError
  state: ToolExecutionState
}

export function toLegacyToolRunResult(result: NormalizedToolResult): LocalToolRunResult
```

v1 语义：

- `observation` 是模型可见文本的来源。
- `toLegacyToolRunResult()` 用于 `compactToolResult()` 和 `transitionWorkflowState()` 兼容。
- `pageChanged` 缺省为 false。
- `done` 缺省为 false。
- `ok=false` 表示执行层认为该工具调用没有成功完成。
- `rawResult` 保留 local adapter 的原始结果，方便兼容现有 workflow transition。

## 7.7 ToolExecutionService

放在 `tools/tool-execution-service.ts`。

```ts
import type { ToolCall, ToolUseContext } from './tool-contract.js'
import type { NormalizedToolResult } from './tool-result.js'
import type { LocalToolContext, LocalToolRunResult } from './local-adapter.js'

export interface ToolExecutionRegistry {
  run(toolName: string, args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolRunResult>
}

export interface ToolExecutionServiceOptions {
  defaultTimeoutMs?: number
}

export class ToolExecutionService {
  constructor(registry: ToolExecutionRegistry, options?: ToolExecutionServiceOptions)

  execute(call: ToolCall, context: ToolUseContext): Promise<NormalizedToolResult>
}
```

说明：

- `ToolExecutionService` 只依赖 `ToolExecutionRegistry` 接口，不直接依赖 `ToolRegistry` class。
- local runtime、未来 MCP runtime 可以分别适配同一个 service。
- v1 不做批量执行，所以没有 `runToolsSerially()` / `runToolsConcurrently()`。

## 8. abort / timeout / error normalization 语义

## 8.1 Abort v1

来源：

- `ToolUseContext.abortSignal`。
- 当前来自 `AgentRunController.signal`。

保证：

1. 如果 signal 在 service 调用 registry 前已经 aborted：
   - 不调用 `registry.run()`。
   - 返回 `status='cancelled'`。
   - `ok=false`。
   - `error.kind='aborted'`。
   - `observation='FAILED (ABORTED): <reason>'`。

2. `runAgentLoop` 仍保留现有工具执行前 `checkAbort()`：
   - 用于保持当前 session `final_result: aborted`。
   - 用于保持 `AgentKernelResult.status='aborted'`。
   - 用于保持 abort-before-tool 测试中“工具未执行”的行为。

3. 如果 signal 在工具已 running 后 aborted：
   - v1 是 best effort。
   - service 可以先返回 cancelled，并忽略 late result。
   - v1 不承诺强制中断已经进入 Playwright 的动作。
   - 不做 retry，不启动下一个工具。

非保证：

- 不保证中断正在执行的 Playwright action。
- 不保证浏览器页面没有发生 late side effect。
- 不保证外部网站撤销已经发出的请求。

## 8.2 Timeout v1

timeout 来源优先级：

```text
ToolUseContext.timeoutMs
  -> ToolExecutionServiceOptions.defaultTimeoutMs
  -> undefined
```

说明：

- 不自动改写 `call.arguments.timeoutMs`。
- browser tools 内部已有的 `timeoutMs` / env timeout 继续生效。
- service timeout 是执行层 deadline，不改变 tool schema。

timeout 结果：

```text
status      = timed_out
ok          = false
error.kind  = timeout
error.code  = TOOL_TIMEOUT
observation = FAILED (TOOL_TIMEOUT): Tool <name> timed out after <timeoutMs>ms.
```

v1 约束：

- timeout 不触发自动 retry。
- timeout 默认是 recoverable tool failure，模型可以看到失败 observation 后决定下一步。
- 如果 timeout 后 underlying tool late resolve，late result 不写入 session transcript。
- 如果 late side effect 已经发生，只能通过后续 snapshot / trace 观察，v1 不做补偿。

## 8.3 Error normalization v1

| Source | status | ok | error.kind | observation |
|---|---|---:|---|---|
| `LocalToolRunResult` success | `succeeded` | true | none | 原样保留 |
| observation starts with `FAILED (` | `failed` | false | `tool_failed_observation` | 原样保留 |
| observation starts with `Unknown tool:` | `failed` | false | `unknown_tool` | 原样保留 |
| registry throws | `failed` | false | `registry_exception` | `FAILED (TOOL_EXCEPTION): ...` |
| invalid result shape | `failed` | false | `invalid_result` | `FAILED (INVALID_TOOL_RESULT): ...` |
| abort before start / during wait | `cancelled` | false | `aborted` | `FAILED (ABORTED): ...` |
| service timeout | `timed_out` | false | `timeout` | `FAILED (TOOL_TIMEOUT): ...` |

Compatibility rule:

> 对已有工具正常返回和已有 `FAILED (...)` 返回，模型看到的 observation 必须保持不变。

Fatal rule:

- `registry_exception` 和 `invalid_result` 标记 `fatal=true`。
- `runAgentLoop` 可以继续沿用当前 failed session 处理路径。
- 普通 `FAILED (...)`、timeout、unknown tool 默认不是 fatal，交给模型下一轮处理。

## 9. runAgentLoop 集成方式

## 9.1 最小改造

当前：

```ts
const toolExecution = new ToolExecutionBoundary(registry)

const execution = await toolExecution.execute({
  toolName: call.name,
  args: call.arguments,
  ctx,
  metadata,
})
result = execution.result
```

目标：

```ts
const toolExecution = input.toolExecutionService ?? new ToolExecutionService(registry)

const execution = await toolExecution.execute(
  {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  },
  {
    schemaVersion: 'tool-use-context/v1',
    runId,
    sessionId: ctx.sessionId,
    turnId,
    step,
    toolCallId: call.id,
    local: ctx,
    abortSignal: input.abortSignal,
    metadata,
    onStateChange,
  },
)

result = toLegacyToolRunResult(execution)
```

## 9.2 AgentLoopInput additive field

可以新增可选字段：

```ts
toolExecutionService?: ToolExecutionService
```

要求：

- 可选字段，不破坏直接调用 `runAgentLoop` 的旧代码。
- 默认仍创建 service。
- 测试可以注入 mock service。

## 9.3 session transcript 兼容

保留现有 transcript entry：

```text
tool_call
policy_decision
tool_result
error
workflow_snapshot
final_result
```

`tool_result` 继续长这样：

```ts
{
  type: 'tool_result',
  turnId,
  toolCallId,
  name,
  ok,
  result,
  error?
}
```

允许在 `result` 或 event `data` 中增加：

```ts
{
  executionState,
  durationMs,
  error
}
```

但不得删除旧字段。

## 9.4 Kernel / QueryLoop 兼容

Plan 3 不要求改成：

```text
QueryLoop -> ToolExecutionService
```

本阶段仍是：

```text
QueryLoop -> runAgentLoop -> ToolExecutionService
```

原因：

- Plan 2 的 QueryLoop 第一版本来就是 wrapper。
- 直接让 QueryLoop 调 tools 会变成重写主循环。
- ToolExecutionService v1 先服务现有 loop，后续再被 QueryLoop 直接调度。

## 10. 事件策略

v1 优先复用现有事件：

| ToolExecutionState | Existing event |
|---|---|
| `queued` | `tool_call_created` |
| `running` | `tool_started` |
| `succeeded` | `tool_completed` |
| `failed` | `tool_failed` |
| `timed_out` | `tool_failed` |
| `cancelled` | `tool_failed` plus `data.status='cancelled'` |
| `blocked` | policy / gate path keeps existing events |

如果实现时确实需要新事件，只能 additive 增加：

```text
tool_progress
tool_cancelled
tool_timed_out
```

但 Plan 3 建议先不要扩展，避免 Web UI / session reader 需要同步改动。

## 11. 测试计划

新增：

```text
packages/web-buddy/scripts/tool-execution-service-test.mjs
```

覆盖：

1. success path
   - registry 被调用一次。
   - state 顺序为 queued -> running -> succeeded。
   - `NormalizedToolResult.ok=true`。
   - `toLegacyToolRunResult()` 与旧 result 兼容。

2. failed observation
   - registry 返回 `FAILED (CONFIRMATION_REQUIRED): ...`。
   - status 为 failed。
   - `error.kind='tool_failed_observation'`。
   - observation 原样保留。

3. unknown tool
   - 使用 `new ToolRegistry([])`。
   - status 为 failed。
   - `error.kind='unknown_tool'`。
   - observation 原样保留 `Unknown tool: ...`。

4. registry exception
   - mock registry throw。
   - service 返回 `NormalizedToolResult`，其中 `error.kind='registry_exception'` 且 `fatal=true`。
   - `ToolExecutionBoundary` 负责保持旧 API 兼容，旧测试仍通过。

5. abort before start
   - `AbortController` 先 abort。
   - registry 不被调用。
   - status 为 cancelled。
   - error kind 为 aborted。

6. timeout
   - mock registry 延迟。
   - context timeoutMs 很短。
   - status 为 timed_out。
   - observation 为 `FAILED (TOOL_TIMEOUT): ...`。

7. metadata passthrough
   - risk / category / policy metadata 出现在 state 或 trace span metadata 中。

8. event/state callback
   - `onStateChange` 收到状态变化。
   - 不要求新增 KernelEvent type。

更新：

```text
packages/web-buddy/scripts/tool-execution-test.mjs
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/agent-kernel-test.mjs
```

必须继续覆盖：

- `ToolExecutionBoundary` 兼容旧 API。
- `runAgentLoop` 成功路径 transcript 不变。
- abort before tool 仍不执行工具。
- `AgentRuntime.run()` schema 不变。

package scripts：

```json
{
  "scripts": {
    "test:tool-execution-service": "npm run build && node ./scripts/tool-execution-service-test.mjs"
  }
}
```

`test:mvp` 应加入：

```text
npm run test:tool-execution-service
```

## 12. 多 Agent 并行实施拆分

## 12.1 Agent A: contracts and result types

负责文件：

```text
packages/web-buddy/src/tools/tool-contract.ts
packages/web-buddy/src/tools/tool-result.ts
packages/web-buddy/src/tools/tool-errors.ts
packages/web-buddy/src/tools/tool-progress.ts
```

任务：

- 定义接口。
- 实现 error helper。
- 实现 result normalization helper。
- 实现 `toLegacyToolRunResult()`。
- 不改 `runAgentLoop`。

验证：

```text
npm run build
```

## 12.2 Agent B: ToolExecutionService core

负责文件：

```text
packages/web-buddy/src/tools/tool-execution-service.ts
packages/web-buddy/scripts/tool-execution-service-test.mjs
packages/web-buddy/package.json
```

任务：

- 实现 `ToolExecutionService.execute()`。
- 实现 abort before start。
- 实现 optional timeout。
- 调用 registry。
- 触发 `onStateChange`。
- 写 service-level tests。

不做：

- 不接 runAgentLoop。
- 不改 policy。
- 不改 workflow。

验证：

```text
npm run test:tool-execution-service
```

## 12.3 Agent C: compatibility facade

负责文件：

```text
packages/web-buddy/src/tools/tool-execution.ts
packages/web-buddy/scripts/tool-execution-test.mjs
```

任务：

- 保持 `ToolExecutionBoundary` 现有 API。
- 可内部委托 `ToolExecutionService`，也可保留轻 wrapper。
- 旧测试继续通过。

验证：

```text
npm run test:tool-execution
```

## 12.4 Agent D: runAgentLoop integration

负责文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/agent-kernel-test.mjs
```

任务：

- 在 `AgentLoopInput` 增加可选 `toolExecutionService`。
- 将 policy 通过后的执行调用替换为 service。
- 保留 pre-tool abort check。
- 保留 session transcript 形状。
- 保留 workflow transition 输入兼容。

不做：

- 不移动 policy。
- 不移动 HumanGate。
- 不移动 workflow transition。
- 不改 prompt。

验证：

```text
npm run test:agent-loop
npm run test:kernel
```

## 12.5 Agent E: compatibility and docs verification

负责文件：

```text
packages/web-buddy/package.json
README.md
packages/web-buddy/README.md
docs/agent-iteration-log.md
```

任务：

- 文档说明 Plan 3 完成内容。
- `test:mvp` 加入新测试。
- 跑完整兼容验证。

验证：

```text
npm run test:session
npm run test:mvp
git diff --check
```

## 13. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:tool-execution-service` 通过。
3. `npm run test:tool-execution` 通过。
4. `npm run test:agent-loop` 通过。
5. `npm run test:kernel` 通过。
6. `npm run test:session` 通过。
7. `npm run test:mvp` 通过。
8. `git diff --check` 通过。
9. `runAgentLoop` 可直接调用且参数兼容。
10. `AgentRuntime.run()` 返回 schema 不变。
11. session transcript 仍包含既有关键 entry types。
12. abort before tool execution 不执行工具。
13. timeout 有明确 `FAILED (TOOL_TIMEOUT)` observation 和 normalized error。
14. 普通工具成功 observation 不被改写。
15. `FAILED (...)` observation 不被改写。
16. policy / HumanGate / final submit 行为不变。
17. runtime/session/context/workflow 不读取 `output/traces`。

## 14. 风险和规避

| 风险 | 规避 |
|---|---|
| ToolExecutionService 偷偷变成 PermissionEngine | `ToolUseContext` v1 不包含 `requestPermission()`，policy/gate 继续留在 loop |
| runAgentLoop 被重写 | 只替换工具执行调用点，不移动模型、policy、workflow、messages |
| session transcript 不兼容 | `tool_result` entry 保留旧字段，只 additive 增加 execution detail |
| abort 过度承诺 | 明确只保证执行前不调用 registry，running 后是 best effort |
| timeout 后 late side effect | timeout 不 retry，late result 不写 transcript，后续通过 snapshot 观察 |
| error normalization 改写模型 observation | 已有 success 和 `FAILED (...)` observation 原样保留 |
| 多 agent 改同一文件冲突 | 先做 contracts/service/facade，再做 runAgentLoop integration |

## 15. 给实现 Agent 的提示词

```text
你正在实现 Phase 2C: ToolExecutionService v1。

请先阅读：
- PLAN/phase2/README.md
- PLAN/phase2/plan2.md
- PLAN/phase2/plan2-completion-explanation.md
- PLAN/phase2/plan3.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/tools/tool-execution.ts
- packages/web-buddy/src/runtime/local/tool-registry.ts
- packages/web-buddy/src/kernel/query-loop.ts
- packages/web-buddy/src/kernel/run-controller.ts

硬约束：
- 不重写 runAgentLoop。
- 不引入 PermissionEngine / WorkflowEngine。
- 不改变 prompt、tool schema、policy decision 语义。
- 不改变 AgentRuntimeResult schema。
- session transcript entry types 保持兼容。

本阶段只做：
- ToolUseContext。
- ToolExecutionState。
- NormalizedToolResult。
- ToolExecutionService v1。
- ToolExecutionBoundary 兼容。
- runAgentLoop 最小接入。
- 测试和文档。

完成后运行：
- npm run build
- npm run test:tool-execution-service
- npm run test:tool-execution
- npm run test:agent-loop
- npm run test:kernel
- npm run test:session
- git diff --check
```
