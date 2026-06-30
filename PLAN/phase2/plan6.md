# Phase 2 Plan 6: WorkflowEngine v1 + Evidence System v1

> 目标：Plan 5 已经把长任务的 working set 压缩成可审计的 `CompactRunSummary`。
> Plan 6 要解决下一块底座问题：Agent 不能只靠模型口头说“完成了”，必须有 workflow 阶段判断和 evidence 证据链。
>
> 本阶段仍不重写 `runAgentLoop`，不做 SkillSystem / Memory / Task Cockpit，不放宽 final submit 安全语义，不读取 trace artifacts。

## 1. 为什么第六步做 WorkflowEngine + Evidence

Plan 2 到 Plan 5 已经拆出了几条关键边界：

```text
Plan 2 = Kernel / QueryLoop 外壳
Plan 3 = ToolExecutionService 工具执行生命周期
Plan 4 = PermissionEngine / ApprovalQueue 权限确认链路
Plan 5 = ContextCompaction / RunSummary 长上下文治理
```

现在缺的是：

```text
WorkflowEngine = 判断任务现在在哪一步、是否完成、为什么阻塞
EvidenceSystem = 保存“凭什么这么判断”的证据
```

Plan 6 的第一性原理：

```text
Workflow 定义成功条件。
Evidence 证明当前状态。
Policy / Permission 定义动作边界。
```

也就是说，Workflow 不执行工具、不询问用户、不判断动作风险、不绕过 Permission；它只根据证据判断阶段、完成条件和阻塞原因。

## 2. 本阶段目标

完成后应具备：

1. 新增 `WorkflowDefinition`。
2. 新增内置 `jobApplicationWorkflowDefinition`。
3. 新增 `WorkflowEvidence` 和 `EvidenceStore v1`。
4. 新增 `WorkflowEngine.evaluate(input)`。
5. session transcript/events 支持 workflow evidence / evaluation。
6. `ContextCompactor` 可以保留 evidence / completion summary。
7. `runAgentLoop` 在关键边界调用 WorkflowEngine。
8. final submit 仍必须人工接管，不能因为 Plan 6 自动提交。
9. trace artifacts 仍只能做调试/报告，不能作为 runtime state。
10. `AgentRuntimeResult`、tool schema、prompt safety rule 保持兼容。

## 3. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不做完整 Workflow DSL。
- 不做 SkillSystem。
- 不做 Memory。
- 不做 Task Cockpit UI。
- 不做跨进程完整 resume。
- 不做 persistent EvidenceStore。
- 不自动点击 final submit。
- 不把 optimistic `agent_done` 强制改写成 blocked。
- 不读取 `output/traces`。
- 不读取 `page-state-latest.json`。
- 不读取 `form-state-latest.json`。

Plan 6 v1 的重点是建立 evidence 协议和 workflow evaluation，不是一次性完成所有 runtime enforcement。

## 4. 职责边界

Plan 6 后的最小链路：

```text
runAgentLoop
  -> collect page/form/tool/policy/permission/approval evidence
  -> WorkflowEngine.evaluate(...)
  -> session transcript: workflow_evidence / workflow_evaluation / workflow_snapshot
  -> ContextCompactor receives evidence + workflowEvaluation
  -> continue normal model/tool loop
```

### 4.1 WorkflowDefinition

负责定义 workflow id/name/version、阶段列表、初始阶段、终态阶段、阶段所需 evidence kind 和 completion criteria。

它不读取页面、不执行工具、不更新 session、不判断具体 action 风险。

### 4.2 EvidenceStore

`EvidenceStore v1` 负责保存本次运行内的 evidence，支持 add/list/byKind/snapshot，给 evidence 生成稳定 id，并深拷贝输入和输出，避免外部 mutation。

它不持久化 pending evidence、不从 trace 恢复、不自己判断 workflow 阶段。

### 4.3 WorkflowEngine

`WorkflowEngine` 接收 previous workflow state、page/form、recent actions、policy/permission/approval facts 和 evidence snapshot。

它复用 `transitionWorkflowState()` 的阶段推断，并产出 `WorkflowEngineEvaluation`：

```ts
interface WorkflowEngineEvaluation {
  state: WorkflowState
  changed: boolean
  matchedCriteria: WorkflowCriterionMatch[]
  missingCriteria: WorkflowCriterionMissing[]
  blockers: WorkflowBlocker[]
  evidenceIds: string[]
  reason: string
}
```

它不执行工具、不调用 HumanGate、不调用 PermissionEngine、不写 session、不读 trace artifact。

### 4.4 runAgentLoop

Plan 6 只在关键边界接入 WorkflowEngine，不重写主循环：

- 初始 context 后。
- permission deny 后。
- human gate resolved 后。
- final-submit gate stopped 后。
- agent_done 前后。
- 工具执行后。
- context refresh 后。

## 5. 新增数据模型

新增文件：

```text
packages/web-buddy/src/workflow/workflow-definition.ts
packages/web-buddy/src/workflow/workflow-evidence.ts
packages/web-buddy/src/workflow/workflow-engine.ts
```

内置 workflow 覆盖现有 `WorkflowPhase`：

```text
observing
selecting_job
job_detail
entering_application
login_required
captcha_required
editing_resume
filling_application
reviewing
ready_for_final_submit
done
blocked
```

Evidence kind v1：

```text
page
form
tool_result
policy
permission
approval
user_confirm
screenshot
workflow_state
context_summary
other
```

## 6. Session / Events

session transcript 新增 additive entry：

```text
workflow_evidence
workflow_evaluation
```

session events 新增：

```text
workflow_evidence_recorded
workflow_evaluated
```

这些都是 additive 兼容，不改变旧 transcript entry，也不改变 `AgentRuntimeResult` schema。

## 7. Context Compaction 接入

Plan 6 扩展 Plan 5 的 compact summary：

- `CompactRunSummary.evidence`
- `CompactRunSummary.completion`

compact summary 应保留 evidence 总数、kind 计数、最近关键 evidence、final submit blocker、missing criteria、human handoff reason 和 satisfied criteria。

但 compact 仍不能调用 LLM、读取 session 文件、读取 trace artifact、执行工具或判断 permission。

## 8. 验收标准

新增验证入口：

```bash
npm run test:workflow-evidence
npm run test:workflow-engine
```

更新验证入口：

```bash
npm run test:workflow
npm run test:agent-loop
npm run test:context-compaction
npm run test:session
npm run test:mvp
```

关键验收：

- `jobApplicationWorkflowDefinition` 覆盖现有 workflow phases。
- `EvidenceStore` 支持 add/list/byKind/snapshot，且不会被外部 mutation 污染。
- `WorkflowEngine` 能输出 matched/missing criteria。
- login/captcha/final_submit 能输出 human handoff blocker。
- ready_for_final_submit 不等于 done。
- final submit approve 后仍不会自动执行 submit tool。
- agent_done 的 missing completion evidence 会进入 `workflow_evaluation`。
- compaction 能保留 evidence summary，且不保留 raw evidence data payload。
- runtime workflow/context/session 不读取 trace artifacts。

## 9. 已知边界

Plan 6 v1 已经能把 missing completion evidence 暴露出来，但为了保持兼容，它还没有把所有 missing criteria 自动提升成 runtime blocked。

特别是：

```text
agent_done blocked=false
  -> WorkflowEngine 可以记录缺少 user_confirm evidence
  -> v1 runtime 仍保持原有 completed 语义
```

这不是最终形态。后续阶段可以基于 `workflow_evaluation.missingCriteria` 做更严格的 completion gate。
