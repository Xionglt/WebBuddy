# Phase 2 Plan 4: PermissionEngine v1 + ApprovalQueue

> 目标：Phase 2C 已经把单个工具调用的执行生命周期抽成 `ToolExecutionService v1`。
> Plan 4 要把“风险判断、执行许可、人工询问”拆成清晰三层：`PolicyEngine -> PermissionEngine -> HumanGate`，并建立第一版 `ApprovalQueue`。
> 本阶段仍不重写 `runAgentLoop`，不引入 WorkflowEngine，不改变 prompt、tool schema 或 `ToolExecutionService` 职责。

## 1. 为什么第四步做 PermissionEngine

当前 `runAgentLoop` 里已经有一条可用的安全链路：

```text
registry.resolveRisk()
  -> decideToolPolicy()
  -> HumanGate.confirm()
  -> ToolExecutionService.execute()
```

这条链路能挡住高风险点击、final submit、login/captcha 等动作，但它把几个不同职责揉在一起：

- `PolicyEngine` 同时表达风险判断和 gate 建议。
- `runAgentLoop` 直接决定什么时候调用 `HumanGate`。
- 待确认事项没有独立队列。
- session 里有 `policy_decision` 和 `human_gate_*`，但没有通用 `permission_decision`。
- Web UI 以后要展示“待我确认”的列表时，只能从 runtime 瞬时状态里猜。

第一性原理：

> Policy 是风险判断，Permission 是执行许可，HumanGate 是实际询问用户。三者必须分层，否则权限、恢复、UI 和审计会继续挤在主循环里。

Plan 4 不是让 Agent 做更多工具，也不是改变安全策略，而是把现有 gate 语义提升成通用权限协议。

## 2. 当前状态

已有能力：

- `PolicyEngine.evaluate()` 返回 `PolicyEngineDecision`。
- `PolicyEngineDecision.action` 当前为 `allow | gate | block | auto_confirm`。
- `GateKind` 已覆盖：
  - `login`
  - `captcha`
  - `upload_resume`
  - `save_resume`
  - `final_submit`
  - `high_risk_action`
- `HumanGate.confirm()` 返回 `approve | decline | takeover`。
- `runAgentLoop` 已记录：
  - `policy_decision` transcript。
  - `policy_evaluated` event。
  - `human_gate_requested` event。
  - `human_gate_resolved` event。
- `ToolExecutionService` 只负责工具执行生命周期。
- `session/transcript.jsonl` 和 `events.jsonl` 已经是 runtime state 的事实源。

当前不足：

- 没有 `PermissionRequest` / `PermissionDecision` 通用模型。
- 没有 `ApprovalRequest` 队列模型。
- 没有 `permission_decision` transcript entry。
- 没有 `permission_evaluated` / `approval_requested` / `approval_resolved` event。
- HumanGate 调用点仍直接散在 `runAgentLoop` 的 policy 分支里。
- final submit、upload、高风险 click、login/captcha 还不是同一个 permission 入口。

## 3. 本阶段目标

完成后应该具备：

1. 新增 `permission/` 模块，定义 PermissionEngine v1。
2. 新增 `PermissionRequest`，表达一次待判定的执行许可请求。
3. 新增 `PermissionDecision`，只表达 `allow | ask | deny`。
4. 新增 `ApprovalRequest`，表达需要交给用户确认的排队项。
5. 新增 `ApprovalQueue v1`，保存运行期 pending/resolved approval。
6. `runAgentLoop` 在 policy decision 之后、HumanGate 和工具执行之前，调用 PermissionEngine。
7. final submit、upload、高风险 click、login/captcha 进入同一 permission 入口。
8. session transcript/events 记录 permission decision 和 approval resolution。
9. 保持现有 prompt、tool schema、ToolExecutionService、PolicyEngine 外部兼容。
10. 保持 `runAgentLoop` 直接调用兼容。

## 4. 非目标

本阶段明确不做：

- 不重写 `runAgentLoop`。
- 不引入 WorkflowEngine。
- 不改变 prompt。
- 不改变 tool schema。
- 不改变 `ToolExecutionService` 的职责。
- 不让 `PermissionEngine` 执行工具。
- 不让 `PermissionEngine` 调用 `HumanGate`。
- 不让 `ApprovalQueue` 决定 allow/deny。
- 不做持久化 approval queue。
- 不做跨进程待确认恢复。
- 不做完整 PermissionStore。
- 不做“总是允许”或“本 session 永久允许”的规则写入。
- 不做权限配置文件、组织策略、角色系统。
- 不做新的 UI 页面。
- 不改变 final submit 必须人工接管的现有语义。
- 不改变 `AgentRuntimeResult` / `AgentLoopResult` schema。
- 不删除既有 `policy_decision`、`human_gate_requested`、`human_gate_resolved` 记录。

## 5. 职责边界

## 5.1 总链路

Plan 4 后的最小链路：

```text
runAgentLoop
  -> registry.resolveRisk()
  -> PolicyEngine.evaluate()
  -> PermissionEngine.evaluate()
  -> ApprovalQueue.enqueue() if ask
  -> HumanGate.confirm() if ask
  -> ApprovalQueue.resolve()
  -> ToolExecutionService.execute() only if allowed and approved
```

也就是说：

