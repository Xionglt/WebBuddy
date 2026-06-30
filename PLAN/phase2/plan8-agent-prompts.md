# Plan 8 Agent Prompts: UserConfirmEvidence + Resume Completion v1

> 这些 prompt 用于把 Plan 8 分给多个 agent 串行/并行实现。
> 每个 prompt 都包含必要上下文、关键文件和明确边界，避免 agent 读取过多无关内容。

## 0. 总执行顺序

```text
1. 串行先跑 Agent A。

2. Agent A 合并后，并行跑：
   - Agent B
   - Agent C

3. Agent B / C 合并后，串行跑 Agent D。

4. Agent D 合并后，串行跑 Agent E。

5. Agent E 合并后，串行跑 Agent F。
```

为什么这样排：

```text
SessionRestore 是后面所有 resume/recheck 的事实输入，所以 A 先跑。
UserConfirmation 和 CompletionResume 可以并行，因为 B 管可信确认入口，C 管纯裁决逻辑。
SessionCompletion 要等 restore、confirmation、resume 三块都有了才能集成。
最后再统一补测试脚本、package scripts、安全回归和文档。
```

## 1. 共享背景

仓库路径：

```text
/Users/sunqiankai/开源项目/multi-functional-agent
```

Plan 8 目标：

```text
让 Plan 7 被 CompletionGate 拦住的 blocked session，可以在用户明确确认后补 user_confirm evidence，恢复 session 状态，重新裁决 completion，并在满足 criteria 时推进到 completed。
```

当前关键事实：

- Plan 6 已实现 `WorkflowEngine` / `EvidenceStore` / `workflow_evidence` / `workflow_evaluation`。
- Plan 7 已实现 `CompletionGate` / `completion_gate` / `completion_gate_evaluated`。
- 当前 `EvidenceKind` 已包含 `user_confirm`。
- 当前 done criteria 需要 `tool_result + user_confirm`。
- 当前还没有真实生产入口生成 `user_confirm` evidence。
- 当前 session transcript 已能记录 workflow evidence/evaluation/completion gate/final result。

关键文件：

```text
PLAN/phase2/plan8.md
packages/web-buddy/src/workflow/workflow-evidence.ts
packages/web-buddy/src/workflow/workflow-definition.ts
packages/web-buddy/src/workflow/workflow-engine.ts
packages/web-buddy/src/workflow/completion-gate.ts
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/session/session-store.ts
packages/web-buddy/src/session/session-recorder.ts
packages/web-buddy/src/session/transcript.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/package.json
```

必要上下文摘录：

```ts
// packages/web-buddy/src/workflow/workflow-evidence.ts
export type EvidenceKind =
  | 'page'
  | 'form'
  | 'tool_result'
  | 'policy'
  | 'permission'
  | 'approval'
  | 'user_confirm'
  | 'screenshot'
  | 'workflow_state'
  | 'context_summary'
  | 'other'
  | (string & {})
```

```text
// packages/web-buddy/src/workflow/workflow-definition.ts
done phase requiredEvidenceKinds:
  tool_result + user_confirm
```

```text
// packages/web-buddy/src/session/session-types.ts
TranscriptEntry 已包含：
  workflow_snapshot
  workflow_evidence
  workflow_evaluation
  completion_gate
  final_result
```

全局边界：

- 不重写 `runAgentLoop`。
- 不改变 tool schema。
- 不改变 `AgentRuntimeResult` / `AgentLoopResult` schema。
- 不做完整 Task Cockpit UI。
- 不做 SkillSystem。
- 不做 Memory。
- 不自动点击 final submit。
- 不放宽 final submit safety gate。
- 不让 LLM/tool result 伪造 `user_confirm`。
- 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。
- 不在各 agent 内自行 push；最后由主线程统一审查、提交、推送。

## 2. Agent A Prompt: SessionRestore 基础能力

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：实现 Plan8 的 SessionRestore 基础能力，从 session transcript 恢复后续 completion recheck 所需的最新事实。

必须阅读：
- PLAN/phase2/plan8.md
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/session/session-store.ts
- packages/web-buddy/src/session/transcript.ts
- packages/web-buddy/src/workflow/workflow-evidence.ts
- packages/web-buddy/src/workflow/workflow-engine.ts
- packages/web-buddy/src/workflow/completion-gate.ts

