# Phase 2 Plan 5: Context Compaction v1 + Run Summary

> 目标：Plan 4 已经把 `PolicyEngine -> PermissionEngine -> ApprovalQueue -> HumanGate -> ToolExecutionService` 的权限链路拆清楚。
> Plan 5 要解决下一块基础问题：长任务上下文不能无限增长，Agent 需要一个可审计、可恢复、不会依赖 trace artifact 的 compact summary。
>
> 本阶段仍不重写 `runAgentLoop`，不引入 WorkflowEngine，不改变 tool schema，不做 LLM 自我总结服务，不读 `output/traces`。

## 1. 为什么第五步做 Context Compaction

当前 `runAgentLoop` 的消息历史会随着每一轮增长：

```text
system context
initial user context
assistant tool-call message
tool observation
UPDATED_CONTEXT user message
assistant tool-call message
tool observation
...
```

现在每个 tool result 已经会裁剪 observation，session transcript 也会压缩一些结果，但模型上下文本身还没有真正的 budget / compaction 策略。

短 demo 没问题，长任务会出问题：

- 多页跳转后，旧页面 snapshot 占据上下文。
- 多次工具失败后，模型被噪声淹没。
- permission / approval / workflow blocker 分散在历史消息里。
- 用户 handoff 后继续任务时，关键事实不一定在最近几条消息里。
- 将来 resume 时，需要从 transcript 重建“当前最重要的状态”。

Plan 5 的第一性原理：

> Transcript 是审计事实源，Context 是决策 working set。Agent 不能把完整历史都塞给模型，必须把历史压缩成当前决策所需的稳定摘要。

所以 Plan 5 不追求“聪明总结”，而是先建立 deterministic compact summary：

```text
long transcript / recent actions / workflow / permission history
  -> compact run summary
  -> session transcript entry
  -> next model turn receives compact context instead of无限旧消息
```

## 2. 当前状态

已有能力：

- `session/transcript.jsonl` 记录 user / assistant / tool_call / tool_result / policy_decision / permission_decision / approval_request / approval_decision / workflow_snapshot / final_result。
- `session/workflow.json` 持久化最新 workflow snapshot。
- `ContextManager` 从 observation memory 构造 `ContextSnapshot`，不读取 trace artifacts。
- `PromptAssembler` 能渲染 system/user context sections。
- `runAgentLoop` 内部维护：
  - `messages`
  - `recentActions`
  - `blockers`
  - `workflowState`
- `kernel/token-budget.ts` 已有非常轻的 token estimate / snapshot。
- `compactAssistantContent()` / `compactToolResult()` 已经用于 session transcript 记录。

当前不足：

- 没有 `ContextCompactor`。
- 没有 `RunSummary` / `CompactSummary` 数据模型。
- `TokenBudget` 没有接入真实 messages。
- `runAgentLoop` 不会在消息过长时 compact。
- session transcript 没有 compact entry。
- compact 后如何保留 goal / workflow phase / blockers / permission decisions 没有协议。
- 没有测试证明 compact 后关键事实不丢失。

## 3. 本阶段目标

完成后应该具备：

1. 新增 `RunSummary` / `CompactSummary` 类型。
2. 新增 deterministic `ContextCompactor v1`。
3. 扩展 `TokenBudget`，可估算 chat messages / tool observations。
4. `runAgentLoop` 在 turn 边界检测上下文预算，超过阈值时 compact。
5. compact summary 写入 session transcript 和 session events。
6. compact 后模型仍能看到：
   - 用户目标。
   - 当前 workflow phase。
   - 最近页面 / 表单摘要。
   - 最近关键工具动作。
   - blockers。
   - policy / permission / approval 结论。
   - final submit / upload / login / captcha 等安全状态。
   - 下一步建议。
7. compact 不读取 trace artifacts。
8. compact 后 `AgentRuntimeResult` schema 不变。
9. `runAgentLoop` 直接调用兼容。

## 4. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不迁移 WorkflowEngine。
- 不改变 tool schema。
- 不改变 browser tools。
- 不做 LLM summarizer。
- 不调用模型来 compact。
- 不做跨进程完整 resume。
- 不做 persistent approval resume。
- 不做 Task Cockpit UI。
- 不做 Memory。
- 不做 SkillSystem。
- 不把 trace artifacts 当 runtime state。
- 不读 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。

Plan 5 v1 是 deterministic compaction，不是智能摘要系统。

## 5. 职责边界

## 5.1 总链路

Plan 5 后的最小链路：