```text
PolicyEngine      = 风险和策略建议
PermissionEngine  = 执行许可判断
ApprovalQueue     = 待确认事项状态
HumanGate         = 实际询问用户
ToolExecution     = 已获许可后的工具执行
```

## 5.2 PolicyEngine

`PolicyEngine` 继续负责：

- 读取 tool name、args、risk、currentUrl、refLabel、freshness、workflow phase。
- 判断风险等级：low / medium / high / critical。
- 判断 submit-like click 是否是 final submit。
- 判断 workflow phase 是否需要 login/captcha gate。
- 产出 `policyCode`、`ruleId`、`auditTags`、`reason`。
- 在兼容期继续返回 `action: allow | gate | block | auto_confirm`。

`PolicyEngine` 不负责：

- 不读取用户历史授权。
- 不创建 approval request。
- 不调用 HumanGate。
- 不执行工具。
- 不修改 tool args。
- 不决定 queue 状态。
- 不写 session transcript。

Plan 4 不要求重写 `PolicyEngineDecision` shape。实现时只把它当作 policy recommendation 输入给 PermissionEngine。

## 5.3 PermissionEngine

`PermissionEngine` 负责：

- 接收 `PermissionRequest`。
- 将 policy recommendation、tool metadata、workflow phase 和安全模式规整成统一许可结论。
- 返回 `PermissionDecision.action`：
  - `allow`: 可以继续。
  - `ask`: 必须进入 ApprovalQueue 并交给 HumanGate。
  - `deny`: 不允许执行。
- 给出 `reason`、`ruleId`、`source`、`riskLevel`、`gateKind`。
- 标明是否需要 fresh context、是否可记住。

`PermissionEngine` 不负责：

- 不执行工具。
- 不调用 HumanGate。
- 不阻塞等待用户。
- 不写 ApprovalQueue。
- 不写 SessionRecorder。
- 不更新 WorkflowState。
- 不改 prompt/messages。
- 不改 tool schema。
- 不做 retry。

PermissionEngine v1 是同步/纯判断服务。它可以是 class，也可以是带默认实例的 pure service，但输入输出必须稳定。

## 5.4 ApprovalQueue

`ApprovalQueue` 负责：

- 保存 `ApprovalRequest` 的 pending/resolved 状态。
- 支持 enqueue / resolve / get / listPending / snapshot。
- 允许订阅状态变化，供未来 Web UI 或 Task Cockpit 使用。
- 为 `runAgentLoop` 提供一个统一位置记录“现在等用户确认什么”。

`ApprovalQueue` 不负责：

- 不判断风险。
- 不决定 allow/deny。
- 不调用 HumanGate。
- 不执行工具。
- 不写持久文件。
- 不恢复跨进程 pending approval。

## 5.5 HumanGate

`HumanGate` 继续负责：

- 实际询问用户。
- CLI 模式下从 stdin 获取选择。
- Auto/Scripted 模式下返回测试或自动决策。
- 返回 `GateDecision: approve | decline | takeover`。

`HumanGate` 不负责：

- 不做 policy 判断。
- 不维护 approval queue。
- 不写 session transcript。
- 不决定 tool 是否执行。
- 不解释 workflow 是否完成。

Plan 4 不改变 `HumanGate.confirm(kind, message, context)` 接口。`ApprovalRequest` 会被转换成现有 `GateKind`、message 和 `GateContext` 调用它。

## 5.6 ToolExecutionService

`ToolExecutionService` 保持 Plan 3 边界：

- 只在 permission allow 且必要 approval 通过后执行。
- 不知道 PermissionEngine。
- 不知道 ApprovalQueue。
- 不知道 HumanGate。
- 不产生 permission decision。

`ToolUseContext` 不新增 `requestPermission()`。这是本阶段的硬边界。

## 6. ApprovalQueue v1 形态

结论：

> ApprovalQueue v1 是内存队列，不是持久队列。

原因：

- 本阶段目标是建立 permission 边界和运行期队列，不做完整 resume。
- `runAgentLoop` 当前仍是同步等待 `HumanGate.confirm()`，pending approval 的生命周期通常在同一进程内完成。
- 持久化 pending queue 会牵涉 resume cursor、Web UI command、跨进程唤醒和冲突处理，超出 Plan 4。
- session transcript/events 已经负责 append-only 审计，可以持久记录 request 和 decision。

v1 保证：

- 内存中可以列出当前 pending approvals。
- request/resolution 会写入 session transcript/events。
- 进程不重启时，Web server 或调用方可以读取队列状态。
- 队列 resolve 后保留 resolved snapshot，方便本次 run 展示。

v1 不保证：

- 进程重启后 pending approval 仍在队列里。
- 用户可以在另一个进程 resolve approval。
- 可以从 transcript 自动重建 pending queue。
- 可以保存 “always allow” 或 “deny forever”。

后续持久化可以基于 session transcript 重建：

```text
approval_request pending
  + approval_decision missing
  = 可恢复的 pending approval
```

但这不是 Plan 4 的实现范围。

## 7. 数据模型草案

## 7.1 PermissionAction

```ts
export type PermissionAction = 'allow' | 'ask' | 'deny'
```

注意：

- `PolicyAction` 仍是 `allow | gate | block | auto_confirm`。
- `PermissionAction` 只允许 `allow | ask | deny`。
- `gate` 是 policy recommendation，不是最终 permission action。