必要上下文：
- transcript JSONL 是运行时恢复事实源。
- readJsonLines 已存在于 packages/web-buddy/src/session/transcript.ts。
- 当前 transcript entry 已包含 workflow_snapshot、workflow_evidence、workflow_evaluation、completion_gate、final_result。
- 不要读取 output/traces、page-state-latest.json、form-state-latest.json。

任务：
1. 新增 packages/web-buddy/src/session/session-restore.ts。
2. 定义 RestoredSessionState，至少包含：
   - schemaVersion: 'restored-session-state/v1'
   - session
   - transcriptCount
   - restoredAt
   - latestWorkflowState
   - workflowEvidence
   - latestWorkflowEvaluation
   - latestCompletionGate
   - latestFinalResult
   - missingCriteria
   - blockers
3. 实现 restoreSessionState(input)，建议支持：
   - store + sessionId
   - 或直接传 AgentSession
4. 读取 session.transcriptPath，并按 transcript 顺序提取最新 entry。
5. workflowEvidence 要收集所有 workflow_evidence.evidence。
6. missingCriteria / blockers 优先来自 latestWorkflowEvaluation；如果没有，再从 latestCompletionGate 补。
7. 从 packages/web-buddy/src/session/index.ts 导出新能力。
8. 新增 packages/web-buddy/scripts/session-restore-test.mjs。
9. 更新 package.json 增加 test:session-restore。

边界：
- 不写 session。
- 不改 session status。
- 不调用 WorkflowEngine。
- 不调用 CompletionGate。
- 不执行工具。
- 不调用 LLM。
- 不读取 trace artifacts。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:session-restore
```

## 3. Agent B Prompt: UserConfirmation / user_confirm evidence

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：实现 Plan8 的用户确认数据模型，让显式用户确认可以生成可信的 user_confirm workflow evidence。

必须阅读：
- PLAN/phase2/plan8.md
- packages/web-buddy/src/workflow/workflow-evidence.ts
- packages/web-buddy/src/workflow/workflow-definition.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/kernel/kernel-events.ts
- packages/web-buddy/scripts/workflow-evidence-test.mjs

必要上下文：
- EvidenceKind 已有 user_confirm。
- done criteria 需要 tool_result + user_confirm。
- 现在没有生产入口生成 user_confirm。
- Plan8 要保证 LLM/tool result 不能伪造用户确认。

任务：
1. 新增 packages/web-buddy/src/workflow/user-confirmation.ts。
2. 定义：
   - UserConfirmationInput
   - UserConfirmation
   - createUserConfirmation(input)
3. createUserConfirmation 必须生成：
   - schemaVersion: 'user-confirmation/v1'
   - confirmedBy: 'user'
   - scope: 'completion'
   - evidence.kind = 'user_confirm'
   - evidence.source = 'user_confirmation'
   - evidence.sessionId / runId / turnId
   - evidence.summary 来自用户确认 message 的安全摘要
4. confirmedBy 类型只允许 'user'，不要接受 'assistant'、'tool'、'llm'。
5. session-types.ts additive 新增 transcript entry：
   - UserConfirmationEntry
   - type: 'user_confirmation'
   - confirmation: unknown
6. kernel-events.ts additive 新增：
   - user_confirmed
7. session/index.ts 导出新 entry 类型和 user-confirmation 模块。
8. 新增 packages/web-buddy/scripts/user-confirmation-test.mjs。
9. 更新 package.json 增加 test:user-confirmation。

边界：
- 不判断 workflow 是否完成。
- 不调用 CompletionGate。
- 不写 session。
- 不执行工具。
- 不调用 LLM。
- 不自动点击 final submit。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:user-confirmation
```

## 4. Agent C Prompt: CompletionResumeService 纯裁决逻辑

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：实现 Plan8 的 CompletionResumeService 纯逻辑，输入 restored state 和可选 user confirmation，重新跑 WorkflowEngine + CompletionGate，输出 completed/blocked 裁决。