```text
runAgentLoop
  -> maintain messages / recentActions / blockers / workflowState
  -> TokenBudget.estimate(messages)
  -> if compactRecommended:
       ContextCompactor.compact(...)
       session transcript: context_compaction
       session event: context_compacted
       messages = compacted message set
  -> continue normal model/tool loop
```

## 5.2 ContextCompactor

`ContextCompactor` 负责：

- 接收当前 goal、messages、recentActions、blockers、workflowState、latestContext。
- 选择应该保留的关键信息。
- 生成结构化 `CompactRunSummary`。
- 生成一段 compacted chat message，可放回 `messages`。
- 给出 token estimate。

`ContextCompactor` 不负责：

- 不调用 LLM。
- 不读 session 文件。
- 不读 trace 文件。
- 不执行工具。
- 不判断 permission。
- 不更新 workflow。
- 不写 session。

## 5.3 TokenBudget

`TokenBudget` 负责：

- 估算 messages tokens。
- 估算 tool result tokens。
- 判断是否达到 compact threshold。
- 返回 `TokenBudgetSnapshot`。

`TokenBudget` 不负责：

- 不决定怎么 compact。
- 不修改 messages。
- 不读 transcript。
- 不写 session。

## 5.4 runAgentLoop

`runAgentLoop` 继续负责：

- LLM 调用。
- tool call loop。
- policy / permission / HumanGate。
- ToolExecutionService 调用。
- workflow transition。
- session transcript/events。

Plan 5 只在 turn 边界加一个 compact check，不改变主循环结构。

## 6. 数据模型草案

## 6.1 CompactRunSummary

新增文件建议：

```text
packages/web-buddy/src/context/run-summary.ts
```

建议类型：

```ts
export interface CompactRunSummary {
  schemaVersion: 'compact-run-summary/v1'
  summaryId: string
  sessionId: string
  runId: string
  turnId?: string
  step: number
  createdAt: string

  goal: string
  workflow?: {
    phase: string
    reason?: string
    blocker?: string
    humanHandoffRequired?: boolean
  }

  page?: {
    url?: string
    title?: string
    pageType?: string
    textSummary?: string
  }

  form?: {
    fieldCount: number
    missingRequiredCount: number
    filledFieldCount: number
    submitCandidateCount: number
    uploadHintCount: number
  }

  recentActions: Array<{
    step: number
    toolName: string
    argumentsSummary: string
    status: string
    risk?: string
    observation?: string
    at: string
  }>

  blockers: string[]

  permissions: Array<{
    requestId?: string
    toolCallId?: string
    toolName?: string
    action: 'allow' | 'ask' | 'deny'
    gateKind?: string
    reason?: string
  }>

  approvals: Array<{
    approvalId?: string
    permissionRequestId?: string
    toolCallId?: string
    gateKind?: string
    status?: string
    decision?: string
  }>

  safetyNotes: string[]
  nextActionHints: string[]
  sourceMessageCount: number
  sourceEstimatedTokens: number
  summaryEstimatedTokens: number
}
```

## 6.2 ContextCompactionResult

```ts
export interface ContextCompactionResult {
  schemaVersion: 'context-compaction-result/v1'
  compacted: boolean
  reason: string
  summary: CompactRunSummary
  message: ChatMessage
  tokenBudget: TokenBudgetSnapshot
}
```

`message` 建议是普通 user message：

```text
COMPACTED_RUN_CONTEXT
<structured summary text>
```

注意：

- 不改 system prompt。
- 不改 tool schema。
- 不让模型看到完整历史里的旧 tool noise。

## 6.3 Session transcript entry

在 `session/session-types.ts` additive 增加：

```ts
export interface ContextCompactionEntry extends TranscriptEntryBase {
  type: 'context_compaction'
  summaryId: string
  reason: string
  tokenBudget: unknown
  summary: unknown
}
```

## 6.4 Kernel event type

在 `kernel/kernel-events.ts` additive 增加：

```ts
| 'context_compacted'
| 'token_budget_updated'
```

事件语义：

| Event | When | data |
|---|---|---|
| `token_budget_updated` | turn 边界预算估算后 | `{ tokenBudget }` |
| `context_compacted` | compact 执行后 | `{ summary, tokenBudget }` |

## 7. Compaction v1 规则

## 7.1 触发时机

只在安全的 turn 边界触发：

```text
一轮工具处理结束后
下一次 LLM 调用前
```

不要在这些时刻触发：

- 工具执行中。
- HumanGate 等待中。
- Permission deny 正在处理时。
- final submit blocked 分支中。
- abort 已经发生后。

## 7.2 触发条件

建议新增 `AgentLoopInput` 可选字段：