## 7.2 PermissionSubject

放在 `permission/permission-types.ts`。

```ts
import type { GateKind } from '../sdk/human.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { PolicyEngineDecision, PolicyRiskLevel } from '../policy/agent-policy.js'
import type { WorkflowPhase } from '../workflow/workflow-state.js'

export type PermissionSubject =
  | {
      kind: 'tool_call'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      argBrief?: string
      toolCategory?: string
    }
  | {
      kind: 'workflow_handoff'
      handoffKind: Extract<GateKind, 'login' | 'captcha'>
      reason: string
    }
```

说明：

- tool permission 覆盖 final submit、upload、高风险 click 等工具动作。
- workflow handoff 覆盖当前 loop 在没有具体 tool call 时发现 login/captcha blocker 的情况。
- v1 不增加新的 tool schema。

## 7.3 PermissionRequest

```ts
export interface PermissionRequest {
  schemaVersion: 'permission-request/v1'
  requestId: string
  runId: string
  sessionId: string
  turnId?: string
  step: number
  requestedAt: string
  subject: PermissionSubject
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  currentUrl?: string
  workflowPhase?: WorkflowPhase
  gateKind?: GateKind
  policy: {
    schemaVersion: PolicyEngineDecision['schemaVersion']
    action: PolicyEngineDecision['action']
    policyCode: string
    ruleId: string
    reason: string
    auditTags: string[]
    requiresFreshContext?: boolean
  }
  context?: {
    refLabel?: string
    freshness?: unknown
  }
}
```

request id 建议：

```text
perm_<turnId>_<toolCallId>
perm_<turnId>_workflow_<login|captcha>
```

要求：

- `PermissionRequest` 可以包含 tool args，因为 `tool_call` transcript 已经记录 args。
- 如果未来需要脱敏，应在 `PermissionRequest` 构造 helper 中统一处理，不在 PermissionEngine 中处理。
- request 不包含 prompt/messages。
- request 不包含 `SessionRecorder`、`HumanGate` 或 `ToolExecutionService`。

## 7.4 PermissionDecision

```ts
export type PermissionDecisionSource =
  | 'policy'
  | 'default_rule'
  | 'runtime_rule'
  | 'session_rule'
  | 'config_rule'
  | 'user'

export type PermissionRememberScope = 'once' | 'session' | 'always'

export interface PermissionDecision {
  schemaVersion: 'permission-decision/v1'
  requestId: string
  action: PermissionAction
  source: PermissionDecisionSource
  ruleId: string
  riskLevel: PolicyRiskLevel
  reason: string
  decidedAt: string
  gateKind?: GateKind
  requiresFreshContext?: boolean
  remember: {
    supportedScopes: PermissionRememberScope[]
    defaultScope: PermissionRememberScope
  }
  auditTags: string[]
}
```

v1 语义：

- `source` 主要是 `policy` 或 `default_rule`。
- `session_rule`、`config_rule`、`user` 先保留类型空间，不实现持久规则。
- `remember.supportedScopes` v1 默认只包含 `once`。
- final submit、upload、login、captcha 默认不可记住为 always allow。
- high-risk click 可以在类型上标记未来可支持 `session`，但 v1 不实现。

## 7.5 ApprovalRequest

```ts
import type { GateContext, GateDecision, GateKind } from '../sdk/human.js'

export type ApprovalRequestStatus = 'pending' | 'resolved' | 'cancelled'

export interface ApprovalRequest {
  schemaVersion: 'approval-request/v1'
  approvalId: string
  permissionRequestId: string
  runId: string
  sessionId: string
  turnId?: string
  toolCallId?: string
  status: ApprovalRequestStatus
  kind: GateKind
  title: string
  message: string
  context: GateContext & {
    toolName?: string
    argBrief?: string
    policyCode?: string
    ruleId?: string
    workflowPhase?: string
    permissionReason: string
  }
  allowedDecisions: GateDecision[]
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  resolution?: ApprovalResolution
}

export interface ApprovalResolution {
  schemaVersion: 'approval-resolution/v1'
  approvalId: string
  permissionRequestId: string
  decision: GateDecision
  source: 'human_gate' | 'auto_gate' | 'scripted_gate'
  reason?: string
  decidedAt: string
}
```

说明：

- `ApprovalRequest.kind` 直接使用现有 `GateKind`，避免改 HumanGate。
- `allowedDecisions` v1 固定为 `approve | decline | takeover`。
- `ApprovalResolution.decision` 是用户/测试 gate 的实际选择，不等于 `PermissionDecision.action`。
- `PermissionDecision.action='ask'` 表示需要询问。
- `ApprovalResolution.decision='approve'` 表示询问后允许继续某些动作。

## 8. Permission rules v1

## 8.1 统一入口

建议所有 tool call 都经过 PermissionEngine：

```text
tool_call -> policy_decision -> permission_decision
```

但只有部分 action 会进入 ApprovalQueue：

- final submit。
- resume upload。
- high-risk click。
- login/captcha。
- explicit policy block 只记录 permission deny，不进 approval queue。

这样 session 中每个工具都有一致的 permission audit，同时不会让低风险 observation/fill/select 产生无意义队列项。

## 8.2 规则表

