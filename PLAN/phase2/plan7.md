# Phase 2 Plan 7: CompletionGate v1 + WorkflowGuard v1

> 目标：Plan 6 已经让 `WorkflowEngine` 产出 `matchedCriteria` / `missingCriteria` / `blockers`，并把这些判断写入 session。
> Plan 7 要把这些 workflow evidence 结果接入 runtime 完成裁决：LLM 可以提议完成，但 Runtime 必须根据 Workflow/Evidence 裁决是否真的 completed。
>
> 本阶段仍不重写 `runAgentLoop`，不做 Resume / SkillSystem / Task Cockpit，不改变 tool schema，不放宽 final submit 安全语义，不读取 trace artifacts。

## 1. 为什么第七步做 CompletionGate

Plan 6 已经做到：

```text
agent_done blocked=false
  -> WorkflowEngine.evaluate(...)
  -> workflow_evaluation 里能看到 missingCriteria
```

但当前 runtime 仍保持兼容语义：

```text
done && !blocked
  -> completed
```

也就是说，Plan 6 让“证据不足”变得可见、可审计、可压缩，但还没有让它真正影响最终完成状态。

Plan 7 要补上这一层：

```text
LLM calls agent_done
  -> WorkflowEngine.evaluate()
  -> CompletionGate.evaluate()
  -> allow: completed
  -> block: blocked / needs human review
```

第一性原理：

```text
LLM 可以提议完成。
Runtime 才能裁决完成。
Workflow evidence 是裁决依据。
```

## 2. 当前代码关键上下文

## 2.1 WorkflowEngineEvaluation 已经存在

文件：

```text
packages/web-buddy/src/workflow/workflow-engine.ts
```

当前核心输出：

```ts
export interface WorkflowEngineEvaluation {
  state: WorkflowState
  changed: boolean
  matchedCriteria: WorkflowCriterionMatch[]
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  evidenceIds: string[]
  reason: string
}
```

Plan 7 应该复用这个结构，不改它的 shape。

## 2.2 agent_done 已经会触发 workflow evaluation

文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
```

现状：

```text
agent_done 执行前：
  evaluateWorkflow(step, 'Before agent_done.', ...)

agent_done 执行后：
  result.done -> done = true
  blocked = result.data.blocked
  evaluateWorkflow(step, '<tool> updated workflow state.', ...)
```

但 evaluate 完后还没有 gate 来改写 `done/blocked/summary`。

## 2.3 最终状态仍只看 done / blocked

文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
```

现状：

```ts
await finalizeSession(
  done && !blocked ? 'completed' : 'blocked',
  { steps: step, toolCalls, done, blocked, summary, workflowState },
  done && !blocked ? undefined : summary,
)
```

Plan 7 的最小接入点是：在 `agent_done` 后拿到最新 `WorkflowEngineEvaluation`，调用 CompletionGate，如果 gate block completion，就把 `blocked=true`、`summary=gate.reason`。

## 2.4 测试当前明确保留兼容语义

文件：

```text
packages/web-buddy/scripts/agent-loop-test.mjs
```

当前测试断言：

```text
agent_done scenario should preserve unblocked completion
agent_done should surface missing explicit user confirmation evidence
```

Plan 7 要把这个测试改成：

```text
agent_done 缺少 required evidence -> runtime blocked
completion_gate transcript/event 被写入
```

## 3. 本阶段目标

完成后应具备：

1. 新增 `workflow/completion-gate.ts`。
2. 定义 `CompletionGateInput` / `CompletionGateDecision`。
3. `CompletionGate` 能基于 `WorkflowEngineEvaluation` 判断完成是否允许。
4. session transcript/events 支持 completion gate audit。
5. `runAgentLoop` 在 `agent_done` 后调用 CompletionGate。
6. completion gate block 时，runtime final status 必须变成 blocked。
7. completion gate allow 时，runtime 仍可 completed。
8. final submit approve 后仍不会执行 submit tool。
9. `AgentRuntimeResult` / `AgentLoopResult` schema 不变。
10. no-tool-call 结束分支保持兼容，不在 v1 强行扩展。

## 4. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不做完整 Resume / Restore。
- 不做 SkillSystem。
- 不做 Task Cockpit UI。
- 不做 Memory。
- 不改变 tool schema。
- 不改变 prompt safety rule。
- 不让 CompletionGate 执行工具。
- 不让 CompletionGate 调用 HumanGate。
- 不让 CompletionGate 调用 LLM。
- 不读取 `output/traces`。
- 不读取 `page-state-latest.json`。
- 不读取 `form-state-latest.json`。
- 不自动点击 final submit。
- 不把 no-tool-call narration 全部改为 blocked。