必须阅读：
- PLAN/phase2/plan8.md
- packages/web-buddy/src/session/session-restore.ts
- packages/web-buddy/src/workflow/user-confirmation.ts
- packages/web-buddy/src/workflow/workflow-engine.ts
- packages/web-buddy/src/workflow/workflow-evidence.ts
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/scripts/completion-gate-test.mjs
- packages/web-buddy/scripts/workflow-engine-test.mjs

必要上下文：
- WorkflowEngine.evaluate(input) 接收 previous、evidenceSnapshot、recentActions 等。
- CompletionGate.evaluate(input) 接收 done/blocked、workflowState、workflowEvaluation。
- CompletionResumeService 必须是纯服务，不写 session。
- 没有 user_confirm 时，缺 evidence 的 blocked session 应继续 blocked。
- 有 user_confirm 且 done criteria 满足时，才允许 completed。

任务：
1. 新增 packages/web-buddy/src/workflow/completion-resume.ts。
2. 定义：
   - CompletionResumeInput
   - CompletionResumeResult
   - CompletionResumeService
   - completionResumeService 默认实例
3. CompletionResumeInput 至少包含：
   - restored: RestoredSessionState
   - confirmation?: UserConfirmation
   - workflowEngine?: WorkflowEngine
   - completionGate?: CompletionGate
   - now?: string
4. 组合 evidence：
   - restored.workflowEvidence
   - confirmation.evidence（如果存在）
5. 调用 WorkflowEngine.evaluate：
   - previous 使用 restored.latestWorkflowState，缺失时用 observing 初始状态或合理默认。
   - evidenceSnapshot 使用组合后的 evidence。
   - recentActions 至少包含 agent_done/tool_result 相关恢复事实；不要凭空制造 user_confirm。
6. 调用 CompletionGate.evaluate：
   - done=true
   - blocked=false
   - summary 使用 latestFinalResult/recheck reason
   - workflowState/evaluation 使用新 evaluation
   - source='resume_completion'
7. 输出：
   - status = allow ? completed : blocked
   - reason
   - workflowEvaluation
   - completionGateDecision
   - evidence
8. 新增 packages/web-buddy/scripts/completion-resume-test.mjs。
9. 更新 package.json 增加 test:completion-resume。

边界：
- 不写 session。
- 不改 session status。
- 不执行浏览器工具。
- 不调用 HumanGate。
- 不调用 LLM。
- 不读取 trace artifacts。
- 不绕过 final submit blocker。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:completion-resume
```

## 5. Agent D Prompt: SessionCompletionService 集成

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：把 SessionRestore、UserConfirmation、CompletionResumeService 串成一个 session-level 的确认完成入口。

必须阅读：
- PLAN/phase2/plan8.md
- packages/web-buddy/src/session/session-restore.ts
- packages/web-buddy/src/workflow/user-confirmation.ts
- packages/web-buddy/src/workflow/completion-resume.ts
- packages/web-buddy/src/session/session-recorder.ts
- packages/web-buddy/src/session/session-store.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/kernel/kernel-events.ts
- packages/web-buddy/scripts/session-store-test.mjs

必要上下文：
- FileSessionRecorder 可以写 transcript/event/workflow/status。
- SessionStore.update 可以更新 session status。
- CompletionResumeService 本身不写 session。
- 本 agent 负责把确认、evidence、evaluation、gate decision 和 final_result 追加回 session。

任务：
1. 新增 packages/web-buddy/src/session/session-completion.ts。
2. 定义：
   - ConfirmSessionCompletionInput
   - ConfirmSessionCompletionResult
   - confirmSessionCompletion(input)
3. 输入建议：
   - store: SessionStore
   - sessionId: string
   - message: string
   - confirmedBy: 'user'
   - now?: string
4. 实现流程：
   - 读取 session。
   - 调用 restoreSessionState。
   - 写 session_restored event。
   - 调用 createUserConfirmation。
   - 写 user_confirmation transcript。
   - 写 user_confirmed event。
   - 调用 CompletionResumeService。
   - 写 workflow_evidence transcript。
   - 写 workflow_evaluation transcript。
   - 写 completion_gate transcript。
   - 写 session_completion_rechecked event。
   - 如果 result.status='completed'，写 final_result completed 并 updateStatus completed。
   - 如果 result.status='blocked'，写 final_result blocked 并 updateStatus blocked。
5. kernel-events.ts 增加：
   - session_restored
   - session_completion_rechecked
6. session/index.ts 导出新服务。
7. 新增 packages/web-buddy/scripts/session-completion-test.mjs。
8. 更新 package.json 增加 test:session-completion。

边界：
- 不做 UI。
- 不执行工具。
- 不调用 LLM。
- 不自动点击 final submit。
- 不把 failed/aborted session 静默改成 completed。
- 不读取 trace artifacts。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:session-completion
```