| Signal | Example | PermissionDecision | Runtime effect |
|---|---|---|---|
| `policy.action='block'` | stale high-risk action | `deny` | 不执行工具，按当前 policy block 路径进入 blocked |
| `policy.action='allow'` and low/medium risk | snapshot, fill, select | `allow` | 继续执行 |
| `policy.action='auto_confirm'` | raw mode high-risk click | `allow` | 保持现有 raw auto-confirm 兼容，可设置 `confirmed=true` |
| `policy.action='gate'` + `gateKind='final_submit'` | 点击“提交申请” | `ask` | 入队并调用 HumanGate，随后仍按 final submit manual takeover 阻塞，不执行 submit |
| `toolName='browser_upload_file'` or `gateKind='upload_resume'` | 上传简历 PDF | `ask` | approve 后设置 `confirmed=true` 再执行，decline/takeover 不执行 |
| `browser_click` / `browser_click_text` with L3/L4 | 高风险按钮 | `ask` | approve 后设置 `confirmed=true` 再执行 |
| `workflowPhase='login_required'` or `gateKind='login'` | 登录墙 | `ask` | 入队并调用 HumanGate，结果写 session，通常 blocked/handoff |
| `workflowPhase='captcha_required'` or `gateKind='captcha'` | 人机验证 | `ask` | 入队并调用 HumanGate，结果写 session，通常 blocked/handoff |

## 8.3 final submit 特殊语义

必须保持当前行为：

```text
final submit -> ask human -> do not execute submit tool -> blocked/manual takeover
```

即使 HumanGate 返回 `approve`，Plan 4 v1 也不让 Agent 自动点击最终提交按钮。

原因：

- 当前安全契约已经把 final submit 定义成人工接管。
- 改成 approve 后自动 submit 会改变产品语义。
- WorkflowEngine/Evidence 尚未完成，不能让 v1 提前扩大权限。

## 8.4 upload 语义

`browser_upload_file` 当前 catalog 已是 L4，并且参数中已有 `confirmed`。

Plan 4 v1：

- 上传必须走 permission。
- permission decision 必须为 `ask`，除非未来明确配置为测试环境 allow。
- HumanGate approve 后，`runAgentLoop` 设置 `call.arguments.confirmed = true`。
- decline/takeover 不执行上传。
- 不改变 `browser_upload_file` schema。
- 不新增本地 upload handler。

## 8.5 high-risk click 语义

适用：

- `browser_click` risk L3/L4。
- `browser_click_text` risk L3/L4。
- `PolicyEngine` 根据 ref label/text 判定为 high-risk 或 final submit。

Plan 4 v1：

- final submit 走 final submit 特殊语义。
- 普通 high-risk action 走 `ask`。
- approve 后设置 `confirmed=true`。
- decline 后保持当前“给模型一个 blocked observation，可以继续尝试别的路径”的语义。
- takeover 后保持当前 `shouldStopAfterGateDecision()` 语义，进入 blocked。

## 8.6 login/captcha 语义

有两种入口：

1. tool-call policy path
   - `PolicyEngineDecision.gateKind` 为 `login` 或 `captcha`。
   - 构造 tool-call `PermissionRequest`。
   - `PermissionEngine` 返回 `ask`。

2. workflow handoff path
   - `workflowHandoffSummary()` 发现 `login_required` 或 `captcha_required`。
   - 构造 `subject.kind='workflow_handoff'` 的 `PermissionRequest`。
   - 记录 permission/approval request。
   - v1 不要求真的 resume after login，只保持 blocked/handoff 清晰可审计。

本阶段不把 login/captcha 做成完整可恢复流程。

## 9. runAgentLoop 最小改造

## 9.1 AgentLoopInput additive fields

只新增可选字段：

```ts
export interface AgentLoopInput {
  permissionEngine?: PermissionEngine
  approvalQueue?: ApprovalQueue
}
```

要求：

- 不破坏直接调用 `runAgentLoop(input)` 的旧代码。
- 默认创建 `new PermissionEngine()` 和 `new ApprovalQueue()`。
- 测试可以注入 fake engine/queue。
- 不要求 QueryLoop 直接调度 permissions。

## 9.2 集成位置

当前：

```text
tool_call
  -> policy_decision
  -> if block / auto_confirm / gate
  -> tool_started
  -> ToolExecutionService.execute()
```

目标：

```text
tool_call
  -> policy_decision
  -> permission_request
  -> permission_decision
  -> if deny: existing blocked path
  -> if ask: approval_queue + HumanGate
  -> if allowed/approved: ToolExecutionService.execute()
```

伪代码：

```ts
const permissionRequest = createToolPermissionRequest({
  call,
  policyDecision,
  risk,
  currentUrl,
  workflowState,
  turnId,
  step,
})

const permissionDecision = permissionEngine.evaluate(permissionRequest)
recordPermissionDecision(permissionRequest, permissionDecision)

if (permissionDecision.action === 'deny') {
  // same shape as current policy block path
  blockToolCallWithPermission(...)
  break
}

if (permissionDecision.action === 'ask') {
  const approval = approvalQueue.enqueue(createApprovalRequest(permissionRequest, permissionDecision))
  recordApprovalRequested(approval)
  const gateDecision = await gate.confirm(approval.kind, approval.message, approval.context)
  const resolution = approvalQueue.resolve(approval.approvalId, gateDecision)
  recordApprovalResolved(resolution)
  // reuse current gate handling semantics
}

// allow or approved non-final action reaches ToolExecutionService
```