## 5. 职责边界

## 5.1 CompletionGate

`CompletionGate` 负责：

- 接收 runtime done/blocked、workflow state、latest workflow evaluation。
- 判断这次 completion 是否允许。
- 返回 allow / block / ignore。
- 给出 reason、missingCriteria、blockers、recommendedStatus。

`CompletionGate` 不负责：

- 不执行工具。
- 不调用 HumanGate。
- 不修改 evidence store。
- 不写 session。
- 不改 prompt/messages。
- 不读 trace artifacts。

## 5.2 runAgentLoop

`runAgentLoop` 继续负责：

- 在 `agent_done` 后调用 CompletionGate。
- 将 gate decision 映射成 `done/blocked/summary`。
- 写 session transcript/event。
- 最终仍通过现有 `finalizeSession()` 结束。

## 6. 数据模型草案

新增文件：

```text
packages/web-buddy/src/workflow/completion-gate.ts
```

建议类型：

```ts
export type CompletionGateAction = 'allow' | 'block' | 'ignore'
export type CompletionGateRecommendedStatus = 'completed' | 'blocked' | 'unchanged'

export interface CompletionGateInput {
  done: boolean
  blocked: boolean
  summary?: string
  workflowState?: WorkflowState
  workflowEvaluation?: WorkflowEngineEvaluation
  source?: 'agent_done' | 'finalize' | 'manual' | string
}

export interface CompletionGateDecision {
  schemaVersion: 'completion-gate-decision/v1'
  action: CompletionGateAction
  recommendedStatus: CompletionGateRecommendedStatus
  reason: string
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  workflowPhase?: WorkflowPhase | string
  evidenceIds: string[]
}
```

## 7. v1 决策规则

建议规则：

1. `done=false`：
   - `action='ignore'`
   - `recommendedStatus='unchanged'`

2. `blocked=true`：
   - `action='block'`
   - `recommendedStatus='blocked'`
   - 保持原 blocker，不放行。

3. 没有 workflow evaluation：
   - v1 保守但兼容：`ignore`。
   - 只在 `agent_done` 后强制 gate。

4. workflow phase 是 `ready_for_final_submit`：
   - `block`
   - reason 包含 final submit / manual takeover。

5. workflow blockers 中存在 `gateKind='final_submit'`：
   - `block`

6. workflow evaluation 中存在 required missing criteria：
   - `block`
   - reason 说明 missing criteria。

7. workflow phase 是 `done` 且没有 required missing criteria：
   - `allow`
   - `recommendedStatus='completed'`

8. workflow phase 是 `blocked`：
   - `block`

## 8. Session / Events

session transcript 新增 additive entry：

```text
completion_gate
```

session events 新增：

```text
completion_gate_evaluated
```

entry/event 至少记录：

- decision action。
- recommendedStatus。
- reason。
- workflow phase。
- missingCriteria。
- blockers。
- evidenceIds。

## 9. runAgentLoop 接入点

最小接入点：

```text
tool result done=true
  -> evaluateWorkflow(...)
  -> completionGate.evaluate(...)
  -> write completion_gate
  -> if block:
       blocked = true
       done = true
       summary = decision.reason
```

v1 不处理或尽量不改变：

```text
completion.toolCalls.length === 0
```

因为 no-tool-call 可能只是模型自然结束，当前兼容行为先保留。

## 10. 验收标准

新增验证入口：

```bash
npm run test:completion-gate
```

更新验证入口：

```bash
npm run test:workflow
npm run test:agent-loop
npm run test:session
npm run test:context-compaction
```

关键验收：

- `agent_done blocked=false` 但缺 required evidence 时，runtime final status 是 blocked。
- session transcript 写入 `completion_gate`。
- session events 写入 `completion_gate_evaluated`。
- final submit approve 后仍 blocked，且 submit tool 不执行。
- permission deny 仍 blocked。
- `AgentRuntimeResult` / `AgentLoopResult` schema 不变。
- CompletionGate 不执行工具、不调用 HumanGate、不读 trace artifacts。
- `test:mvp` 不回归。

## 11. 多 Agent 执行顺序

建议：

```text
串行 1：
  Agent A：CompletionGate 数据模型和纯判断逻辑。

并行 2：
  Agent B：CompletionGate 单元测试。
  Agent C：Session transcript/events 扩展。
  Agent D：agent-loop 集成点审查。

串行 3：
  Agent E：接入 runAgentLoop。

并行 4：
  Agent F：集成测试和回归验证。
  Agent G：最终审查。
```
