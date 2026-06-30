# Phase 2 Plan 8: UserConfirmEvidence + Resume Completion v1

> 目标：Plan 7 已经让 `CompletionGate` 能把缺少完成证据的 `agent_done` 拦成 `blocked`。
> Plan 8 要补上被拦住之后的安全闭环：用户明确确认后，系统写入 `user_confirm` evidence，从 session transcript 恢复状态，重新裁决 completion，并把满足条件的 blocked session 推进到 completed。
>
> 本阶段仍不做完整 Task Cockpit UI，不做 SkillSystem，不做 Memory，不自动点击 final submit，不让 LLM 伪造 `user_confirm`，不读取 trace artifacts。

## 1. 为什么第八步做 UserConfirmEvidence + Resume Completion

Plan 7 后的关键链路是：

```text
agent_done blocked=false
  -> WorkflowEngine.evaluate(...)
  -> CompletionGate.evaluate(...)
  -> missing user_confirm
  -> final status = blocked
```

这一步让系统变安全了，但也带来一个新问题：

```text
系统已经知道为什么不能 completed，
但还没有一个安全方式让用户补确认并完成关单。
```

Plan 8 要补上的链路是：

```text
blocked session
  -> restore from session transcript
  -> user explicitly confirms completion
  -> write user_confirm evidence
  -> WorkflowEngine.evaluate(...)
  -> CompletionGate.evaluate(...)
  -> allow: session completed
  -> block: keep blocked with reason
```

第一性原理：

```text
LLM 不能自证完成。
用户确认必须成为独立 evidence。
Session transcript 是恢复事实源。
Runtime 最终状态必须由确定性裁决产生。
```

## 2. 当前代码关键上下文

## 2.1 user_confirm kind 已存在，但没有真实生产入口

文件：

```text
packages/web-buddy/src/workflow/workflow-evidence.ts
packages/web-buddy/src/workflow/workflow-definition.ts
```

当前 `EvidenceKind` 已包含：

```ts
'user_confirm'
```

当前 job application workflow 的 done criteria 需要：

```text
tool_result + user_confirm
```

但现在项目里还没有一个稳定入口由“用户确认动作”生成 `user_confirm` evidence。所以 Plan 7 之后，普通自动填表完成会正确停在：

```text
blocked: missing user_confirm
```

## 2.2 session transcript 已有恢复所需的主要事实

文件：

```text
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/session/session-store.ts
packages/web-buddy/src/session/transcript.ts
```

当前 transcript 已有：

```text
workflow_evidence
workflow_evaluation
workflow_snapshot
completion_gate
final_result
```

这意味着 Plan 8 不应该从 trace 里恢复运行态，而应该从 session transcript 恢复：

```text
latest workflow state
latest workflow evidence
latest workflow evaluation
latest completion gate decision
latest final result
```

## 2.3 CompletionGate 已经是纯裁决服务

文件：

```text
packages/web-buddy/src/workflow/completion-gate.ts
```

Plan 8 应该继续复用它，而不是在 session/resume 里重新写一套完成判断。

最小闭环是：

```text
RestoredSessionState + user_confirm evidence
  -> WorkflowEngine.evaluate(...)
  -> CompletionGate.evaluate(...)
  -> completed / blocked
```

## 3. 本阶段目标

完成后应具备：

1. 新增 session restore 能力，从 transcript 恢复 Plan 8 需要的最新事实。
2. 新增明确的 user confirmation 数据模型和 transcript/event。
3. 用户确认能生成 `user_confirm` workflow evidence。
4. 新增 completion resume / recheck 纯服务。
5. 对 blocked session，能在用户确认后重新跑 WorkflowEngine + CompletionGate。
6. 如果 criteria 满足，session 状态可推进到 completed。
7. 如果仍缺证据或存在 final submit blocker，session 继续 blocked。
8. LLM / tool result 不能伪造 `user_confirm`。
9. runtime/session/restore 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。
10. 不改变 `AgentRuntimeResult` / `AgentLoopResult` schema。

## 4. 非目标

本阶段明确不做：