## 9.3 保留在 runAgentLoop 的逻辑

这些逻辑仍保留：

- LLM 调用。
- messages 构造。
- tool call assistant message append。
- policy decision 构造。
- HumanGate 调用。
- workflow transition。
- session transcript/event 写入。
- final submit 特殊阻塞。
- decline/takeover 后的 blocked observation。
- `confirmed=true` 参数注入。
- `ToolExecutionService.execute()` 调用。
- tool result 写回 messages。

Plan 4 只是把 “policy 后是否 allow/ask/deny” 抽出来。

## 9.4 `confirmed=true` 规则

只有在 permission allow/approval approve 后，`runAgentLoop` 才能设置：

```ts
call.arguments.confirmed = true
```

适用：

- `browser_click`
- `browser_click_text`
- `browser_upload_file`

不适用：

- final submit。final submit 不执行工具。
- low-risk tools。无需 confirmed。
- `agent_done`。

## 9.5 policy block 到 permission deny 的兼容

`policyDecision.action === 'block'` 映射为：

```text
PermissionDecision.action = deny
source = policy
ruleId = policyDecision.ruleId
reason = policyDecision.reason
```

运行效果应和当前 policy block 一致：

- 给模型 `BLOCKED ...` tool message。
- recent action 记录为 blocked。
- blockers 增加原因。
- workflow transition 接收 policy/permission metadata。
- session final status 可进入 blocked。

## 10. session transcript / events

## 10.1 Transcript additive entries

在 `session/session-types.ts` additive 增加：

```ts
export interface PermissionDecisionEntry extends TranscriptEntryBase {
  type: 'permission_decision'
  permissionRequestId: string
  toolCallId?: string
  toolName?: string
  request: unknown
  decision: unknown
}

export interface ApprovalRequestEntry extends TranscriptEntryBase {
  type: 'approval_request'
  approvalId: string
  permissionRequestId: string
  toolCallId?: string
  status: 'pending'
  request: unknown
}

export interface ApprovalDecisionEntry extends TranscriptEntryBase {
  type: 'approval_decision'
  approvalId: string
  permissionRequestId: string
  toolCallId?: string
  decision: unknown
}
```

要求：

- 不删除 `policy_decision`。
- 不删除 `tool_call`。
- 不删除 `human_gate_*` events。
- `permission_decision` 记录 PermissionEngine 输出。
- `approval_request` 记录进入队列。
- `approval_decision` 记录 HumanGate 返回值和 queue resolution。

## 10.2 KernelEvent additive types

在 `kernel/kernel-events.ts` additive 增加：

```ts
  | 'permission_evaluated'
  | 'approval_requested'
  | 'approval_resolved'
```

事件语义：

| Event | When | data |
|---|---|---|
| `permission_evaluated` | PermissionEngine 返回后 | `{ request, decision }` |
| `approval_requested` | ApprovalQueue enqueue 后 | `{ approval }` |
| `approval_resolved` | ApprovalQueue resolve 后 | `{ approval, resolution }` |

兼容要求：

- 继续发 `human_gate_requested` 和 `human_gate_resolved`。
- 对现有 Web UI / tests 来说，旧事件仍存在。
- 新 UI 可以优先读 `approval_*`。

## 10.3 Example transcript

高风险 click approve：

```jsonl
{"type":"tool_call","toolCallId":"call_1","name":"browser_click","args":{"ref":"e7"}}
{"type":"policy_decision","toolCallId":"call_1","toolName":"browser_click","decision":{"action":"gate","gateKind":"high_risk_action"}}
{"type":"permission_decision","permissionRequestId":"perm_turn_001_call_1","toolCallId":"call_1","toolName":"browser_click","decision":{"action":"ask","gateKind":"high_risk_action"}}
{"type":"approval_request","approvalId":"appr_turn_001_call_1","permissionRequestId":"perm_turn_001_call_1","toolCallId":"call_1","status":"pending"}
{"type":"approval_decision","approvalId":"appr_turn_001_call_1","permissionRequestId":"perm_turn_001_call_1","toolCallId":"call_1","decision":{"decision":"approve"}}
{"type":"tool_result","toolCallId":"call_1","name":"browser_click","ok":true}
```

final submit takeover：

```jsonl
{"type":"policy_decision","toolCallId":"call_9","toolName":"browser_click","decision":{"action":"gate","gateKind":"final_submit"}}
{"type":"permission_decision","permissionRequestId":"perm_turn_004_call_9","toolCallId":"call_9","toolName":"browser_click","decision":{"action":"ask","gateKind":"final_submit"}}
{"type":"approval_request","approvalId":"appr_turn_004_call_9","permissionRequestId":"perm_turn_004_call_9","toolCallId":"call_9","status":"pending"}
{"type":"approval_decision","approvalId":"appr_turn_004_call_9","permissionRequestId":"perm_turn_004_call_9","toolCallId":"call_9","decision":{"decision":"takeover"}}
{"type":"workflow_snapshot","workflowState":{"phase":"ready_for_final_submit"}}
{"type":"final_result","status":"blocked","reason":"Final submit requires manual takeover (gate: takeover)."}
```

