# Plan 8 完成说明：UserConfirmEvidence + Resume Completion v1

> 本文档记录 `PLAN/phase2/plan8.md` 已完成的内容、核心链路、安全边界和验证入口。

## 1. 一句话总结

Plan 8 把 Plan 7 的 blocked completion 闭环补完整了：

```text
agent_done 缺 user_confirm 被 blocked
  -> 从 session transcript 恢复事实
  -> 用户显式确认完成
  -> 生成 user_confirm evidence
  -> WorkflowEngine.evaluate(...)
  -> CompletionGate.evaluate(...)
  -> allow: session completed
  -> block: session 继续 blocked
```

这一步的关键不是“给 blocked session 加一个完成按钮”，而是让完成必须继续通过 deterministic workflow/gate 裁决。

## 2. 第一性原理

Plan 8 继续保持三条底线：

```text
LLM 不能自证完成。
Session transcript 是恢复事实源。
最终状态必须由 WorkflowEngine + CompletionGate 裁决。
```

`user_confirm` 是用户确认产生的 evidence，不是模型输出、工具结果或 trace artifact。恢复后的 session 不能绕过 Plan 7 的 CompletionGate，也不能因为用户确认就自动执行 final submit。

## 3. 实际完成内容

新增 session restore 能力：

```text
packages/web-buddy/src/session/session-restore.ts
```

它只读取 `AgentSession` 和 `session.transcriptPath`，恢复：

- latest workflow snapshot。
- 全部 workflow evidence。
- latest workflow evaluation。
- latest completion gate decision。
- latest final result。
- missing criteria / blockers。

新增显式用户确认入口：

```text
packages/web-buddy/src/workflow/user-confirmation.ts
```

`createUserConfirmation()` 固定生成：

- `confirmedBy: 'user'`
- `scope: 'completion'`
- `evidence.kind: 'user_confirm'`
- `evidence.source: 'user_confirmation'`

新增 completion resume 纯裁决服务：

```text
packages/web-buddy/src/workflow/completion-resume.ts
```

它组合 restored evidence 和可选 confirmation evidence，然后重新调用：

```text
WorkflowEngine.evaluate(...)
CompletionGate.evaluate(...)
```

新增 session-level 确认完成入口：

```text
packages/web-buddy/src/session/session-completion.ts
```

它负责串接 restore、user confirmation、resume recheck，并追加 session transcript/events。

## 4. Session 记录

transcript additive 新增：

```text
user_confirmation
```

Plan 8 完成入口会追加：

- `user_confirmation`
- `workflow_evidence`
- `workflow_evaluation`
- `completion_gate`
- `final_result`

events additive 新增：

```text
session_restored
user_confirmed
session_completion_rechecked
```

这些事件会记录 confirmation id、evidence id、workflow phase、completion gate action、recommended status、missing criteria 和 blockers，方便 UI、审计和后续 resume 使用。

## 5. 安全边界

Plan 8 保持以下边界不变：

- 不改变 tool schema。
- 不改变 `AgentRuntimeResult` / `AgentLoopResult` schema。
- 不执行浏览器工具。
- 不调用 LLM。
- 不调用 HumanGate。
- 不自动点击 final submit。
- 不放宽 final submit safety gate。
- 不让 LLM/tool result 伪造 `user_confirm`。
- 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。
- 不把 failed / aborted session 静默改成 completed。

final submit blocker 会在 completion resume 中恢复为 recent action/fact，并继续被 WorkflowEngine 和 CompletionGate 识别为 blocked。

## 6. 验证入口

新增测试入口：

```bash
npm run test:session-restore
npm run test:user-confirmation
npm run test:completion-resume
npm run test:session-completion
```

回归聚合入口已覆盖 Plan 8：

```bash
npm run test:workflow
npm run test:session
npm run test:mvp
```

关键覆盖包括：

- restore 从 session transcript 读取 workflow evidence / evaluation / completion gate / final result。
- 没有 user confirmation 时，completion resume 不制造 `user_confirm`。
- 有 user confirmation 且 criteria 满足时才 completed。
- final submit blocker 不会被 user confirmation 绕过。
- confirm session completion 会追加 transcript/events/status。
- failed / aborted session 不会被确认入口静默改成 completed。