- 不做完整 Task Cockpit UI。
- 不做 SkillSystem。
- 不做 Memory。
- 不做跨浏览器进程恢复执行工具。
- 不自动点击 final submit。
- 不放宽 final submit safety gate。
- 不让 LLM 通过 `agent_done` 生成 `user_confirm`。
- 不让 CompletionGate 执行工具。
- 不让 WorkflowEngine 修改 session。
- 不读取 trace artifacts。
- 不读取 `page-state-latest.json`。
- 不读取 `form-state-latest.json`。
- 不重写 `runAgentLoop`。

## 5. 职责边界

## 5.1 SessionRestore

`SessionRestore` 负责：

- 读取 `AgentSession`。
- 读取 session transcript JSONL。
- 提取最新 `workflow_snapshot`。
- 提取全部 `workflow_evidence`。
- 提取最新 `workflow_evaluation`。
- 提取最新 `completion_gate`。
- 提取最新 `final_result`。
- 输出可测试的 restored state。

`SessionRestore` 不负责：

- 不执行工具。
- 不调用 LLM。
- 不询问用户。
- 不改变 session 状态。
- 不读取 trace。

## 5.2 UserConfirmation

`UserConfirmation` 负责：

- 表达一次明确的人类确认。
- 生成 `user_confirm` evidence。
- 提供可写入 transcript/event 的结构化数据。

`UserConfirmation` 不负责：

- 不判断 workflow 是否完成。
- 不绕过 CompletionGate。
- 不执行 final submit。
- 不允许 LLM/tool 自动伪造确认。

## 5.3 CompletionResumeService

`CompletionResumeService` 负责：

- 接收 restored state 和 user confirmation。
- 重建/补齐 evidence snapshot。
- 调用 `WorkflowEngine.evaluate()`。
- 调用 `CompletionGate.evaluate()`。
- 返回 `completed` 或 `blocked` 的裁决结果。

`CompletionResumeService` 不负责：

- 不写 session。
- 不执行浏览器工具。
- 不调用 HumanGate。
- 不调用 LLM。
- 不读取 trace artifacts。

## 5.4 SessionCompletionService

`SessionCompletionService` 负责：

- 把 restore、user confirmation、completion resume 串起来。
- 写入 `user_confirmation` transcript。
- 写入 `workflow_evidence` transcript。
- 写入 `workflow_evaluation` transcript。
- 写入 `completion_gate` transcript。
- 写入 `user_confirmed` / `session_completion_rechecked` event。
- 根据裁决更新 session status。

`SessionCompletionService` 不负责：

- 不做 UI。
- 不执行工具。
- 不调用 LLM。
- 不绕过 final submit gate。

## 6. 数据模型草案

## 6.1 RestoredSessionState

建议新增：

```text
packages/web-buddy/src/session/session-restore.ts
```

建议类型：

```ts
export interface RestoredSessionState {
  schemaVersion: 'restored-session-state/v1'
  session: AgentSession
  transcriptCount: number
  restoredAt: string
  latestWorkflowState?: WorkflowState
  workflowEvidence: WorkflowEvidence[]
  latestWorkflowEvaluation?: WorkflowEngineEvaluation
  latestCompletionGate?: CompletionGateDecision
  latestFinalResult?: FinalResultEntry
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
}
```

## 6.2 UserConfirmation

建议新增：

```text
packages/web-buddy/src/workflow/user-confirmation.ts
```

建议类型：

```ts
export interface UserConfirmationInput {
  sessionId: string
  runId: string
  confirmedBy: 'user'
  message: string
  scope: 'completion'
  workflowPhase?: WorkflowPhase | string
  turnId?: string
  ts?: string
  metadata?: Record<string, unknown>
}

export interface UserConfirmation {
  schemaVersion: 'user-confirmation/v1'
  id: string
  sessionId: string
  runId: string
  confirmedBy: 'user'
  scope: 'completion'
  message: string
  ts: string
  workflowPhase?: WorkflowPhase | string
  evidence: WorkflowEvidence
}
```

关键限制：

```text
confirmedBy 只能是 'user'。
source 固定为 'user_confirmation'。
evidence.kind 固定为 'user_confirm'。
```

## 6.3 Session transcript / events

session transcript additive 新增：

```text
user_confirmation
```