## 10.4 Trace 边界

trace 可以新增审计事件：

- `permission_decision`
- `approval_requested`
- `approval_resolved`

但 runtime 不允许从 trace 读取 permission state。

事实源仍是：

```text
Session transcript/events + in-memory ApprovalQueue snapshot
```

## 11. 目标文件结构

新增文件：

```text
packages/web-buddy/src/permission/
  permission-types.ts
  permission-rules.ts
  permission-engine.ts
  approval-queue.ts
  index.ts

packages/web-buddy/scripts/
  permission-engine-test.mjs
  approval-queue-test.mjs
```

修改文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/package.json
```

可选修改：

```text
packages/web-buddy/src/policy/agent-policy.ts
packages/web-buddy/src/policy/policy-engine.ts
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/agent-kernel-test.mjs
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
packages/web-buddy/scripts/safety-report-test.mjs
```

不应修改：

```text
packages/web-buddy/src/agent/prompt-assembler.ts
packages/web-buddy/src/tools/tool-execution-service.ts
packages/web-buddy/src/tools/tool-contract.ts
packages/web-buddy/src/tools/catalog.ts
packages/web-buddy/src/tools/local-adapter.ts
packages/web-buddy/src/sdk/human.ts
```

说明：

- 不新增持久 `permission-store.ts`。
- 如果实现时确实需要 store interface，只允许定义内存接口或类型，不允许引入磁盘持久化。
- `sdk/human.ts` 的接口保持原样。

## 12. 接口草案

## 12.1 PermissionEngine

```ts
export interface PermissionEngineOptions {
  now?: () => Date
}

export class PermissionEngine {
  constructor(options?: PermissionEngineOptions)

  evaluate(request: PermissionRequest): PermissionDecision
}
```

规则实现建议放在 `permission-rules.ts`：

```ts
export interface PermissionRule {
  id: string
  evaluate(request: PermissionRequest): PermissionDecision | undefined
}

export function defaultPermissionRules(): PermissionRule[]
```

规则顺序：

1. policy block -> deny。
2. final submit -> ask。
3. upload -> ask。
4. login/captcha -> ask。
5. high-risk L3/L4 -> ask。
6. raw auto_confirm -> allow。
7. default allow。

## 12.2 ApprovalQueue

```ts
export type ApprovalQueueEvent =
  | { type: 'approval_enqueued'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approval: ApprovalRequest; resolution: ApprovalResolution }
  | { type: 'approval_cancelled'; approval: ApprovalRequest; reason?: string }

export interface ApprovalQueueSnapshot {
  version: 1
  pending: ApprovalRequest[]
  resolved: ApprovalRequest[]
}

export class ApprovalQueue {
  enqueue(request: ApprovalRequest): ApprovalRequest
  resolve(approvalId: string, decision: GateDecision, patch?: { source?: ApprovalResolution['source']; reason?: string }): ApprovalRequest
  cancel(approvalId: string, reason?: string): ApprovalRequest
  get(approvalId: string): ApprovalRequest | undefined
  listPending(): ApprovalRequest[]
  snapshot(): ApprovalQueueSnapshot
  subscribe(listener: (event: ApprovalQueueEvent) => void): () => void
}
```

约束：

- enqueue 同一个 `approvalId` 应该幂等或明确抛错，测试要覆盖。
- resolve unknown id 应该抛出明确错误。
- resolved request 不允许再次 resolve。
- callback error 不应破坏 queue 状态。

## 12.3 Helper functions

建议放在 `permission/permission-rules.ts` 或 `permission/permission-types.ts`：

```ts
export function createToolPermissionRequest(input: {
  call: ToolCall
  policyDecision: PolicyEngineDecision
  risk?: RiskLevel
  currentUrl?: string
  workflowState?: WorkflowState
  runId: string
  sessionId: string
  turnId: string
  step: number
  argBrief?: string
  toolCategory?: string
  refLabel?: string
  freshness?: unknown
  now?: () => Date
}): PermissionRequest

export function createWorkflowHandoffPermissionRequest(input: {
  handoffKind: 'login' | 'captcha'
  reason: string
  runId: string
  sessionId: string
  turnId?: string
  step: number
  workflowState: WorkflowState
  currentUrl?: string
  now?: () => Date
}): PermissionRequest

