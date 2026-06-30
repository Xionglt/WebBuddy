# Plan 7 Agent Prompts: CompletionGate v1 + WorkflowGuard v1

> 这些 prompt 用于把 Plan 7 分给多个 agent 并行/串行实现。
> 每个 prompt 都包含必要上下文、关键文件和边界，避免 agent 需要翻太多文件，也避免一次性塞入过多无关信息。

## 0. 共享背景

仓库路径：

```text
/Users/sunqiankai/开源项目/multi-functional-agent
```

Plan 7 目标：

```text
让 WorkflowEngine 的 missingCriteria 真正影响 runtime 最终完成状态。
```

当前状态：

- Plan 6 已实现 `WorkflowEngine`、`WorkflowEvidence`、`workflow_evaluation`。
- 当前 `agent_done blocked=false` 即使缺 `user_confirm` evidence，也仍会 completed。
- Plan 7 要新增 `CompletionGate`，在 `agent_done` 后裁决是否真的允许 completed。

关键文件：

```text
packages/web-buddy/src/workflow/workflow-engine.ts
packages/web-buddy/src/workflow/workflow-definition.ts
packages/web-buddy/src/workflow/workflow-evidence.ts
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/scripts/workflow-engine-test.mjs
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
packages/web-buddy/package.json
```

关键现状摘录：

```ts
// packages/web-buddy/src/workflow/workflow-engine.ts
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

```text
// packages/web-buddy/src/runtime/local/agent-loop.ts
agent_done 执行前会 evaluateWorkflow('Before agent_done.')
agent_done 执行后会 evaluateWorkflow('<tool> updated workflow state.')
最终 finalizeSession 仍按 done && !blocked ? completed : blocked 判断。
```

```text
// packages/web-buddy/scripts/agent-loop-test.mjs
当前测试断言 agent_done blocked=false 仍 completed，
同时只要求 workflow_evaluation 里能看到 missing user_confirm。
Plan 7 需要把这条测试改为缺 required evidence 时 blocked。
```

全局边界：

- 不重写 `runAgentLoop`。
- 不改变 tool schema。
- 不改变 `AgentRuntimeResult` / `AgentLoopResult` schema。
- 不放宽 final submit。
- 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。
- 不做 Resume / SkillSystem / Task Cockpit / Memory。

## 1. Agent A Prompt: CompletionGate 数据模型和纯判断逻辑

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：实现 Plan7 的 CompletionGate / WorkflowGuard v1 数据模型和纯判断逻辑，不接入 runAgentLoop。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/workflow/workflow-engine.ts
- packages/web-buddy/src/workflow/workflow-definition.ts
- packages/web-buddy/src/workflow/workflow-state.ts

必要上下文：
- WorkflowEngineEvaluation 已有字段：state、changed、matchedCriteria、missingCriteria、blockers、evidenceIds、reason。
- WorkflowCriterionMissing 有 id、kind、description、phase、evidenceKinds、missingEvidenceKinds、evidenceIds、reason。
- WorkflowBlocker 有 id、kind、message、phase、gateKind、criterionId、missingEvidenceKinds、evidenceIds。
- Plan 6 当前只记录 missingCriteria，不阻止 completed。

任务：
1. 新增 packages/web-buddy/src/workflow/completion-gate.ts。
2. 定义：
   - CompletionGateAction = 'allow' | 'block' | 'ignore'
   - CompletionGateRecommendedStatus = 'completed' | 'blocked' | 'unchanged'
   - CompletionGateInput
   - CompletionGateDecision
   - CompletionGate class
   - completionGate 默认实例
3. 实现 CompletionGate.evaluate(input)。
4. 决策规则：
   - done=false -> ignore / unchanged。
   - blocked=true -> block / blocked。
   - 缺 workflowEvaluation -> ignore / unchanged。
   - workflow phase = ready_for_final_submit -> block。
   - workflow phase = blocked -> block。
   - blockers 中有 gateKind='final_submit' -> block。
   - missingCriteria 中有 required/关键 missing evidence -> block。
   - workflow phase = done 且无 missingCriteria -> allow / completed。
5. reason 要清楚，能用于 session summary。
6. 导出类型，供 agent-loop 和测试使用。

边界：
- 不接入 runAgentLoop。
- 不写 session。
- 不执行工具。
- 不调用 HumanGate。
- 不调用 LLM。
- 不读取 trace artifacts。
- 不改变 WorkflowEngineEvaluation shape。

验收：
- npm --prefix packages/web-buddy run build
```

## 2. Agent B Prompt: CompletionGate 单元测试

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：给 CompletionGate v1 补单元测试。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/scripts/workflow-engine-test.mjs
- packages/web-buddy/package.json