```ts
contextBudget?: {
  maxInputTokens?: number
  compactThresholdRatio?: number
  keepRecentMessages?: number
}
```

默认：

```text
maxInputTokens = undefined
compactThresholdRatio = 0.8
keepRecentMessages = 6
```

如果 `maxInputTokens` 不传，则默认不自动 compact，只记录 token budget snapshot。

测试可传很小阈值强制 compact。

## 7.3 保留策略

compact 后 messages 建议变成：

```text
system message       保留最新 renderSystemContext(latestContext)
user compact summary 新增 COMPACTED_RUN_CONTEXT
last N messages      保留最近 4-6 条，避免丢掉刚发生的 tool call/result
```

不要保留所有旧 `UPDATED_CONTEXT`。

不要保留大量旧 page snapshot。

## 7.4 Summary 内容优先级

必须保留：

1. goal。
2. workflow phase / blocker。
3. latest page title/url/pageType/textSummary。
4. form counts / missing required counts。
5. 最近 blocked/warn/error actions。
6. 最近成功的高价值 actions。
7. final submit / upload / login / captcha 的 permission/approval 状态。
8. 当前 blockers。
9. 下一步建议。

可以丢弃：

- 旧页面全量 snapshot。
- 重复 tool observation。
- 旧 `UPDATED_CONTEXT` 的完整内容。
- 成功但低价值的 observation 细节。

## 8. runAgentLoop 最小改造

## 8.1 AgentLoopInput additive fields

只新增可选字段：

```ts
contextBudget?: ContextBudgetOptions
contextCompactor?: ContextCompactor
```

要求：

- 不破坏旧调用。
- 默认不自动 compact，除非配置了 `maxInputTokens`。
- 测试可以注入 deterministic compactor。

## 8.2 集成位置

当前 turn 末尾已有：

```text
if (!done) {
  latestContext = await buildLoopContextWithWorkflow(...)
  workflow transition
  handoff check
  messages.push(UPDATED_CONTEXT)
}
```

Plan 5 建议在这里之后、下一轮开始前：

```text
messages.push(UPDATED_CONTEXT)
maybeCompactMessages()
sessionEvent(turn_completed)
```

也可以在 while 顶部、LLM 调用前：

```text
maybeCompactMessages()
llm.chatWithTools(messages)
```

推荐 while 顶部，因为它最接近模型调用，能保证预算判断覆盖所有已有消息。

## 8.3 `maybeCompactMessages()` 伪代码

```ts
const maybeCompactMessages = async (turnId: string) => {
  const tokenBudget = estimateTokenBudget(messages, input.contextBudget)
  await sessionEvent({ type: 'token_budget_updated', data: { tokenBudget } })

  if (!tokenBudget.compactRecommended) return

  const compaction = contextCompactor.compact({
    goal,
    runId,
    sessionId,
    turnId,
    step,
    messages,
    latestContext,
    workflowState,
    recentActions,
    blockers,
    keepRecentMessages,
  })

  await sessionTranscript({
    type: 'context_compaction',
    summaryId: compaction.summary.summaryId,
    reason: compaction.reason,
    tokenBudget: compaction.tokenBudget,
    summary: compaction.summary,
  })

  await sessionEvent({
    type: 'context_compacted',
    data: { summary: compaction.summary, tokenBudget: compaction.tokenBudget },
  })

  messages = [
    { role: 'system', content: renderSystemContext(latestContext) },
    compaction.message,
    ...tailMessages(messages, keepRecentMessages),
  ]
}
```

注意：目前 `messages` 是 `const`，实现时需要改成 `let messages`，这是局部改动，不是主循环重写。

## 9. Session 和恢复边界

Plan 5 v1 不做完整 resume，但 compact summary 必须为 resume 做准备。

session transcript 应该能解释：

```text
原始历史很长
在 turn_X 发生 context_compaction
summaryId 是什么
保留了哪些 workflow / permission / blocker 事实
compact 前后 token budget 是什么
```

未来 resume 可以：

```text
读取最近 context_compaction
读取之后的 transcript tail
重建 messages
继续任务
```

但这不是 Plan 5 的实现范围。

## 10. 目标文件结构

新增文件：

```text
packages/web-buddy/src/context/
  run-summary.ts
  compaction.ts

packages/web-buddy/scripts/
  context-compaction-test.mjs
  token-budget-test.mjs
```

修改文件：

```text
packages/web-buddy/src/kernel/token-budget.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/session/index.ts
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/package.json
```

可选修改：

```text
packages/web-buddy/src/kernel/query-loop.ts
packages/web-buddy/src/agent/types.ts
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
```

不应修改：