## 6. Agent E Prompt: 测试脚本、package scripts 和回归链

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：补齐 Plan8 的 package scripts、集成测试覆盖和核心回归链，确保新能力不是孤立单测。

必须阅读：
- PLAN/phase2/plan8.md
- packages/web-buddy/package.json
- packages/web-buddy/scripts/session-restore-test.mjs
- packages/web-buddy/scripts/user-confirmation-test.mjs
- packages/web-buddy/scripts/completion-resume-test.mjs
- packages/web-buddy/scripts/session-completion-test.mjs
- packages/web-buddy/scripts/session-runtime-smoke-test.mjs
- packages/web-buddy/scripts/agent-kernel-test.mjs

任务：
1. 确认 package.json 有：
   - test:session-restore
   - test:user-confirmation
   - test:completion-resume
   - test:session-completion
2. 把合适的测试加入：
   - test:workflow
   - test:session
   - test:mvp
3. 补齐缺失测试场景：
   - restore 能读 workflow_evidence/evaluation/completion_gate/final_result。
   - no user_confirm 时 completion resume 仍 blocked。
   - user_confirm 后 criteria 满足才 completed。
   - final submit blocker 不会被 user_confirm 绕过。
   - confirmSessionCompletion 会写 transcript/events/status。
4. 跑回归：
   - npm --prefix packages/web-buddy run build
   - npm --prefix packages/web-buddy run test:workflow
   - npm --prefix packages/web-buddy run test:session
   - npm --prefix packages/web-buddy run test:agent-runtime
   - npm --prefix packages/web-buddy run test:kernel

边界：
- 不改生产逻辑，除非测试暴露明确小 bug。
- 不放宽安全断言。
- 不删除旧测试。
- 不读取 trace artifacts。

验收：
- 上述测试通过。
- git diff --check 通过。
```

## 7. Agent F Prompt: 最终安全审查和文档补齐

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：对 Plan8 做最终审查，确认安全边界、恢复事实源、测试覆盖和 phase2 文档都完整。

必须阅读：
- PLAN/phase2/README.md
- PLAN/phase2/plan8.md
- PLAN/phase2/plan8-agent-prompts.md
- packages/web-buddy/src/session/session-restore.ts
- packages/web-buddy/src/workflow/user-confirmation.ts
- packages/web-buddy/src/workflow/completion-resume.ts
- packages/web-buddy/src/session/session-completion.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/kernel/kernel-events.ts
- packages/web-buddy/package.json

审查重点：
1. user_confirm 是否只能来自显式用户确认入口。
2. CompletionResumeService 是否仍通过 WorkflowEngine + CompletionGate 裁决。
3. final submit blocker 是否仍不能被绕过。
4. restore/session/completion 是否读取 trace artifacts。
5. transcript/events 是否 additive。
6. failed/aborted session 是否不会被静默改成 completed。
7. package scripts 是否覆盖 Plan8 新测试。

必须运行：
- rg -n "output/traces|page-state-latest|form-state-latest" packages/web-buddy/src/session packages/web-buddy/src/workflow packages/web-buddy/src/runtime/local --glob '*.ts'
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:workflow
- npm --prefix packages/web-buddy run test:session
- npm --prefix packages/web-buddy run test:agent-runtime
- npm --prefix packages/web-buddy run test:kernel
- git diff --check

如发现问题：
- 只做最小边界修复。
- 不做无关重构。
- 不改变 tool schema。
- 不推送。

文档：
- 如果实现完成，新增 PLAN/phase2/plan8-completion-explanation.md。
- README 补 Plan8 completion 入口。
- 文档只沉淀 Plan8 已完成内容，不写下一阶段 agent prompt。
```
