# Plan 6 完成说明：WorkflowEngine v1 + Evidence System v1 到底做了什么

> 这份文档是 `PLAN/phase2/plan6.md` 完成后的通俗沉淀。
> 它说明 Plan 6 实现了什么、为什么要做、如何接入、审查结论，以及哪些边界仍然保持不变。

## 1. 先用一句话理解

Plan 6 做的是：

> 给 Agent 增加“任务阶段判断”和“证据链”，让它不只是说自己完成了，而是能记录为什么认为当前处于某个 workflow 阶段。

如果说 Plan 5 是把长历史压成“当前交接单”，Plan 6 就是在交接单旁边加上“证据附件”：

```text
当前阶段：reviewing
判断依据：表单证据显示字段大多已填写，页面存在 submit candidate

当前阶段：ready_for_final_submit
判断依据：表单已填 + policy 识别到 final_submit gate

当前阶段：blocked
判断依据：final submit gate / login / captcha / permission deny
```

## 2. Plan 6 之前的问题

Plan 6 之前，项目已经有轻量 `WorkflowState` 和 `transitionWorkflowState()`，能根据页面和表单状态推断阶段。

但问题是：

- 没有正式 workflow definition。
- 没有 completion criteria。
- 没有 evidence store。
- session 里只有 workflow snapshot，没有“为什么这么判断”的证据。
- context compaction 不知道 workflow evidence。
- `agent_done`、final submit、login/captcha 这些关键状态缺少统一 evidence 解释。

换句话说，系统知道“现在大概在哪一步”，但还不能稳定回答：

```text
凭什么？
缺什么？
哪些证据支持？
哪些证据不足？
```

## 3. 第一性原理

Plan 6 的第一性原理是：

```text
Workflow 定义成功条件。
Evidence 证明当前状态。
Policy / Permission 定义动作边界。
```

三者不能混在一起：

- `WorkflowEngine` 判断阶段、完成条件和阻塞原因。
- `EvidenceStore` 保存判断依据。
- `PolicyEngine` 判断风险。
- `PermissionEngine` 判断 allow / ask / deny。
- `HumanGate` 真正询问用户。
- `ToolExecutionService` 只执行已经获准的工具。

这一步的意义是让 Agent 从“执行动作”继续升级成“可解释地推进任务”。

## 4. 实现了哪些能力

### 4.1 WorkflowDefinition

新增：

```text
packages/web-buddy/src/workflow/workflow-definition.ts
```

实现了内置：

```text
jobApplicationWorkflowDefinition
```

它把现有 `WorkflowPhase` 组织成正式 workflow，并定义了关键 completion criteria：

- `ready_for_final_submit` 需要 form + policy evidence。
- `done` 需要 explicit completion evidence。
- login/captcha/final_submit 这类 handoff phase 需要 human handoff 语义。
- `blocked` 是终态，直到用户输入或外部状态改变。

### 4.2 EvidenceStore v1

新增：

```text
packages/web-buddy/src/workflow/workflow-evidence.ts
```

实现了：

- `WorkflowEvidence`
- `EvidenceKind`
- `EvidenceStore`
- `EvidenceStoreSnapshot`

`EvidenceStore v1` 支持：

```text
add
list
byKind
snapshot
```

它保存的 evidence 包括 page、form、tool_result、policy、permission、approval、workflow_state、user_confirm、context_summary 等。

v1 是内存 store，不做持久化数据库。真正的持久审计通过 session transcript 完成。

### 4.3 WorkflowEngine v1

新增：

```text
packages/web-buddy/src/workflow/workflow-engine.ts
```

`WorkflowEngine.evaluate(input)` 会输出：

- `state`
- `changed`
- `matchedCriteria`
- `missingCriteria`
- `blockers`
- `evidenceIds`
- `reason`

它没有推翻旧逻辑，而是复用 `transitionWorkflowState()` 做兼容阶段推断，再增加 criteria / evidence 解释。

### 4.4 Session 审计记录

session transcript 新增：

```text
workflow_evidence
workflow_evaluation
```

session events 新增：

```text
workflow_evidence_recorded
workflow_evaluated
```

这些都是 additive entry，不改变旧 session 格式，也不改变 `AgentRuntimeResult`。

### 4.5 Context Compaction 保留 Evidence

Plan 5 的 `CompactRunSummary` 扩展了：

```text
evidence
completion
```

compact 后可以保留：

- evidence 总数。
- evidence kind 计数。
- 最近关键 evidence。
- final submit blocker。
- missing criteria。
- human handoff reason。
- satisfied criteria。

重要边界：compaction 只保留 evidence summary，不保留 raw evidence data payload。

### 4.6 runAgentLoop 集成

`runAgentLoop` 新增可选：

```ts
workflowEngine?: AgentLoopWorkflowEngine
```

并在关键节点调用 workflow evaluation：