```text
packages/web-buddy/src/tools/tool-execution-service.ts
packages/web-buddy/src/tools/tool-contract.ts
packages/web-buddy/src/tools/catalog.ts
packages/web-buddy/src/policy/policy-engine.ts
packages/web-buddy/src/permission/permission-engine.ts
packages/web-buddy/src/sdk/human.ts
```

## 11. 测试计划

## 11.1 TokenBudget unit tests

新增：

```text
npm run test:token-budget
```

覆盖：

1. `estimateTokens()` 稳定。
2. `recordInputText()` 累加 input tokens。
3. `recordToolResultText()` 累加 tool result tokens。
4. `estimateChatMessages()` 能处理 system/user/assistant/tool。
5. `compactRecommended` 在超过 threshold 时为 true。
6. 未设置 `maxInputTokens` 时只估算，不推荐 compact。
7. 长 tool observation 会显著增加 estimate。

## 11.2 ContextCompactor unit tests

新增：

```text
npm run test:context-compaction
```

覆盖：

1. compact summary 保留 goal。
2. 保留 workflow phase / blocker。
3. 保留 latest page/form 摘要。
4. 保留 recent blocked/warn actions。
5. 保留 permission deny。
6. 保留 approval decision。
7. 丢弃旧大段 tool observation。
8. 输出 `COMPACTED_RUN_CONTEXT` message。
9. 不读取 trace artifact。

## 11.3 runAgentLoop integration tests

更新 `agent-loop-test.mjs` 或新增 `agent-loop-compaction-test.mjs`，覆盖：

1. 设置很低 `maxInputTokens` 后触发 compact。
2. session transcript 包含 `context_compaction`。
3. events 包含 `token_budget_updated` 和 `context_compacted`。
4. compact 后 loop 仍能继续执行下一步 tool。
5. compact 后 final submit / permission blocker 信息仍在模型可见消息中。
6. direct `runAgentLoop` 不传 contextBudget 时行为兼容。

## 11.4 Session compatibility tests

更新 session smoke test：

- 旧 transcript entries 仍存在。
- 新 `context_compaction` entry 是 additive。
- `AgentRuntimeResult` schema 不变。

## 11.5 Full verification

完成后运行：

```bash
cd packages/web-buddy
npm run build
npm run test:token-budget
npm run test:context-compaction
npm run test:context
npm run test:prompt-sections
npm run test:permission-engine
npm run test:approval-queue
npm run test:tool-execution-service
npm run test:kernel
npm run test:session
npm run test:agent-runtime
npm run test:agent-loop
npm run test:mvp
```

边界搜索：

```bash
rg -n "output/traces|page-state-latest|form-state-latest" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  packages/web-buddy/src/tools \
  packages/web-buddy/src/workflow \
  packages/web-buddy/src/session \
  packages/web-buddy/src/permission \
  --glob '*.ts'
```

## 12. 多 Agent 并行实施拆分

## 12.1 Agent A: Token budget

负责文件：

```text
packages/web-buddy/src/kernel/token-budget.ts
packages/web-buddy/scripts/token-budget-test.mjs
packages/web-buddy/package.json
```

任务：

- 扩展 token budget estimator。
- 支持 chat messages。
- 支持 threshold snapshot。
- 不接 runAgentLoop。

验证：

```bash
npm run build
npm run test:token-budget
```

## 12.2 Agent B: Compact summary types and compactor

负责文件：

```text
packages/web-buddy/src/context/run-summary.ts
packages/web-buddy/src/context/compaction.ts
packages/web-buddy/scripts/context-compaction-test.mjs
```

任务：

- 定义 summary 类型。
- 实现 deterministic compactor。
- 覆盖 goal/workflow/page/form/actions/permission/approval。
- 不读 session 文件，不读 trace。

验证：

```bash
npm run test:context-compaction
```

## 12.3 Agent C: Session/event additive types

负责文件：

```text
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/session/index.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
```

任务：

- 增加 `context_compaction` transcript entry。
- 增加 `token_budget_updated` / `context_compacted` events。
- 更新 session smoke。

验证：

```bash
npm run test:session
```

## 12.4 Agent D: runAgentLoop integration