必要上下文：
- test:workflow 当前会跑 workflow-state-test、workflow-transition-test、workflow-evidence-test、workflow-engine-test。
- Plan7 需要新增 test:completion-gate，并加入 test:workflow。
- 测试风格是 Node assert 脚本，不使用 Jest/Vitest。

任务：
1. 新增 packages/web-buddy/scripts/completion-gate-test.mjs。
2. 覆盖场景：
   - done=false -> action ignore。
   - blocked=true -> action block。
   - done=true + no workflowEvaluation -> ignore。
   - done=true + phase ready_for_final_submit -> block。
   - done=true + final_submit blocker -> block。
   - done=true + missing user_confirm criterion -> block。
   - done=true + phase done + no missingCriteria -> allow。
3. 更新 packages/web-buddy/package.json：
   - 增加 test:completion-gate。
   - 把 completion-gate-test 加入 test:workflow。
4. 测试数据尽量手写最小 WorkflowEngineEvaluation，不依赖真实浏览器。

边界：
- 只测 CompletionGate。
- 不接入 agent-loop。
- 不读取 trace artifacts。
- 不改无关测试。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:completion-gate
- npm --prefix packages/web-buddy run test:workflow
```

## 3. Agent C Prompt: Session Transcript / Events 扩展

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：为 CompletionGate 增加 additive session audit 类型。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/src/kernel/kernel-events.ts
- packages/web-buddy/scripts/session-store-test.mjs
- packages/web-buddy/scripts/session-runtime-smoke-test.mjs

必要上下文：
- session-types.ts 已有 workflow_evidence / workflow_evaluation。
- KernelEvent type 已是 string union，需要 additive 加 completion_gate_evaluated。
- session tests 使用 FileSessionStore 写入 transcript/events 并断言类型存在。

任务：
1. 在 session-types.ts 新增 transcript entry：
   - CompletionGateEntry
   - type: 'completion_gate'
   - decision: unknown
2. 把 CompletionGateEntry 加入 TranscriptEntry union。
3. 在 kernel-events.ts 增加 event type：
   - completion_gate_evaluated
4. 更新 session-store-test.mjs 和 session-runtime-smoke-test.mjs：
   - 写入 completion_gate entry。
   - 写入 completion_gate_evaluated event。
   - 断言可以读取。

建议 entry 内容：
- decision.action
- decision.recommendedStatus
- decision.reason
- decision.missingCriteria
- decision.blockers
- decision.workflowPhase
- decision.evidenceIds

边界：
- additive only，不删除旧 entry。
- 不接入 runAgentLoop。
- 不改变 AgentRuntimeResult schema。
- 不做 UI。
- 不读取 trace artifacts。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:session
```

## 4. Agent D Prompt: agent-loop 集成点审查

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：只做 CompletionGate 接入点分析，必要时可以写一份简短 notes，但不要做大改动。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/src/workflow/workflow-engine.ts
- packages/web-buddy/scripts/agent-loop-test.mjs

必要上下文：
- agent-loop.ts 里 evaluateWorkflow 会更新 lastWorkflowEvaluation。
- agent_done 执行后 result.done 会设置 done/blocked/summary。
- finalizeSession 目前使用 done && !blocked ? completed : blocked。
- no-tool-call 分支当前直接 done=true，Plan7 v1 先保持兼容。

任务：
1. 找出最小接入点：
   - agent_done tool result 后。
   - evaluateWorkflow 返回之后。
   - finalizeSession 之前。
2. 给出实现建议：
   - AgentLoopInput 增加 completionGate? 可测试注入。
   - recordCompletionGateDecision helper 写 transcript/event。
   - gate block 时设置 blocked=true、done=true、summary=decision.reason。
   - gate allow 时保持 completed。
3. 标出风险：
   - 不要重复 finalize。
   - 不要改 no-tool-call 分支。
   - 不要破坏 final submit 现有 blocked 行为。
   - 不要改变 AgentLoopResult schema。
4. 如果写 notes，放到临时评论或最终回复即可，不新增长期文档，除非用户要求。