- 初始 context 后。
- permission deny 后。
- HumanGate resolved 后。
- final submit gate stopped 后。
- agent_done 前后。
- 工具执行后。
- context refresh 后。

同时记录 page/form/tool_result/policy/permission/approval/workflow_state evidence。

## 5. 现在的运行链路

Plan 6 后的链路可以理解成：

```text
runAgentLoop
  -> collect evidence
  -> WorkflowEngine.evaluate(...)
  -> write workflow_evidence
  -> write workflow_evaluation
  -> write workflow_snapshot
  -> if context too long:
       ContextCompactor keeps evidence/completion summary
  -> continue normal model/tool loop
```

这让后续 UI、resume、Task Cockpit 可以看到：

```text
现在是什么阶段？
为什么是这个阶段？
支持证据是什么？
缺少什么证据？
是否有 human handoff blocker？
final submit 为什么被挡住？
```

## 6. 保持不变的边界

Plan 6 明确没有改变：

- 不重写 `runAgentLoop`。
- 不改变 tool schema。
- 不改变 prompt safety rule。
- 不改变 `AgentRuntimeResult` schema。
- 不让 WorkflowEngine 执行工具。
- 不让 WorkflowEngine 调用 HumanGate。
- 不让 WorkflowEngine 绕过 Policy / Permission。
- 不自动点击 final submit。
- 不读取 `output/traces`。
- 不读取 `page-state-latest.json`。
- 不读取 `form-state-latest.json`。
- 不做 SkillSystem。
- 不做 Memory。
- 不做 Task Cockpit UI。
- 不做跨进程完整 resume。

## 7. 审查结论

本次审查重点看了：

- workflow definition 是否覆盖现有 phase。
- evidence store 是否避免外部 mutation。
- workflow evaluation 是否能输出 matched/missing criteria。
- final submit 是否仍然被阻断。
- session transcript/events 是否 additive。
- compaction 是否保留 evidence summary。
- runtime workflow/context/session 是否读取 trace artifacts。

结论：

```text
Plan 6 主体实现成立。
关键边界基本守住。
测试覆盖已经包含 workflow、agent-loop、context-compaction、session。
```

已验证通过：

```bash
npm --prefix packages/web-buddy run build
npm --prefix packages/web-buddy run test:workflow
npm --prefix packages/web-buddy run test:agent-loop
npm --prefix packages/web-buddy run test:context-compaction
npm --prefix packages/web-buddy run test:session
```

禁区搜索：

```bash
rg -n "output/traces|page-state-latest|form-state-latest" \
  packages/web-buddy/src/workflow \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  packages/web-buddy/src/session \
  packages/web-buddy/src/permission \
  --glob '*.ts'
```

结果：无命中。

## 8. 剩余风险和后续建议

### 8.1 missing criteria 现在是可见，不是强制拦截

当前实现可以记录：

```text
agent_done 缺少 user_confirm evidence
```

但为了保持兼容，runtime 仍会保留原来的 `agent_done blocked=false -> completed` 语义。

也就是说，Plan 6 v1 做到了：

```text
证据不足可见、可审计、可压缩保留。
```

但还没有做到：

```text
证据不足时一律阻止 runtime completed。
```

后续可以做一个 `CompletionGate` 或 `WorkflowGuard`，基于 `workflow_evaluation.missingCriteria` 决定是否允许 completed。

### 8.2 工具执行后的第一次 evaluation 可能使用旧 page/form

工具执行后，`runAgentLoop` 会先记录 tool_result evidence 并调用 WorkflowEngine，之后才在 context refresh 阶段拿到更新后的 page/form。

这意味着：

- 第一次 evaluation 可能更依赖 tool_result。
- 后续 context refresh 会再补 page/form evidence。

当前测试通过，但后续如果要减少重复 evidence 或提高时序精度，可以把 page/form refresh 前移到 page-changing tool 之后。

### 8.3 EvidenceStore v1 仍是内存态

Plan 6 的 evidence 持久审计靠 transcript，不是靠 EvidenceStore 自身持久化。

后续 resume 如果要重建 evidence store，可以从 transcript 中回放：

```text
workflow_evidence entries -> EvidenceStore snapshot
workflow_evaluation entries -> latest evaluation
```

## 9. 给 Plan 7 的交接

Plan 6 之后，下一步可以做：

```text
Plan 7 = CompletionGate / WorkflowGuard v1
```

目标是把 Plan 6 已经产出的 `missingCriteria` 真正接入 runtime 完成判定：

- `agent_done blocked=false` 前检查 workflow completion evidence。
- final submit 继续保持人工接管。
- done 必须有 explicit completion evidence。
- blocked 必须有 blocker/evidence。
- session final result 写入 completion gate reason。

这一步可以把 Plan 6 的“可解释”推进到“可执行约束”。