负责文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/scripts/agent-loop-test.mjs
```

任务：

- 增加 `contextBudget` / `contextCompactor` optional input。
- 在 LLM call 前接 `maybeCompactMessages()`。
- 保持 direct call 兼容。
- 保持 permission / approval / final submit 语义不变。

验证：

```bash
npm run test:agent-loop
```

## 12.5 Agent E: Compatibility sweep

负责文件：

```text
packages/web-buddy/package.json
PLAN/phase2/README.md
```

任务：

- 加入测试脚本。
- `test:mvp` 加入 compaction tests。
- 跑完整回归。
- 补 completion explanation。

验证：

```bash
npm run test:mvp
git diff --check
```

## 13. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:token-budget` 通过。
3. `npm run test:context-compaction` 通过。
4. `npm run test:agent-loop` 通过。
5. `npm run test:kernel` 通过。
6. `npm run test:session` 通过。
7. `npm run test:agent-runtime` 通过。
8. `npm run test:mvp` 通过。
9. `git diff --check` 通过。
10. `runAgentLoop` 不传 `contextBudget` 时行为兼容。
11. `AgentRuntimeResult` schema 不变。
12. `ToolExecutionService` 没有新增 compaction 职责。
13. `PermissionEngine` 没有新增 compaction 职责。
14. compact 后保留 goal。
15. compact 后保留 workflow phase / blocker。
16. compact 后保留 permission deny / approval result。
17. compact 后保留 final submit safety context。
18. compact 后 loop 能继续执行工具。
19. session transcript 包含 `context_compaction`。
20. events 包含 `token_budget_updated` / `context_compacted`。
21. runtime/session/context 不读取 `output/traces`。
22. 不改变 prompt safety rules。
23. 不改变 tool schema。

## 14. 风险和规避

| 风险 | 规避 |
|---|---|
| compact 丢失关键安全信息 | summary 必须保留 permission / approval / blockers / final submit context，并加测试 |
| compact 后模型忘记当前页面 | 保留 latest page/form summary，并继续追加 UPDATED_CONTEXT |
| runAgentLoop 被重写 | 只在 LLM call 前加 `maybeCompactMessages()` |
| compactor 变成 LLM summarizer | v1 deterministic，不调用模型 |
| runtime 读取 trace artifact | 使用 ContextSnapshot / session state，边界搜索验收 |
| session reader 兼容性破坏 | transcript/event 只 additive |
| 默认行为改变 | 未设置 maxInputTokens 时不自动 compact |
| token estimate 不精确 | v1 只做 conservative estimate，验收看触发和信息保留，不追求 tokenizer 精度 |

## 15. 给实现 Agent 的提示词

```text
你正在实现 Phase 2E: Context Compaction v1 + Run Summary。

请先阅读：
- PLAN/phase2/README.md
- PLAN/phase2/plan4.md
- PLAN/phase2/plan4-completion-explanation.md
- PLAN/phase2/plan5.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/kernel/token-budget.ts
- packages/web-buddy/src/context/types.ts
- packages/web-buddy/src/context/context-manager.ts
- packages/web-buddy/src/agent/prompt-assembler.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/session/session-recorder.ts
- packages/web-buddy/src/kernel/kernel-events.ts

目标：
让 runAgentLoop 支持可选 contextBudget。当 messages 估算超过阈值时，用 deterministic ContextCompactor 生成 compact run summary，写入 session transcript/events，并用 compact summary + 最近消息继续模型循环。

硬约束：
- 不重写主循环。
- 不引入 WorkflowEngine。
- 不改变 tool schema。
- 不改变 final submit / permission / approval 语义。
- 不让 ToolExecutionService 参与 compaction。
- 不让 PermissionEngine 参与 compaction。
- 不读 output/traces。
- 不读 page-state-latest.json / form-state-latest.json。
- 未设置 maxInputTokens 时默认不自动 compact。

完成后运行：
- cd packages/web-buddy
- npm run build
- npm run test:token-budget
- npm run test:context-compaction
- npm run test:agent-loop
- npm run test:kernel
- npm run test:session
- npm run test:agent-runtime
- npm run test:mvp

边界搜索：
rg -n "output/traces|page-state-latest|form-state-latest" packages/web-buddy/src/agent packages/web-buddy/src/context packages/web-buddy/src/runtime/local packages/web-buddy/src/tools packages/web-buddy/src/workflow packages/web-buddy/src/session packages/web-buddy/src/permission --glob '*.ts'

最后输出：
- 变更摘要
- 测试结果
- 是否有残留风险
```

## 16. 完成后进入下一计划的条件

只有当 Phase 2E 满足以下条件，才进入 Plan 6:

- 长 messages 能触发 compact。
- compact summary 写入 session transcript。
- compact 后模型仍能继续执行任务。
- compact 后安全关键事实不丢失。
- runtime 不读取 trace artifact。
- 旧调用兼容。

Plan 6 才开始考虑：

- WorkflowEngine v1。
- Evidence system。
- final submit success criteria。
- persistent resume cursor。
- Task Cockpit 中展示 compact / evidence / approvals。
