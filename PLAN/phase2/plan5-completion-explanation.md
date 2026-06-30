# Plan 5 完成说明：Context Compaction v1 到底做了什么

> 这份文档是 `PLAN/phase2/plan5.md` 完成后的通俗沉淀。
> 它说明 Plan 5 实现了什么、为什么要做、如何接入，以及哪些边界仍然保持不变。

## 1. 先用一句话理解

Plan 5 做的是：

> 把无限增长的模型消息历史，压缩成 deterministic compact run summary，让长任务继续运行时仍保留关键事实。

Plan 5 没有把 compaction 做成 LLM 总结器，也没有把 trace artifact 当作运行时状态。它只在安全的 turn 边界估算消息预算，必要时生成结构化摘要，并把摘要写回 session transcript/events。

## 2. Plan 5 之前的问题

`runAgentLoop` 每轮都会追加 assistant tool call、tool observation 和 UPDATED_CONTEXT。短 demo 能工作，但长任务会把旧页面快照、旧工具噪声和重复上下文一起塞给模型。

这会带来几个风险：

- 模型上下文越来越大，预算不可控。
- 关键 blocker、permission、approval 事实散落在历史消息里。
- 旧页面状态可能盖过最新页面/表单状态。
- 未来 resume 需要一个稳定、可审计的 compact entry，而不是只能重放所有历史。

Plan 5 的第一性原理是：

```text
Transcript 是审计事实源。
Context 是当前决策 working set。
```

所以 runtime 不能永远把完整 transcript 当 prompt，必须把旧历史压缩为当前决策需要的稳定摘要。

## 3. Plan 5 后的结构

Plan 5 后，主链路变成：

```text
runAgentLoop
  -> estimateTokenBudget(messages, contextBudget)
  -> session event: token_budget_updated
  -> if compactRecommended:
       ContextCompactor.compact(...)
       session transcript: context_compaction
       session event: context_compacted
       messages = system context + COMPACTED_RUN_CONTEXT + recent message tail
  -> llm.chatWithTools(messages)
```

默认情况下，如果调用方没有传 `contextBudget.maxInputTokens`，runtime 只记录 token budget snapshot，不会自动 compact。这样旧调用保持兼容。

## 4. 实现了哪些能力

### 4.1 TokenBudget

`kernel/token-budget.ts` 现在可以估算：

- 普通 system/user/assistant 消息。
- assistant tool calls。
- tool observation 消息。
- 总 token estimate。
- 是否达到 compact threshold。

估算是 v1 的保守近似，不追求 tokenizer 级精度。验收重点是预算触发、工具 observation 计入、未设置 `maxInputTokens` 时不自动 compact。

### 4.2 CompactRunSummary

`context/run-summary.ts` 定义了 `CompactRunSummary` 和 `ContextCompactionResult`。

summary 保留这些关键事实：

- 用户 goal。
- workflow phase、confidence、reason、blocker、human handoff 状态。
- 最新页面 url/title/pageType/text summary。
- 表单字段数量、缺失必填项、已填字段、submit candidate、upload hint。
- 最近关键 actions。
- blockers。
- permission decisions。
- approval results。
- safety notes。
- next action hints。
- source metadata。

### 4.3 ContextCompactor

`context/compaction.ts` 实现 deterministic `ContextCompactor`。

它只接收 runtime 已有的 `ContextSnapshot`、workflow、recent actions、permission/approval 状态和 messages，不读取 session 文件，不读取 trace 文件，不读取 `page-state-latest.json` 或 `form-state-latest.json`。

输出消息使用：

```text
COMPACTED_RUN_CONTEXT
```

模型可以把它当作当前 working set，但不能凭空推断摘要里没有记录的 approval 或 permission。

### 4.4 runAgentLoop 集成

`runAgentLoop` 新增可选输入：

```ts
contextBudget?: ContextBudgetOptions
contextCompactor?: AgentLoopContextCompactor
```

集成点在 LLM 调用前的 turn 边界。compact 后消息集合变为：

```text
latest system context
COMPACTED_RUN_CONTEXT user message
recent message tail
```

这样不会在工具执行中、HumanGate 等待中或 final submit blocked 分支中突然改写上下文。

### 4.5 Session/Event Additive 兼容

session transcript 增加：

```text
context_compaction
```

session events 增加：

```text
token_budget_updated
context_compacted
```

这些都是 additive entry，不改变旧 transcript entry，也不改变 `AgentRuntimeResult` schema。

## 5. 保持不变的边界

Plan 5 明确没有改变：

- 不重写 `runAgentLoop`。
- 不改变 `AgentRuntimeResult` schema。
- 不改变 tool schema。
- 不改变 prompt safety rules。
- 不让 `ToolExecutionService` 参与 compaction。
- 不让 `PermissionEngine` 参与 compaction。
- 不读取 `output/traces`。
- 不读取 `page-state-latest.json`。
- 不读取 `form-state-latest.json`。
- 不做 LLM summarizer。
- 不做完整跨进程 resume。

## 6. 验收入口

Plan 5 新增并接入这些验证入口：

```bash
npm run test:token-budget
npm run test:context-compaction
npm run test:agent-loop
npm run test:session
npm run test:mvp
```

其中 `test:mvp` 已包含 `test:token-budget` 和 `test:context-compaction`，确保 Plan 5 不会只停留在局部单测。

边界搜索仍应覆盖：

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

## 7. 给 Plan 6 的交接

Plan 5 交付的是 compact working set，不是完整 resume 系统。

Plan 6 可以基于这些事实继续推进：

- 最近一次 `context_compaction` 可以成为未来 resume 的重建锚点。
- permission / approval / blockers 已经进入 compact summary。
- workflow phase 和最新 page/form summary 已经可被压缩保留。
- runtime state 继续不依赖 trace artifacts。

下一步可以开始做 WorkflowEngine v1、Evidence system 和更严格的 final submit success criteria。

## 8. 通俗版总结

Plan 5 可以理解成：

> Agent 跑长任务时，不再把所有聊天历史、工具结果和旧页面状态都塞给模型，而是把它们整理成一张“当前交接单”。

以前的方式像是让模型每一步都重读完整流水账：

```text
打开页面
点击按钮
失败一次
重新点击
旧页面快照
旧表单状态
上传尝试
权限申请
审批结果
新的页面快照
新的表单状态
...
```

Plan 5 之后，模型看到的是更像这样的 compact summary：

```text
目标：完成申请表，但不能自动最终提交。
当前阶段：reviewing / ready_for_final_submit。
当前页面：申请表页面。
表单状态：12 个字段，已填 9 个，缺 3 个必填项。
最近动作：已填写姓名、邮箱、电话，上传简历已被批准。
权限状态：上传已批准，final submit 仍需要人工接管。
阻塞点：可能需要登录 / 验证码 / 最终确认。
下一步建议：补齐缺失字段，进入 review，但不要点击最终提交。
```

完整历史并没有丢，它仍然保存在 session transcript 里。Plan 5 改变的是“下一轮模型要拿什么信息做决策”。

可以用三句话记住它：

```text
Transcript = 完整审计事实源。
Context = 当前决策工作集。
Trace = 调试和报告材料。
```

第一性原理是：

> Agent 的上下文窗口有限。模型需要的是下一步行动所需的最小充分事实，而不是所有过去发生过的细节。

所以 Plan 5 的意义不是单纯省 token，而是让长任务更稳定、更可审计，也为后续 resume、WorkflowEngine、Evidence system 打基础。