边界：
- 不重写 runAgentLoop。
- 不改 tool schema。
- 不改 prompt safety。
- 不读取 trace artifacts。
```

## 5. Agent E Prompt: 接入 runAgentLoop

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：把 CompletionGate v1 以最小风险接入 runAgentLoop。

前置：
- Agent A 的 completion-gate.ts 已存在。
- Agent C 的 completion_gate transcript/event 若已存在则使用；如果没有，先补最小 additive 类型。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/scripts/agent-loop-test.mjs

必要上下文：
- evaluateWorkflow(...) 会返回 WorkflowEngineEvaluation，并更新 lastWorkflowEvaluation。
- agent_done 执行后，目前会：
  result.done -> done=true
  blocked = Boolean(result.data?.blocked)
  summary = args.summary || result.observation
  evaluateWorkflow(...)
- Plan7 要在 evaluateWorkflow 之后调用 completionGate。

任务：
1. AgentLoopInput 增加可选 completionGate 注入，方便测试。
2. 默认使用 workflow/completion-gate.ts 的 completionGate。
3. 新增 recordCompletionGateDecision helper：
   - transcript type: completion_gate
   - event type: completion_gate_evaluated
4. 在 agent_done tool result 后、evaluateWorkflow 返回后调用 CompletionGate。
5. 如果 decision.action === 'block'：
   - done = true
   - blocked = true
   - summary = decision.reason
   - 追加 blockers / recentActions 时保持简洁，避免重复噪声。
6. 如果 decision.action === 'allow'：
   - 保持 done=true、blocked=false。
7. 如果 decision.action === 'ignore'：
   - 保持当前兼容行为。
8. final submit approve 后仍必须 blocked，不执行 submit tool。
9. no-tool-call 结束分支先不扩大范围。

边界：
- 不重写 runAgentLoop。
- 不改变 AgentLoopResult / AgentRuntimeResult schema。
- 不改 tool schema。
- 不调用 LLM。
- 不读取 trace artifacts。
- 不做 Resume/Skill/UI。

验收：
- npm --prefix packages/web-buddy run build
- npm --prefix packages/web-buddy run test:agent-loop
- npm --prefix packages/web-buddy run test:workflow
- npm --prefix packages/web-buddy run test:session
```

## 6. Agent F Prompt: 集成测试和回归验证

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：补 Plan7 集成测试和回归验证。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/scripts/agent-loop-test.mjs
- packages/web-buddy/scripts/context-compaction-test.mjs
- packages/web-buddy/scripts/session-runtime-smoke-test.mjs
- packages/web-buddy/src/runtime/local/agent-loop.ts

必要上下文：
- 旧 agent-loop-test 中 agent_done 缺 user_confirm 仍 completed。
- Plan7 后应改成 blocked，并断言 completion_gate entry/event。
- context compaction 已保留 completion.missingCriteria。

任务：
1. 更新 agent-loop-test.mjs：
   - agent_done blocked=false 但缺 user_confirm evidence -> result.blocked === true。
   - transcript 包含 completion_gate。
   - events 包含 completion_gate_evaluated。
   - summary 包含 missing criteria / completion gate reason。
2. 保留并确认：
   - final submit approve 后仍 blocked。
   - final submit tool 不执行。
   - permission deny 仍 blocked。
3. 如有必要，更新 context-compaction-test.mjs：
   - completion missingCriteria 仍能被 compact summary 保留。
4. 运行：
   - npm --prefix packages/web-buddy run build
   - npm --prefix packages/web-buddy run test:completion-gate
   - npm --prefix packages/web-buddy run test:workflow
   - npm --prefix packages/web-buddy run test:agent-loop
   - npm --prefix packages/web-buddy run test:context-compaction
   - npm --prefix packages/web-buddy run test:session

边界：
- 只做必要测试和最小修复。
- 不放宽 final submit。
- 不改 unrelated 文件。
- 不读取 trace artifacts。
```

## 7. Agent G Prompt: 最终审查

```text
你在 /Users/sunqiankai/开源项目/multi-functional-agent 工作。

目标：审查 Plan7 是否可以合并。

必须阅读：
- PLAN/phase2/plan7.md
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/session/session-types.ts
- packages/web-buddy/scripts/completion-gate-test.mjs
- packages/web-buddy/scripts/agent-loop-test.mjs

必要上下文：
- Plan7 的核心目标是 missingCriteria 能阻止 runtime completed。
- 不能放宽 final submit。
- CompletionGate 必须是纯判断，不执行工具、不调用 HumanGate、不读 trace。

任务：
1. 重点审查：
   - missingCriteria 是否真的阻止 completed。
   - agent_done 缺 user_confirm 是否 blocked。
   - final submit approve 后是否仍不执行 submit tool。
   - completion_gate transcript/event 是否 additive。
   - AgentRuntimeResult / AgentLoopResult schema 是否没变。
   - no-tool-call 分支是否保持兼容。
2. 运行：
   - npm --prefix packages/web-buddy run build
   - npm --prefix packages/web-buddy run test:workflow
   - npm --prefix packages/web-buddy run test:agent-loop
   - npm --prefix packages/web-buddy run test:session
3. 运行边界搜索：
   rg -n "output/traces|page-state-latest|form-state-latest" \
     packages/web-buddy/src/workflow \
     packages/web-buddy/src/runtime/local \
     packages/web-buddy/src/session \
     --glob '*.ts'
4. 输出 findings，按严重程度排序。
5. 如果只有小问题，可以做最小修复；如果涉及行为边界，先报告。

验收：
- 给出是否可合并结论。
```