export function createApprovalRequest(
  request: PermissionRequest,
  decision: PermissionDecision,
): ApprovalRequest
```

这些 helper 只负责 shape 和 message，不做副作用。

## 13. 测试计划

新增：

```text
npm run test:permission
npm run test:approval-queue
```

或合并为：

```text
npm run test:permission
```

其中 `test:permission` 至少运行：

```text
node ./scripts/permission-engine-test.mjs
node ./scripts/approval-queue-test.mjs
```

## 13.1 PermissionEngine unit tests

覆盖：

1. low-risk allow
   - `policy.action='allow'`
   - risk L0/L1/L2
   - decision `allow`

2. policy block deny
   - `policy.action='block'`
   - decision `deny`
   - source `policy`
   - preserves `policyCode` / `ruleId`

3. final submit ask
   - `gateKind='final_submit'`
   - decision `ask`
   - remember scopes only `once`

4. upload ask
   - `toolName='browser_upload_file'`
   - risk L4
   - decision `ask`
   - gateKind `upload_resume`

5. high-risk click ask
   - `browser_click` risk L3
   - decision `ask`
   - gateKind `high_risk_action`

6. login/captcha ask
   - workflow phase login_required/captcha_required
   - decision `ask`

7. raw auto-confirm allow
   - `policy.action='auto_confirm'`
   - decision `allow`
   - auditTags include compatibility marker

## 13.2 ApprovalQueue unit tests

覆盖：

1. enqueue pending approval。
2. listPending returns pending only。
3. resolve moves request to resolved and records resolution。
4. resolving unknown id fails clearly。
5. resolving twice fails clearly。
6. cancel pending approval。
7. snapshot contains pending/resolved。
8. subscribe receives enqueue/resolve/cancel events。
9. listener throw does not corrupt queue。

## 13.3 runAgentLoop integration tests

更新 `agent-loop-test.mjs` 或新增 permission loop test，覆盖：

1. high-risk click approve
   - PermissionEngine returns ask。
   - ApprovalQueue records pending/resolved。
   - HumanGate approve。
   - `confirmed=true` reaches tool args。
   - tool executes once。

2. high-risk click decline
   - tool does not execute。
   - model receives blocked observation。
   - session records `permission_decision` and `approval_decision`。

3. high-risk click takeover
   - tool does not execute。
   - loop ends blocked, preserving current `shouldStopAfterGateDecision()` behavior。

4. final submit approve/takeover
   - HumanGate called。
   - approval resolved。
   - submit tool does not execute。
   - final result blocked/manual takeover。

5. upload approve
   - `browser_upload_file` asks permission。
   - approve sets `confirmed=true`。
   - tool execution path starts only after approval。

6. policy deny
   - no ApprovalQueue entry。
   - no HumanGate call。
   - no ToolExecutionService call。
   - blocked path compatible with current policy block。

7. workflow login/captcha handoff
   - permission/approval records are written when workflow enters handoff。
   - no WorkflowEngine introduced。

## 13.4 Session/event compatibility tests

Must verify:

- Existing transcript types still appear.
- `policy_decision` still appears before `permission_decision`.
- `human_gate_requested/resolved` events still appear for ask path.
- New `permission_evaluated`, `approval_requested`, `approval_resolved` events appear.
- `tool_result` is not written for final submit when tool is not executed.
- `final_result` remains compatible.

## 13.5 Full verification

Implementation should run:

```bash
npm run build
npm run test:permission
npm run test:agent-loop
npm run test:kernel
npm run test:session
npm run test:mvp
git diff --check
```

For this planning-only task, only `git diff --check` is required after adding this document.

## 14. 多 Agent 并行实施拆分

## 14.1 Agent A: Permission contracts

负责文件：

```text
packages/web-buddy/src/permission/permission-types.ts
packages/web-buddy/src/permission/index.ts
```

任务：

- 定义 `PermissionRequest`。
- 定义 `PermissionDecision`。
- 定义 `ApprovalRequest` / `ApprovalResolution`。
- 导出类型。
- 不改 `runAgentLoop`。

验证：

```text
npm run build
```

## 14.2 Agent B: PermissionEngine and rules

负责文件：

```text
packages/web-buddy/src/permission/permission-engine.ts
packages/web-buddy/src/permission/permission-rules.ts
packages/web-buddy/scripts/permission-engine-test.mjs
packages/web-buddy/package.json
```

任务：

- 实现 default rules。
- 实现 `PermissionEngine.evaluate()`。
- 覆盖 allow/ask/deny 映射测试。
- 不调用 HumanGate。
- 不写 session。

验证：

```text
npm run test:permission
```

## 14.3 Agent C: ApprovalQueue

负责文件：

```text
packages/web-buddy/src/permission/approval-queue.ts
packages/web-buddy/scripts/approval-queue-test.mjs
packages/web-buddy/package.json
```

任务：

- 实现内存 queue。
- 实现 enqueue / resolve / cancel / snapshot / subscribe。
- 覆盖 queue lifecycle tests。
- 不做持久化。

验证：

```text
npm run test:approval-queue
```

## 14.4 Agent D: Session and events

负责文件：

```text
packages/web-buddy/src/session/session-types.ts
packages/web-buddy/src/kernel/kernel-events.ts
packages/web-buddy/scripts/session-store-test.mjs
packages/web-buddy/scripts/session-runtime-smoke-test.mjs
```

任务：

- additive 增加 transcript entry types。
- additive 增加 kernel event types。
- 更新 session tests。
- 不删除旧 event。

验证：

```text
npm run test:session
```

## 14.5 Agent E: runAgentLoop integration

负责文件：

```text
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/scripts/agent-loop-test.mjs
packages/web-buddy/scripts/agent-kernel-test.mjs
```

任务：

- 在 policy 后接 PermissionEngine。
- ask path 接 ApprovalQueue + HumanGate。
- preserve final submit manual takeover。
- preserve confirmed=true behavior。
- preserve ToolExecutionService boundary。
- preserve transcript compatibility。

不做：

- 不移动模型调用。
- 不移动 workflow transition。
- 不改 prompt。
- 不改 tool schema。

验证：

```text
npm run test:agent-loop
npm run test:kernel
```

## 14.6 Agent F: Compatibility sweep

负责文件：

```text
packages/web-buddy/package.json
README.md
packages/web-buddy/README.md
docs/agent-iteration-log.md
```

任务：

- 增加测试脚本说明。
- `test:mvp` 加入 permission tests。
- 运行完整回归。
- 文档记录 Plan 4 完成内容。

验证：

```text
npm run test:mvp
git diff --check
```

并行注意：

- Agent A 先落类型，Agent B/C 可基于类型并行。
- Agent D 可与 B/C 并行，因为只做 additive union/event type。
- Agent E 等 A/B/C/D 合并后再接 loop，避免同文件冲突。
- Agent F 最后做 package/docs 和完整验证。

## 15. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:permission` 通过。
3. `npm run test:approval-queue` 通过，或被包含在 `test:permission` 中。
4. `npm run test:agent-loop` 通过。
5. `npm run test:kernel` 通过。
6. `npm run test:session` 通过。
7. `npm run test:mvp` 通过。
8. `git diff --check` 通过。
9. `runAgentLoop` 可直接调用且参数兼容。
10. `AgentRuntime.run()` 返回 schema 不变。
11. `ToolExecutionService` 没有新增 permission 职责。
12. `HumanGate` 接口不变。
13. `PolicyEngine` 外部 shape 兼容。
14. final submit 进入 permission ask，并且不执行最终 submit tool。
15. `browser_upload_file` 进入 permission ask。
16. 高风险 click 进入 permission ask。
17. login/captcha handoff 能记录 permission/approval。
18. permission deny 不进入 HumanGate，也不执行工具。
19. approval decline/takeover 不执行工具。
20. approval approve 后，非 final submit 的高风险动作才可以进入工具执行。
21. session transcript 包含 `permission_decision`。
22. ask path session transcript 包含 `approval_request` 和 `approval_decision`。
23. events 包含 `permission_evaluated`、`approval_requested`、`approval_resolved`。
24. 旧的 `policy_decision` 和 `human_gate_*` 记录仍存在。
25. runtime/session/context/workflow 不读取 `output/traces`。