session events additive 新增：

```text
user_confirmed
session_restored
session_completion_rechecked
```

事件至少记录：

- confirmation id。
- workflow phase。
- completion gate action。
- recommended status。
- missing criteria。
- blockers。

## 6.4 CompletionResumeResult

建议新增：

```text
packages/web-buddy/src/workflow/completion-resume.ts
```

建议类型：

```ts
export interface CompletionResumeInput {
  restored: RestoredSessionState
  confirmation?: UserConfirmation
  workflowEngine?: WorkflowEngine
  completionGate?: CompletionGate
  now?: string
}

export interface CompletionResumeResult {
  schemaVersion: 'completion-resume-result/v1'
  status: 'completed' | 'blocked'
  reason: string
  workflowEvaluation: WorkflowEngineEvaluation
  completionGateDecision: CompletionGateDecision
  evidence: WorkflowEvidence[]
}
```

## 7. v1 决策规则

1. 没有 user confirmation：
   - 不补 `user_confirm` evidence。
   - 重新裁决后通常仍 blocked。

2. 有 user confirmation：
   - 写入 `user_confirm` evidence。
   - 重新跑 WorkflowEngine。
   - 再跑 CompletionGate。

3. CompletionGate allow：
   - `CompletionResumeResult.status='completed'`。
   - session 可更新为 completed。

4. CompletionGate block：
   - `CompletionResumeResult.status='blocked'`。
   - session 保持 blocked，并更新 blockedReason。

5. workflow phase 是 `ready_for_final_submit` 或存在 final submit blocker：
   - 即使有 user confirmation，也不能自动执行 submit。
   - 如果 criteria 仍不满足，保持 blocked。

6. restored session 不是 blocked：
   - v1 可以允许 recheck，但不能把 failed/aborted 静默改成 completed。
   - failed/aborted 的恢复策略留到后续阶段。

## 8. 建议文件变更

新增：

```text
packages/web-buddy/src/session/session-restore.ts
packages/web-buddy/src/workflow/user-confirmation.ts
packages/web-buddy/src/workflow/completion-resume.ts
packages/web-buddy/src/session/session-completion.ts
packages/web-buddy/scripts/session-restore-test.mjs
packages/web-buddy/scripts/user-confirmation-test.mjs
packages/web-buddy/scripts/completion-resume-test.mjs
packages/web-buddy/scripts/session-completion-test.mjs
```

更新：

```text
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/session/index.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/package.json
```

## 9. 验收标准

新增验证入口：

```bash
npm run test:session-restore
npm run test:user-confirmation
npm run test:completion-resume
npm run test:session-completion
```

更新验证入口：

```bash
npm run test:workflow
npm run test:session
npm run test:mvp
```

关键验收：

- 能从 session transcript 恢复 workflow evidence / evaluation / completion gate / final result。
- `user_confirm` 只能由显式 user confirmation 入口生成。
- blocked session 缺 `user_confirm` 时，recheck 后仍 blocked。
- blocked session 补 `user_confirm` 后，满足 criteria 时可 completed。
- final submit blocker 不会因为 user confirmation 被自动点击或绕过。
- session transcript 写入 `user_confirmation`、`workflow_evidence`、`workflow_evaluation`、`completion_gate`。
- session events 写入 `session_restored`、`user_confirmed`、`session_completion_rechecked`。
- runtime/session/restore 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。

## 10. 多 Agent 执行顺序

建议：

```text
串行 1：
  Agent A：SessionRestore 基础能力。

并行 2：
  Agent B：UserConfirmation / user_confirm evidence。
  Agent C：CompletionResumeService 纯裁决逻辑。

串行 3：
  Agent D：SessionCompletionService 集成。

串行 4：
  Agent E：测试脚本、package scripts 和回归审查。

串行 5：
  Agent F：最终安全审查和文档补齐。
```

依赖关系：

```text
Agent A 先提供 restored state。
Agent B 提供 user_confirm evidence 的可信入口。
Agent C 可先用 mocked restored state 开发纯逻辑，但最终要对齐 A/B 类型。
Agent D 必须等 A/B/C 合并后再串接 session。
Agent E/F 在最后做回归和边界审查。
```