## 16. 风险和规避

| 风险 | 规避 |
|---|---|
| PermissionEngine 变成第二个 PolicyEngine | PolicyEngine 继续产出风险和 policyCode；PermissionEngine 只映射 allow/ask/deny |
| PermissionEngine 调用 HumanGate | 接口上不传 HumanGate，ask 只返回 decision |
| ApprovalQueue 被误做成持久状态库 | v1 明确内存队列，持久审计只写 session transcript/events |
| final submit approve 后被自动执行 | 验收测试要求 final submit 不执行工具 |
| ToolExecutionService 被污染 | `ToolUseContext` 不新增 `requestPermission()` |
| session reader 兼容性破坏 | 所有 transcript/event changes 只 additive |
| runAgentLoop 被重写 | 只在 policy 后插入 permission branch，不移动模型/tool/workflow 主结构 |
| 多 agent 同改 `agent-loop.ts` 冲突 | loop integration 作为最后一个任务 |
| login/captcha 范围膨胀 | v1 只记录 handoff approval，不做完整 resume flow |

## 17. 给实现 Agent 的提示词

```text
你正在实现 Phase 2D: PermissionEngine v1 + ApprovalQueue。

请先阅读：
- PLAN/phase2/README.md
- PLAN/phase2/plan2.md
- PLAN/phase2/plan2-completion-explanation.md
- PLAN/phase2/plan3.md
- PLAN/phase2/plan3-completion-explanation.md
- PLAN/phase2/plan4.md
- packages/web-buddy/src/runtime/local/agent-loop.ts
- packages/web-buddy/src/policy/policy-engine.ts
- packages/web-buddy/src/policy/agent-policy.ts
- packages/web-buddy/src/sdk/human.ts
- packages/web-buddy/src/tools/tool-execution-service.ts
- packages/web-buddy/src/session/session-types.ts

硬约束：
- 不重写 runAgentLoop。
- 不引入 WorkflowEngine。
- 不改变 prompt。
- 不改变 tool schema。
- 不改变 ToolExecutionService 的职责。
- PermissionEngine 只决定 allow / ask / deny，不执行工具。
- HumanGate 仍负责实际询问用户。
- ApprovalQueue v1 是内存队列。
- final submit 仍必须人工接管，不自动执行最终提交。

本阶段只做：
- permission types。
- PermissionEngine v1。
- ApprovalQueue v1。
- runAgentLoop 最小接入。
- session transcript/events additive 记录。
- 测试和文档。

完成后运行：
- npm run build
- npm run test:permission
- npm run test:agent-loop
- npm run test:kernel
- npm run test:session
- npm run test:mvp
- git diff --check
```

## 18. 完成后进入下一计划的条件

只有当 Phase 2D 满足以下条件，才进入 Plan 5:

- permission decision 已经成为 policy 后的统一入口。
- final submit、upload、高风险 click、login/captcha 都有 permission audit。
- ApprovalQueue 可以表达 pending/resolved。
- session transcript 能解释每一次 ask/deny/allow。
- ToolExecutionService 仍然纯执行。
- HumanGate 仍然纯询问。
- `runAgentLoop` 没有被重写。

Plan 5 才开始考虑：

- Context Compaction。
- persistent approval resume。
- UI Task Cockpit approval 操作。
- WorkflowEngine / Evidence。
- permission config / session remembered rules。
